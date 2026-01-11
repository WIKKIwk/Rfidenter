#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$ROOT_DIR/env.sh"

: "${RFID_TUI_API_STARTSTOP:=1}"
export RFID_TUI_API_STARTSTOP

exec "$ROOT_DIR/rfid/Demo/start-web.sh" "$@"
