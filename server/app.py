"""
Buffers server -- a read-only window onto other machines' buffers, plus a Cloud.

Two kinds of host live side by side, and a GET returns both the same way:

  * A MACHINE mirrors itself. Every Buffers client pushes its whole set of open
    buffers under its own hostname, replacing whatever it pushed before. Nothing
    merges, nothing syncs, nothing writes back. A host only ever overwrites its
    own key, so there is no conflict to resolve -- and because each push is a
    complete snapshot, a push that fails (offline, server down) needs no retry:
    the next one carries the whole state anyway.

  * "Cloud" is a curated store, not a machine. Buffers are pushed to it ONE AT A
    TIME, on purpose, keyed by name -- same name overwrites -- and deleted one at
    a time. Nothing here is ever edited in place or synced back down; the client
    copies a Cloud buffer locally if it wants to keep working on it.

    PUT     /api/v1/<user>/<host>   replace this machine's buffers wholesale
    POST    /api/v1/<user>/cloud    add or overwrite ONE Cloud buffer, by name
    DELETE  /api/v1/<user>/cloud    remove ONE Cloud buffer, by name
    GET     /api/v1/<user>          every host and the Cloud, with all buffers
    GET     /ping                   liveness, no auth

The payload a client pushes, and what comes back per host:

    {"buffers": [{"name": "...", "language": "markdown", "text": "..."}]}

Storage is the filesystem -- data/<user>/<host>.json, written atomically. No
database: this is text notes for one person, and being able to `cat` the file
on the server is worth more than any query the alternative would buy. Buffer
NAMES are only ever dict keys inside those files, never path components, so a
title containing "/" or unicode needs no escaping anywhere.

Auth is a single shared secret in BUFFERS_TOKEN, sent as X-Buffers-Token. Not
user accounts -- just enough that a public URL isn't a public notepad.

Env: BUFFERS_TOKEN (required), BUFFERS_DATA_DIR (default ./data), PORT (8060).
"""

import hmac
import json
import os
import re
import threading
import time
from datetime import datetime, timezone

from flask import Flask, jsonify, request

# A <user> or <host> becomes a path component, so it goes through an allowlist
# rather than an escape: must start alphanumeric, then word chars / . / - / _.
# ".." can't match (it fails the first character), and no separator is allowed.
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")

MAX_BYTES = 1024 * 1024          # 1 MB per request; notes, not attachments
CLOUD_MAX_BYTES = 8 * 1024 * 1024  # the Cloud only grows, so give it a ceiling
HISTORY_DAYS = 20                # daily snapshots kept per host (see rotate())

# The Cloud is a host name like any other on read, so clients need no special
# case to display it. Machines may not push to it: a laptop that happened to be
# named "cloud" would otherwise wipe the store on its first wholesale push.
CLOUD_HOST = "Cloud"

DATA_DIR = os.environ.get(
    "BUFFERS_DATA_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
)
TOKEN = os.environ.get("BUFFERS_TOKEN", "")

# Cloud writes are read-modify-write on one file, so they are serialized. Machine
# pushes need no lock: each replaces its own file in a single atomic rename.
cloud_lock = threading.Lock()

app = Flask(__name__)
# Flask rejects an oversized body itself (413) before we ever read it.
app.config["MAX_CONTENT_LENGTH"] = MAX_BYTES


# ---- storage -----------------------------------------------------------------

def host_path(user: str, host: str) -> str:
    return os.path.join(DATA_DIR, user, host + ".json")


