# Buffers server

A read-only window onto other machines' buffers, plus a Cloud. Nothing merges,
nothing syncs, nothing writes back — if you want to keep working on a buffer
from elsewhere, you copy it locally yourself.

Two kinds of host live side by side, and a read returns both the same way:

- **A machine mirrors itself.** Every Buffers client pushes its whole set of
  open buffers under its own hostname, replacing whatever it pushed before.
  Close a buffer and it disappears from the mirror on the next push.
- **`Cloud` is a curated store, not a machine.** Buffers are pushed to it one at
  a time, on purpose, keyed by name — same name overwrites — and deleted one at
  a time. Nothing here expires when you close a local buffer.

Runs at `https://buffers.trencseni.com`, proxied to `127.0.0.1:8060`.

## API

Auth is one shared secret in `BUFFERS_TOKEN`, sent as an `X-Buffers-Token`
header on every API endpoint. `/ping` is deliberately open.

| Method | Path | Does |
| --- | --- | --- |
| `PUT` | `/api/v1/<user>/<host>` | Replace this machine's buffers wholesale (body = payload below). |
| `DELETE` | `/api/v1/<user>/<host>` | Forget a machine entirely — its buffers and its history. |
| `POST` | `/api/v1/<user>/cloud` | Add or overwrite **one** Cloud buffer. Body `{name, language, text}`. |
| `DELETE` | `/api/v1/<user>/cloud` | Remove **one** Cloud buffer. Name from `{"name": …}` or `?name=`. |
| `GET` | `/api/v1/<user>` | Every host and the Cloud, with all their buffers, newest first. |
| `GET` | `/ping` | Liveness. No auth, says nothing else. |

Each host in a read carries `kind`, either `"cloud"` or `"host"`, so a client
can tell the curated store from a machine mirror without matching on its name.
Cloud buffers additionally carry `pushed_at`.

A machine may **not** wholesale-push to `Cloud` — that returns `409`. Otherwise a
laptop that happened to be named `cloud` would wipe the store on its first push.
Nor may it be deleted as a host (also `409`): a mirror is disposable because its
client rebuilds it, while the Cloud is the curated copy, so there is deliberately
no one-shot way to wipe it — delete its buffers one at a time.

Deleting a machine that is still running only clears it until that machine's next
push, seconds later. The operation is for retired hardware and stale hostnames.
Deleted hosts leave a tombstone in `data/<user>/.trash/<host>-<stamp>.json` (the
newest 20 survive), which is not exposed by the API — it's there so a wrongly
deleted machine can be `mv`'d back by hand.

Buffer names are only ever dict keys inside the stored JSON, never path
components, so a title containing `/` or unicode needs no escaping. Host names
do become filenames and must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`.

The push payload, which is also what comes back per host:

```json
{ "buffers": [ { "name": "Release email — draft", "language": "markdown", "text": "…" } ] }
```

`name` is the buffer's resolved display title (its pinned name, else its first
line), so nothing downstream has to reimplement that rule. Cursor position,
scroll, buffer ids, the closed-buffer stack and local file paths are all
stripped client-side and never leave the machine.

A request body is capped at 1 MB. A machine push replaces that host's previous
state wholesale; the Cloud only ever grows by one buffer at a time and is capped
at 8 MB total, since nothing prunes it but you.

## Storage

The filesystem, one file per host:

```
data/<user>/<host>.json                  # current state
data/<user>/<host>.history/<date>.json   # last 20 daily snapshots
data/<user>/.trash/<host>-<stamp>.json   # last 20 deleted hosts
```

Writes are atomic (write-tmp-then-rename). The history exists for one specific
failure: a reinstalled client with no `.buffers.json` will happily push an empty
session and wipe the remote view of that machine. Snapshots are keyed by the
*outgoing* state's date, so today's entry is rewritten as the day goes on while
previous days stay frozen — a clobber noticed tomorrow is still recoverable. An
empty outgoing snapshot is never rotated, or a machine pushing nothing every few
seconds would overwrite the good entry moments after the clobber it protects
against. The Cloud gets the same treatment, where it covers a mis-clicked delete.

## Running it

```sh
cd server
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
printf 'BUFFERS_TOKEN=%s\n' "$(openssl rand -hex 32)" > .env   # once
chmod 600 .env
screen -S buffers ./run.sh
```

`run.sh` sources `.env`, then supervises `app.py` and restarts it on a crash.
The app refuses to start without a token rather than coming up open.

To expose it (once, as root — the box has wildcard DNS, so there's no
registrar step):

```sh
sudo /home/mtrencseni/scripts/route-domain buffers.trencseni.com 8060
```

That appends the nginx server block, reissues the TLS cert (deriving the domain
list from nginx), and verifies the live cert covers the new name.

## Checking it

```sh
curl -s https://buffers.trencseni.com/ping

curl -s -X PUT https://buffers.trencseni.com/api/v1/mtrencseni/laptop \
  -H "X-Buffers-Token: $BUFFERS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"buffers":[{"name":"note","language":"plain","text":"hello"}]}'

curl -s https://buffers.trencseni.com/api/v1/mtrencseni \
  -H "X-Buffers-Token: $BUFFERS_TOKEN"

# Cloud: push one buffer, then delete it again
curl -s -X POST https://buffers.trencseni.com/api/v1/mtrencseni/cloud \
  -H "X-Buffers-Token: $BUFFERS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"meeting notes","language":"markdown","text":"# Q3\n…"}'

curl -s -X DELETE https://buffers.trencseni.com/api/v1/mtrencseni/cloud \
  -H "X-Buffers-Token: $BUFFERS_TOKEN" -G --data-urlencode "name=meeting notes"
```
