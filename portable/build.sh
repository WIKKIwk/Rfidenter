#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd -- "$ROOT_DIR/.." && pwd)"
TEMPLATE_DIR="$ROOT_DIR/templates"
DIST_ROOT="$ROOT_DIR/dist"
DIST_DIR="$DIST_ROOT/rfid-agent"
DOWNLOAD_DIR="$ROOT_DIR/downloads"

NODE_VERSION="20.19.6"
NODE_URL_X64="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"
NODE_URL_ARM64="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-arm64.tar.xz"

JRE_URL_X64="https://api.adoptium.net/v3/binary/latest/17/ga/linux/x64/jre/hotspot/normal/eclipse"
JRE_URL_ARM64="https://api.adoptium.net/v3/binary/latest/17/ga/linux/aarch64/jre/hotspot/normal/eclipse"

ARCHES="${RFID_PORTABLE_ARCHES:-x64}"
ARCH_LIST=()
case "$ARCHES" in
  all)
    ARCH_LIST=(x64 arm64)
    ;;
  x64|amd64)
    ARCH_LIST=(x64)
    ;;
  arm64|aarch64)
    ARCH_LIST=(arm64)
    ;;
  *)
    echo "Unknown RFID_PORTABLE_ARCHES: $ARCHES" >&2
    exit 1
    ;;
esac

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_cmd curl
require_cmd tar

mkdir -p "$DIST_ROOT" "$DOWNLOAD_DIR"
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

if command -v rsync >/dev/null 2>&1; then
  rsync -a "$TEMPLATE_DIR/" "$DIST_DIR/"
else
  (cd "$TEMPLATE_DIR" && tar -cf - .) | (cd "$DIST_DIR" && tar -xf -)
fi

mkdir -p "$DIST_DIR/rfid"

copy_tree() {
  local src="$1"
  local dst="$2"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete "$src/" "$dst/"
    return
  fi
  mkdir -p "$dst"
  (cd "$src" && tar -cf - .) | (cd "$dst" && tar -xf -)
}

copy_tree "$APP_DIR/Demo" "$DIST_DIR/rfid/Demo"
copy_tree "$APP_DIR/SDK" "$DIST_DIR/rfid/SDK"

rm -rf "$DIST_DIR/rfid/Demo/web-localhost/logs"
mkdir -p "$DIST_DIR/rfid/Demo/web-localhost/logs"

LOCAL_CFG="$DIST_DIR/rfid/Demo/web-localhost/server/local-config.json"
if [[ ! -f "$LOCAL_CFG" ]]; then
  mkdir -p "$(dirname "$LOCAL_CFG")"
  printf '{"erp":{}}\n' > "$LOCAL_CFG"
fi

mkdir -p "$DIST_DIR/runtime"

fetch() {
  local url="$1"
  local out="$2"
  if [[ ! -f "$out" ]]; then
    echo "Downloading: $url"
    curl --fail --location --silent --show-error --retry 3 --retry-all-errors "$url" -o "$out"
  fi
}

extract_tar_xz() {
  local archive="$1"
  local dest="$2"
  rm -rf "$dest"
  mkdir -p "$dest"
  tar -xJf "$archive" -C "$dest" --strip-components=1
}

extract_tar_gz() {
  local archive="$1"
  local dest="$2"
  rm -rf "$dest"
  mkdir -p "$dest"
  tar -xzf "$archive" -C "$dest" --strip-components=1
}

NODE_X64_TAR="$DOWNLOAD_DIR/node-v${NODE_VERSION}-linux-x64.tar.xz"
NODE_ARM64_TAR="$DOWNLOAD_DIR/node-v${NODE_VERSION}-linux-arm64.tar.xz"
JRE_X64_TAR="$DOWNLOAD_DIR/jre17-linux-x64.tar.gz"
JRE_ARM64_TAR="$DOWNLOAD_DIR/jre17-linux-arm64.tar.gz"

for arch in "${ARCH_LIST[@]}"; do
  if [[ "$arch" == "x64" ]]; then
    fetch "$NODE_URL_X64" "$NODE_X64_TAR"
    fetch "$JRE_URL_X64" "$JRE_X64_TAR"
    extract_tar_xz "$NODE_X64_TAR" "$DIST_DIR/runtime/linux-x64/node"
    extract_tar_gz "$JRE_X64_TAR" "$DIST_DIR/runtime/linux-x64/jre"
  elif [[ "$arch" == "arm64" ]]; then
    fetch "$NODE_URL_ARM64" "$NODE_ARM64_TAR"
    fetch "$JRE_URL_ARM64" "$JRE_ARM64_TAR"
    extract_tar_xz "$NODE_ARM64_TAR" "$DIST_DIR/runtime/linux-arm64/node"
    extract_tar_gz "$JRE_ARM64_TAR" "$DIST_DIR/runtime/linux-arm64/jre"
  fi
done

chmod +x "$DIST_DIR"/*.sh

echo "OK: $DIST_DIR"
