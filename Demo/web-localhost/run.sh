#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

PORT="${PORT:-8787}"
HOST="${HOST:-127.0.0.1}"

BRIDGE_OUT_DIR="$ROOT_DIR/server/bridge-out"
BRIDGE_SRC_DIR="$ROOT_DIR/server/bridge-src"
BRIDGE_MAIN_CLASS="$BRIDGE_OUT_DIR/com/st8504/bridge/BridgeMain.class"

NEED_BUILD=0

if [[ "${FORCE_BUILD_BRIDGE:-0}" == "1" ]]; then
  NEED_BUILD=1
fi

if [[ "${SKIP_BUILD_BRIDGE:-0}" != "1" ]]; then
  REQUIRED_CLASSES=(
    "com/st8504/bridge/BridgeMain.class"
    "android/util/Log.class"
    "android/os/SystemClock.class"
    "com/rfid/serialport/SerialPort.class"
  )

  for c in "${REQUIRED_CLASSES[@]}"; do
    if [[ ! -f "$BRIDGE_OUT_DIR/$c" ]]; then
      NEED_BUILD=1
      break
    fi
  done

  if [[ $NEED_BUILD -eq 0 && -f "$BRIDGE_MAIN_CLASS" ]]; then
    if find "$BRIDGE_SRC_DIR" -type f -name '*.java' -newer "$BRIDGE_MAIN_CLASS" -print -quit | grep -q .; then
      NEED_BUILD=1
    fi
  fi

  if [[ $NEED_BUILD -eq 1 ]]; then
    echo "Building Java bridge (auto)..."
    "$ROOT_DIR/build-bridge.sh"
  fi
fi

exec node "$ROOT_DIR/server/server.js" --host "$HOST" --port "$PORT"