def read_json(path: str):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def write_json(path: str, value) -> None:
    """Atomic write: a crash mid-write can never leave a half-file behind."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(value, fh, ensure_ascii=False)
    os.replace(tmp, path)


def rotate(user: str, host: str, current) -> None:
    """Keep a daily snapshot of what this host had BEFORE the incoming write.

    Why: a client that gets reinstalled (or loses its .buffers.json) will happily
    push an empty session and silently wipe the remote view of that machine. One
    file per calendar day, keyed by the outgoing snapshot's own date, means
    today's entry is rewritten as the day goes on while previous days stay
    frozen -- so a clobber noticed tomorrow is still recoverable. The Cloud gets
    the same treatment, where it covers a mis-clicked delete instead.

    An EMPTY outgoing snapshot is never rotated. Clients push every few seconds,
    so a machine that has started pushing nothing would otherwise overwrite the
    good history entry with an empty one within seconds of the very clobber the
    history exists to survive.
    """
    if not current or not current.get("buffers"):
        return
    stamp = current.get("received_at", time.time())
    day = datetime.fromtimestamp(stamp, timezone.utc).strftime("%Y-%m-%d")
    hdir = os.path.join(DATA_DIR, user, host + ".history")
    write_json(os.path.join(hdir, day + ".json"), current)
    try:
        days = sorted(f for f in os.listdir(hdir) if f.endswith(".json"))
        for stale in days[:-HISTORY_DAYS]:      # names sort chronologically
            os.remove(os.path.join(hdir, stale))
    except OSError:
        pass


def envelope(host: str, buffers: list) -> dict:
    now = time.time()
    return {
        "host": host,
        "received_at": now,
        "received_iso": datetime.fromtimestamp(now, timezone.utc).isoformat(),
        "buffers": buffers,
    }


# ---- request plumbing ---------------------------------------------------------

def authorized() -> bool:
    sent = request.headers.get("X-Buffers-Token", "")
    return bool(TOKEN) and hmac.compare_digest(sent, TOKEN)


def clean_buffer(item) -> dict:
    """One buffer, reduced to the only three fields we serve. Returns None for
    anything malformed so callers can skip or reject as suits them."""
    if not isinstance(item, dict) or not isinstance(item.get("text"), str):
        return None
    name = item.get("name")
    lang = item.get("language")
    return {
        "name": name.strip() if isinstance(name, str) else "",
        "language": lang if isinstance(lang, str) else "plain",
        "text": item["text"],
    }


def clean_payload(body) -> dict:
    """Keep only the shape we serve, so a malformed or hostile push can't put
    arbitrary structure into the store. Unknown keys are dropped; text is capped
    only by the request size limit."""
    if not isinstance(body, dict):
        raise ValueError("body must be a JSON object")
    raw = body.get("buffers")
    if not isinstance(raw, list):
        raise ValueError("body.buffers must be a list")
    return {"buffers": [b for b in (clean_buffer(i) for i in raw) if b]}


def load_cloud(user: str):
    """(document, buffers) for the Cloud store; both empty when it doesn't exist."""
    doc = read_json(host_path(user, CLOUD_HOST))
    if not isinstance(doc, dict):
        return None, []
    buffers = doc.get("buffers")
    return doc, buffers if isinstance(buffers, list) else []


@app.errorhandler(413)
def too_large(_e):
    return jsonify(error=f"payload over {MAX_BYTES} bytes"), 413


# ---- endpoints ------------------------------------------------------------------

@app.get("/ping")
def ping():
    """Liveness only -- deliberately unauthenticated and says nothing else."""
    return jsonify(ok=True)


@app.get("/")
def index():
    return "Buffers server.\n", 200, {"Content-Type": "text/plain; charset=utf-8"}


@app.put("/api/v1/<user>/<host>")
def push(user: str, host: str):
    """A machine replacing its own set of open buffers, wholesale."""
    if not authorized():
        return jsonify(error="unauthorized"), 401
    if not NAME_RE.match(user) or not NAME_RE.match(host):
        return jsonify(error="bad user or host name"), 400
    if host.lower() == CLOUD_HOST.lower():
        return jsonify(error=f"'{CLOUD_HOST}' is reserved; "
                             f"use POST /api/v1/{user}/cloud"), 409
    try:
        payload = clean_payload(request.get_json(silent=True))
    except ValueError as e:
        return jsonify(error=str(e)), 400

    path = host_path(user, host)
    rotate(user, host, read_json(path))
    doc = envelope(host, payload["buffers"])
    write_json(path, doc)
    return jsonify(ok=True, host=host, received_at=doc["received_at"],
                   buffers=len(payload["buffers"]))


