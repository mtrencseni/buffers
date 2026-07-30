# Buffers server

A read-only window onto other machines' buffers. Every Buffers client pushes
its own open buffers under its own hostname; any client can read what the
others pushed. Nothing merges, nothing syncs, nothing writes back — if you want
to keep working on a buffer from another machine, you copy it locally yourself.

Runs at `https://buffers.trencseni.com`, proxied to `127.0.0.1:8060`.

## API

Auth is one shared secret in `BUFFERS_TOKEN`, sent as an `X-Buffers-Token`
header on both API endpoints. `/ping` is deliberately open.

| Method | Path | Does |
| --- | --- | --- |
| `PUT` | `/api/v1/<user>/<host>` | Store this host's buffers (body = payload below). |
| `GET` | `/api/v1/<user>` | Every host, with all their buffers, newest host first. |
| `GET` | `/ping` | Liveness. No auth, says nothing else. |

The push payload, which is also what comes back per host:

```json
{ "buffers": [ { "name": "Release email — draft", "language": "markdown", "text": "…" } ] }
```

`name` is the buffer's resolved display title (its pinned name, else its first
line), so nothing downstream has to reimplement that rule. Cursor position,
scroll, buffer ids, the closed-buffer stack and local file paths are all
stripped client-side and never leave the machine.

A push is capped at 1 MB and replaces that host's previous state wholesale.

## Storage

The filesystem, one file per host:

```
data/<user>/<host>.json              # current state
data/<user>/<host>.history/<date>.json   # last 20 daily snapshots
```

Writes are atomic (write-tmp-then-rename). The history exists for one specific
failure: a reinstalled client with no `.buffers.json` will happily push an empty
session and wipe the remote view of that machine. Snapshots are keyed by the
*outgoing* state's date, so today's entry is rewritten as the day goes on while
previous days stay frozen — a clobber noticed tomorrow is still recoverable.

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
```
