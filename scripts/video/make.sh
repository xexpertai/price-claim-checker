#!/usr/bin/env bash
# Full demo video build: narration -> footage of the real app (recorded mode, anonymised) -> assemble -> QA.
# Usage: scripts/video/make.sh [out.mp4]
set -euo pipefail
cd "$(dirname "$0")/../.."
PY=${VIDEO_PY:-$HOME/workspace/.video-venv/bin/python}
B=video/build; OUT=${1:-$B/price-claim-checker-demo.mp4}; PORT=${VIDEO_PORT:-8791}
mkdir -p $B
"$PY" scripts/video/tts.py video/story.json $B
if curl -sf localhost:$PORT/api/status >/dev/null; then echo "port $PORT is busy (stale server?)" >&2; exit 1; fi
PCC_MODE=recorded PCC_DATA_DIR=$B/data PORT=$PORT node --import tsx src/server.ts > $B/server.log 2>&1 &
SP=$!; trap 'kill $SP 2>/dev/null' EXIT
for i in $(seq 40); do curl -sf localhost:$PORT/api/status >/dev/null && break; sleep 0.25; done
node scripts/video/footage.mjs video/story.json $B http://127.0.0.1:$PORT
"$PY" scripts/video/assemble.py video/story.json $B "$OUT"
"$PY" scripts/video/qa.py "$OUT" $B/qa