@app.post("/api/v1/<user>/cloud")
def cloud_push(user: str):
    """Add or overwrite ONE Cloud buffer, keyed by name. Body: {name, language, text}."""
    if not authorized():
        return jsonify(error="unauthorized"), 401
    if not NAME_RE.match(user):
        return jsonify(error="bad user name"), 400
    buf = clean_buffer(request.get_json(silent=True))
    if buf is None:
        return jsonify(error="body must be {name, language, text}"), 400
    if not buf["name"]:
        return jsonify(error="a Cloud buffer needs a name"), 400

    with cloud_lock:
        doc, buffers = load_cloud(user)
        buf["pushed_at"] = time.time()
        # Replace in place when the name already exists, so the list order the
        # user sees doesn't reshuffle every time they re-push the same buffer.
        replaced = False
        out = []
        for existing in buffers:
            if isinstance(existing, dict) and existing.get("name") == buf["name"]:
                if not replaced:
                    out.append(buf)
                    replaced = True
                continue
            out.append(existing)
        if not replaced:
            out.append(buf)

        size = len(json.dumps(out, ensure_ascii=False).encode("utf-8"))
        if size > CLOUD_MAX_BYTES:
            return jsonify(error=f"Cloud would exceed {CLOUD_MAX_BYTES} bytes; "
                                 f"delete something first"), 413

        rotate(user, CLOUD_HOST, doc)
        write_json(host_path(user, CLOUD_HOST), envelope(CLOUD_HOST, out))
    return jsonify(ok=True, name=buf["name"], replaced=replaced, buffers=len(out))


@app.delete("/api/v1/<user>/cloud")
def cloud_delete(user: str):
    """Remove ONE Cloud buffer. Name comes from {"name": ...} or ?name=."""
    if not authorized():
        return jsonify(error="unauthorized"), 401
    if not NAME_RE.match(user):
        return jsonify(error="bad user name"), 400
    body = request.get_json(silent=True)
    name = body.get("name") if isinstance(body, dict) else None
    if not isinstance(name, str) or not name.strip():
        name = request.args.get("name", "")
    name = name.strip()
    if not name:
        return jsonify(error="which buffer? pass {\"name\": ...} or ?name="), 400

    with cloud_lock:
        doc, buffers = load_cloud(user)
        out = [b for b in buffers
               if not (isinstance(b, dict) and b.get("name") == name)]
        if len(out) == len(buffers):
            return jsonify(error=f"no Cloud buffer named {name!r}"), 404
        rotate(user, CLOUD_HOST, doc)
        write_json(host_path(user, CLOUD_HOST), envelope(CLOUD_HOST, out))
    return jsonify(ok=True, name=name, buffers=len(out))


@app.get("/api/v1/<user>")
def read_all(user: str):
    """Everything this user's machines and Cloud hold, newest first. One call is
    all the client needs -- these are notes, so the whole set is small. Each host
    carries a `kind` so the client can tell the curated Cloud from a machine
    mirror without string-matching its name."""
    if not authorized():
        return jsonify(error="unauthorized"), 401
    if not NAME_RE.match(user):
        return jsonify(error="bad user name"), 400

    hosts = []
    udir = os.path.join(DATA_DIR, user)
    for fname in sorted(os.listdir(udir)) if os.path.isdir(udir) else []:
        if not fname.endswith(".json"):
            continue
        doc = read_json(os.path.join(udir, fname))
        if isinstance(doc, dict):
            doc["kind"] = "cloud" if fname[:-5] == CLOUD_HOST else "host"
            hosts.append(doc)
    hosts.sort(key=lambda h: h.get("received_at", 0), reverse=True)
    return jsonify(user=user, hosts=hosts)


if __name__ == "__main__":
    if not TOKEN:
        raise SystemExit("BUFFERS_TOKEN is not set -- refusing to start unauthenticated.")
    os.makedirs(DATA_DIR, exist_ok=True)
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", "8060")),
            debug=False, threaded=True)
