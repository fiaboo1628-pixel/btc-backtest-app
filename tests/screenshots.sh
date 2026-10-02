#!/usr/bin/env bash
# Chụp ảnh mọi kịch bản vào docs/screenshots (cần uv + playwright cài toàn cục: npm i -g playwright).
#   bash tests/screenshots.sh [thư mục đích]
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=${1:-docs/screenshots}
PY="uv run --no-project --with fastapi --with uvicorn --with httpx --with cryptography python"
run() {   # run <scenario> <port> <tham số screenshots.mjs...>
  local sc=$1 port=$2; shift 2
  $PY bot/hub/dev.py --scenario "$sc" --port "$port" >"/tmp/hub-dev-$sc.log" 2>&1 &
  local pid=$!
  for _ in $(seq 1 40); do curl -sf -u admin:dev "http://127.0.0.1:$port/api/hub" >/dev/null && break; sleep 0.5; done
  NODE_PATH="$(npm root -g)" node tests/screenshots.mjs --base "http://127.0.0.1:$port" --out "$OUT" --prefix "$sc" "$@"
  kill $pid
}
run demo 8191 --full
run live 8192 --screens overview,alerts
run halted 8193 --screens overview
run offline 8194 --screens overview,trades,data
run empty 8195 --screens overview,trades
run paper 8196 --screens overview
echo "Xong: $OUT"
