#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$(cd -- "$SCRIPT_DIR/web-localhost" && pwd)"

PORT="${PORT:-8787}"
if [[ $# -ge 1 ]]; then
  PORT="$1"
fi

HOST="${HOST:-127.0.0.1}"
if [[ $# -ge 2 ]]; then
  HOST="$2"
fi

export PORT
export HOST
exec "$WEB_DIR/run.sh"
