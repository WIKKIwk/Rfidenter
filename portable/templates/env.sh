#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

ARCH="$(uname -m)"
RUNTIME_DIR=""
case "$ARCH" in
  x86_64|amd64)
    RUNTIME_DIR="$ROOT_DIR/runtime/linux-x64"
    ;;
  aarch64|arm64)
    RUNTIME_DIR="$ROOT_DIR/runtime/linux-arm64"
    ;;
  *)
    echo "Unsupported architecture: $ARCH" >&2
    exit 1
    ;;
esac

NODE_BIN="$RUNTIME_DIR/node/bin/node"
JAVA_HOME="$RUNTIME_DIR/jre"
JAVA_BIN="$JAVA_HOME/bin/java"

if [[ ! -x "$NODE_BIN" ]]; then
  echo "Bundled Node.js not found: $NODE_BIN" >&2
  exit 1
fi

if [[ ! -x "$JAVA_BIN" ]]; then
  echo "Bundled Java not found: $JAVA_BIN" >&2
  exit 1
fi

export JAVA_HOME
export PATH="$(dirname "$NODE_BIN"):$JAVA_HOME/bin:$PATH"
export RFID_RUNTIME_DIR="$RUNTIME_DIR"
