#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$ROOT_DIR/env.sh"

exec "$ROOT_DIR/rfid/Demo/web-localhost/start-tui.sh" "$@"
