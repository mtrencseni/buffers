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
    DELETE  /api/v1/<user>/<host>   forget a machine entirely (retired hardware)
    POST    /api/v1/<user>/cloud    add or overwrite ONE Cloud buffer, by name
    DELETE  /api/v1/<user>/cloud    remove ONE Cloud buffer, by name
    GET     /api/v1/<user>          every host and the Cloud, with all buffers
    GET     /api/whoami             who the session belongs to (the web UI asks)
    GET     /ping                   liveness, no auth

Note the two DELETEs: on a machine it forgets the whole host, on the Cloud it
removes one named buffer. That asymmetry is deliberate -- a machine mirror is
disposable (its client rebuilds it on the next push) while the Cloud is the
curated copy, so there is no one-shot way to wipe it.

This server also SERVES the Buffers web UI, when server/web/ holds a build of it
(pnpm build:web; see build-web.sh). That is what makes the web client possible at
all: a browser page can only fetch() the API without CORS if the API is its own
origin, which it is because the same Flask app handed it the page. The desktop
clients are unaffected -- they still speak to /api/v1 from Rust.

Two ways in, then, and authorized() takes either:

  * X-Buffers-Token, for the desktop clients. A secret in a config file.
  * A signed session cookie, for browsers, set by /login when you paste that same
    token once. HttpOnly, so the page's own JavaScript cannot read it back --
    which is the point: a browser never holds the token, only the session.

The cookie is signed with a key DERIVED from BUFFERS_TOKEN, so rotating the token
invalidates every browser session for free.

The payload a client pushes, and what comes back per host:

    {"buffers": [{"name": "...", "language": "markdown", "text": "..."}]}

Storage is the filesystem -- data/<user>/<host>.json, written atomically. No
database: this is text notes for one person, and being able to `cat` the file
on the server is worth more than any query the alternative would buy. Buffer
NAMES are only ever dict keys inside those files, never path components, so a
title containing "/" or unicode needs no escaping anywhere.

Auth is a single shared secret in BUFFERS_TOKEN. Not user accounts -- just enough
that a public URL isn't a public notepad.

