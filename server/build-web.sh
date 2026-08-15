#!/usr/bin/env bash
# Build the web UI and put it where app.py serves it from.
#
# The server serves server/web/ (gitignored, like .venv and data/) rather than
# reading dist-web/ directly, so a half-finished build can never be live: the
# swap at the end is the only moment anything changes.
#
# Flask picks the new files up on the next request -- no restart, because the
# bundle's asset names are content-hashed and index.html is served no-cache.
set -euo pipefail

cd "$(dirname "$0")/.."

# corepack ships with node and reads the pnpm version from package.json, so
# there is nothing to install globally on the box.
PNPM=(corepack pnpm)
command -v pnpm >/dev/null 2>&1 && PNPM=(pnpm)

"${PNPM[@]}" install --frozen-lockfile
"${PNPM[@]}" run build:web

rm -rf server/web.new
cp -r dist-web server/web.new
rm -rf server/web.old
[ -d server/web ] && mv server/web server/web.old
mv server/web.new server/web
rm -rf server/web.old

echo "built $(find server/web -type f | wc -l) files into server/web"
