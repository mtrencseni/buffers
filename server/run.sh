#!/usr/bin/env bash
# Supervisor for the Buffers server. Launch THIS rather than `python app.py`
# so a crash doesn't take the service down for good:
#
#   screen -S buffers ./run.sh
#
# Reads server/.env (gitignored) for BUFFERS_TOKEN. Env: PYTHON (default
# .venv/bin/python), PORT (default 8060), BUFFERS_DATA_DIR (default ./data).
set -u
cd "$(dirname "$0")"

if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

if [ -z "${BUFFERS_TOKEN:-}" ]; then
  echo "[run.sh] BUFFERS_TOKEN is not set (expected in server/.env) — refusing to start." >&2
  exit 1
fi

PY="${PYTHON:-.venv/bin/python}"

while true; do
  "$PY" app.py
  code=$?
  if [ "$code" -eq 0 ]; then
    echo "[run.sh] server exited cleanly — stopping supervisor."
    break
  fi
  # A crash: come back, but pace the retries so a config error can't spin.
  echo "[run.sh] server exited (code $code) — restarting in 3s…"
  sleep 3
done