Env: BUFFERS_TOKEN (required), BUFFERS_DATA_DIR (default ./data), PORT (8060),
BUFFERS_USER (default mtrencseni -- who the web UI signs in as),
BUFFERS_INSECURE_COOKIE (set it to test the web UI over plain http on localhost;
never in production, it drops the Secure flag from the session cookie).
"""

import hashlib
import hmac
import html
import json
import os
import re
import shutil
import threading
import time
from datetime import datetime, timedelta, timezone

from flask import (
    Flask,
    abort,
    jsonify,
    redirect,
    request,
    send_from_directory,
    session,
)

# A <user> or <host> becomes a path component, so it goes through an allowlist
# rather than an escape: must start alphanumeric, then word chars / . / - / _.
# ".." can't match (it fails the first character), and no separator is allowed.
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")

MAX_BYTES = 1024 * 1024          # 1 MB per request; notes, not attachments
CLOUD_MAX_BYTES = 8 * 1024 * 1024  # the Cloud only grows, so give it a ceiling
HISTORY_DAYS = 20                # daily snapshots kept per host (see rotate())
TRASH_KEEP = 20                  # deleted hosts recoverable from .trash (see trash())

# The Cloud is a host name like any other on read, so clients need no special
# case to display it. Machines may not push to it: a laptop that happened to be
# named "cloud" would otherwise wipe the store on its first wholesale push.
CLOUD_HOST = "Cloud"

DATA_DIR = os.environ.get(
    "BUFFERS_DATA_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
)
TOKEN = os.environ.get("BUFFERS_TOKEN", "")

# The single account the web UI signs in as. There is one user here (see the
# module docstring); this exists so the name isn't spelled into the frontend.
WEB_USER = os.environ.get("BUFFERS_USER", "mtrencseni")

# A build of the web UI, if one has been put here (build-web.sh). Absent is a
# supported state: the server then behaves exactly as it did before it could
# serve a UI at all.
WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")

# Everything under these prefixes is part of that build and served as-is. An
# allowlist rather than a blanket static mount: with a blanket one, every path
# that isn't an API route becomes a file probe against the server's directory.
WEB_PREFIXES = ("assets/", "fonts/", "icons/")
WEB_FILES = frozenset(
    {"manifest.webmanifest", "favicon.png", "apple-touch-icon.png", "index.html"}
)

# Cloud writes are read-modify-write on one file, so they are serialized. Machine
# pushes need no lock: each replaces its own file in a single atomic rename.
cloud_lock = threading.Lock()

# static_folder=None: the routes below decide what is servable, not Flask's
# catch-all static rule (which would also shadow nothing but is one more way in).
app = Flask(__name__, static_folder=None)
# Flask rejects an oversized body itself (413) before we ever read it.
app.config["MAX_CONTENT_LENGTH"] = MAX_BYTES
app.config.update(
    # Derived from the token, so rotating BUFFERS_TOKEN invalidates every browser
    # session without a second secret to manage or a store to clear.
    SECRET_KEY=hashlib.sha256(("buffers-session:" + TOKEN).encode()).digest(),
    SESSION_COOKIE_HTTPONLY=True,
    # Lax is also the CSRF story: a cross-site POST/PUT/DELETE carries no cookie,
    # so the mutating endpoints can't be driven from another origin.
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=not os.environ.get("BUFFERS_INSECURE_COOKIE"),
    # Long-lived on purpose: re-typing a 64-character token on a phone is exactly
    # the friction that makes people pick a shorter secret.
    PERMANENT_SESSION_LIFETIME=timedelta(days=365),
)


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


def trash(user: str, host: str, path: str) -> None:
    """Move a host's current state aside instead of unlinking it.

    Deleting a host also deletes its daily history, so the operation would
    otherwise be the one thing here with no way back. The tombstone is a plain
    file under data/<user>/.trash/ -- not exposed by the API, just something to
    `mv` back when someone deletes the wrong machine. Newest TRASH_KEEP survive.
    """
    if not os.path.exists(path):
        return
    tdir = os.path.join(DATA_DIR, user, ".trash")
    os.makedirs(tdir, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    os.replace(path, os.path.join(tdir, f"{host}-{stamp}.json"))
    try:
        kept = sorted(
            (os.path.join(tdir, f) for f in os.listdir(tdir) if f.endswith(".json")),
            key=os.path.getmtime,
        )
        for stale in kept[:-TRASH_KEEP]:
            os.remove(stale)
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
    """Either credential is enough: the shared token in a header (desktop
    clients) or a signed session cookie (a browser that pasted it at /login)."""
    if not TOKEN:
        return False
    sent = request.headers.get("X-Buffers-Token", "")
    if sent and hmac.compare_digest(sent, TOKEN):
        return True
    return session.get("auth") is True


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


# ---- the web UI ------------------------------------------------------------------
#
# Serving the bundle from here is not a convenience, it is the mechanism: the
# page and the API share an origin, so the frontend can fetch() the API with no
# CORS and no configured URL, and the browser will attach the session cookie.

def web_built() -> bool:
    return os.path.isfile(os.path.join(WEB_DIR, "index.html"))


def send_web(filename: str, cache: str):
    resp = send_from_directory(WEB_DIR, filename)
    resp.headers["Cache-Control"] = cache
    return resp


LOGIN_PAGE = """<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>Buffers</title>
<style>
  :root {{ --bg:#eceef2; --panel:#fff; --text:#1b1f27; --dim:#69707d;
           --border:#dcdfe6; --accent:#4f7cf7; --err:#b3261e; }}
  @media (prefers-color-scheme: dark) {{
    :root {{ --bg:#262e38; --panel:#303841; --text:#d8dee9; --dim:#a6acb8;
             --border:#414c59; --accent:#6699cc; --err:#ff8f88; }}
  }}
  * {{ box-sizing: border-box; }}
  body {{ margin:0; min-height:100dvh; display:grid; place-items:center;
          background:var(--bg); color:var(--text); padding:1.5rem;
          font:15px/1.5 -apple-system, "Segoe UI", system-ui, sans-serif; }}
  form {{ width:100%; max-width:22rem; background:var(--panel); padding:1.5rem;
          border:1px solid var(--border); border-radius:.75rem; }}
  h1 {{ margin:0 0 .25rem; font-size:1.375rem; }}
  p {{ margin:0 0 1.25rem; color:var(--dim); font-size:.875rem; }}
  input {{ width:100%; padding:.625rem .75rem; font-size:1rem; color:inherit;
           background:var(--bg); border:1px solid var(--border);
           border-radius:.5rem; }}
  input:focus {{ outline:2px solid var(--accent); outline-offset:1px; }}
  button {{ width:100%; margin-top:.75rem; padding:.625rem; font-size:1rem;
            font-weight:600; color:#fff; background:var(--accent);
            border:0; border-radius:.5rem; cursor:pointer; }}
  .err {{ margin:0 0 .75rem; color:var(--err); font-size:.875rem; }}
</style>
</head><body>
<form method="post" action="/login">
  <h1>Buffers</h1>
  <p>Paste the server token to use this browser as a client.</p>
  {error}
  <input type="password" name="token" autocomplete="current-password"
         autofocus placeholder="Token" aria-label="Token">
  <input type="hidden" name="next" value="{next}">
  <button type="submit">Sign in</button>
</form>
</body></html>
"""


def login_page(error: str = "", status: int = 200):
    body = LOGIN_PAGE.format(
        error=f'<p class="err">{html.escape(error)}</p>' if error else "",
        next=html.escape(safe_next(), quote=True),
    )
    return body, status, {"Content-Type": "text/html; charset=utf-8"}


def safe_next() -> str:
    """Where to go after signing in. Same-site absolute paths only -- note that
    "//evil.com" is a protocol-relative URL, not a path."""
    nxt = request.values.get("next", "/")
    return nxt if nxt.startswith("/") and not nxt.startswith("//") else "/"


@app.get("/")
def index():
    if not web_built():
        return "Buffers server.\n", 200, {"Content-Type": "text/plain; charset=utf-8"}
    if not session.get("auth"):
        return redirect("/login")
    # Never cached: the asset names inside it are content-hashed, so this one
    # file is what makes a deploy visible.
    return send_web("index.html", "no-cache")


@app.get("/login")
def login_form():
    if not web_built():
        abort(404)
    if session.get("auth"):
        return redirect(safe_next())
    return login_page()


@app.post("/login")
def login_submit():
    if not web_built():
        abort(404)
    # The token is 32 random bytes, so this is not a rate limiter -- it just
    # makes an automated guessing loop pointless to even start.
    time.sleep(0.4)
    sent = (request.form.get("token") or "").strip()
    if not (TOKEN and sent and hmac.compare_digest(sent, TOKEN)):
        return login_page("That token doesn't match.", 401)
    session.permanent = True
    session["auth"] = True
    return redirect(safe_next())


@app.post("/logout")
def logout():
    session.clear()
    return redirect("/login")


@app.get("/api/whoami")
def whoami():
    """Who the caller is signed in as. The web UI asks once at boot: a 401 here
    is what sends it to /login, and it is deliberately the ONLY thing that does
    -- being offline must never bounce a browser away from a live session."""
    if not authorized():
        return jsonify(error="unauthorized"), 401
    return jsonify(user=WEB_USER, cloud=CLOUD_HOST)


@app.get("/<path:filename>")
def web_asset(filename: str):
    """The web build's static files. Unauthenticated on purpose: this is the
    application, not the data -- and the login page has to load for someone who
    has no session yet."""
    if not web_built():
        abort(404)
    if not (filename.startswith(WEB_PREFIXES) or filename in WEB_FILES):
        abort(404)
    # Vite content-hashes everything under assets/, so those may be cached hard;
    # the rest is named by hand and must not be.
    cache = "public, max-age=31536000, immutable" if filename.startswith("assets/") else "no-cache"
    return send_web(filename, cache)


@app.after_request
def security_headers(resp):
    # Only the pages, not the JSON API (which no browser renders).
    if resp.mimetype == "text/html":
        resp.headers.setdefault(
            "Content-Security-Policy",
            # 'unsafe-inline' for styles is unavoidable: CodeMirror injects its
            # theme as inline style elements at runtime. Scripts stay strict.
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; font-src 'self'; connect-src 'self'; "
            "frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        )
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("Referrer-Policy", "same-origin")
    return resp


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


@app.delete("/api/v1/<user>/<host>")
def host_delete(user: str, host: str):
    """Forget a machine entirely: its buffers and its history both.

    For retired hardware and stale hostnames. Deleting a machine that is still
    running only clears it until its next push, seconds later -- that is
    expected, not a bug.

    Werkzeug matches the static /cloud rule ahead of this dynamic one, so
    DELETE .../cloud still means "remove one Cloud buffer". That only holds for
    the exact lowercase spelling though, so the reserved-name guard below is
    what actually stops DELETE .../Cloud from wiping the curated store.
    """
    if not authorized():
        return jsonify(error="unauthorized"), 401
    if not NAME_RE.match(user) or not NAME_RE.match(host):
        return jsonify(error="bad user or host name"), 400
    if host.lower() == CLOUD_HOST.lower():
        return jsonify(error=f"{CLOUD_HOST} is a store, not a machine; "
                             f"delete its buffers one at a time"), 409

    path = host_path(user, host)
    hdir = os.path.join(DATA_DIR, user, host + ".history")
    if not os.path.exists(path) and not os.path.isdir(hdir):
        return jsonify(error=f"no host named {host!r}"), 404

    trash(user, host, path)          # recoverable by hand; see trash()
    shutil.rmtree(hdir, ignore_errors=True)
    return jsonify(ok=True, host=host)


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
