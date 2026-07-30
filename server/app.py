"""
Buffers server -- a read-only window onto other machines' buffers.

The model is deliberately one-way: every Buffers client PUSHES its own open
buffers under its own hostname, and can READ what every other machine pushed.
Nothing merges, nothing syncs, nothing writes back. A host only ever overwrites
its own key, so there is no conflict to resolve -- and because each push is a
complete snapshot, a push that fails (offline, server down) needs no retry: the
next one carries the whole state anyway.

    PUT  /api/v1/<user>/<host>   store this host's buffers (body = the payload)
    GET  /api/v1/<user>          every host, with all their buffers
    GET  /ping                   liveness, no auth

The payload a client pushes, and what comes back per host:

    {"buffers": [{"name": "...", "language": "markdown", "text": "..."}]}

Storage is the filesystem -- data/<user>/<host>.json, written atomically. No
database: this is text notes for one person, and being able to `cat` the file
on the server is worth more than any query the alternative would buy.

Auth is a single shared secret in BUFFERS_TOKEN, sent as X-Buffers-Token. Not
user accounts -- just enough that a public URL isn't a public notepad.

Env: BUFFERS_TOKEN (required), BUFFERS_DATA_DIR (default ./data), PORT (8060).
"""

import hmac
import json
import os
import re
import time
from datetime import datetime, timezone

from flask import Flask, jsonify, request

# A <user> or <host> becomes a path component, so it goes through an allowlist
# rather than an escape: must start alphanumeric, then word chars / . / - / _.
# ".." can't match (it fails the first character), and no separator is allowed.
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")

MAX_BYTES = 1024 * 1024   # 1 MB per push; notes, not attachments
HISTORY_DAYS = 20         # daily snapshots kept per host (see rotate())

DATA_DIR = os.environ.get(
    "BUFFERS_DATA_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
)
TOKEN = os.environ.get("BUFFERS_TOKEN", "")

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
    """Keep a daily snapshot of what this host had BEFORE the incoming push.

    Why: a client that gets reinstalled (or loses its .buffers.json) will happily
    push an empty session and silently wipe the remote view of that machine. One
    file per calendar day, keyed by the outgoing snapshot's own date, means
    today's entry is rewritten as the day goes on while previous days stay
    frozen -- so a clobber noticed tomorrow is still recoverable.

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


# ---- request plumbing ---------------------------------------------------------

def authorized() -> bool:
    sent = request.headers.get("X-Buffers-Token", "")
    return bool(TOKEN) and hmac.compare_digest(sent, TOKEN)


def clean_payload(body) -> dict:
    """Keep only the shape we serve, so a malformed or hostile push can't put
    arbitrary structure into the store. Unknown keys are dropped; text is capped
    only by the request size limit."""
    if not isinstance(body, dict):
        raise ValueError("body must be a JSON object")
    raw = body.get("buffers")
    if not isinstance(raw, list):
        raise ValueError("body.buffers must be a list")
    out = []
    for item in raw:
        if not isinstance(item, dict) or not isinstance(item.get("text"), str):
            continue
        name = item.get("name")
        lang = item.get("language")
        out.append({
            "name": name if isinstance(name, str) else "",
            "language": lang if isinstance(lang, str) else "plain",
            "text": item["text"],
        })
    return {"buffers": out}


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
    if not authorized():
        return jsonify(error="unauthorized"), 401
    if not NAME_RE.match(user) or not NAME_RE.match(host):
        return jsonify(error="bad user or host name"), 400
    try:
        payload = clean_payload(request.get_json(silent=True))
    except ValueError as e:
        return jsonify(error=str(e)), 400

    path = host_path(user, host)
    rotate(user, host, read_json(path))
    now = time.time()
    write_json(path, {
        "host": host,
        "received_at": now,
        "received_iso": datetime.fromtimestamp(now, timezone.utc).isoformat(),
        "buffers": payload["buffers"],
    })
    return jsonify(ok=True, host=host, received_at=now, buffers=len(payload["buffers"]))


@app.get("/api/v1/<user>")
def read_all(user: str):
    """Everything this user's machines have pushed, newest host first. One call
    is all the client needs -- these are notes, so the whole set is small."""
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
            hosts.append(doc)
    hosts.sort(key=lambda h: h.get("received_at", 0), reverse=True)
    return jsonify(user=user, hosts=hosts)


if __name__ == "__main__":
    if not TOKEN:
        raise SystemExit("BUFFERS_TOKEN is not set -- refusing to start unauthenticated.")
    os.makedirs(DATA_DIR, exist_ok=True)
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", "8060")),
            debug=False, threaded=True)
