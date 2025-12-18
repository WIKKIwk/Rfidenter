#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
APP_SRC="${SCRIPT_DIR}/rfidenter"

BENCH_DIR="${1:-}"
SITE="${2:-}"

if [[ -z "${BENCH_DIR}" || -z "${SITE}" ]]; then
  echo "Usage: ${0} /path/to/bench site_name"
  echo "Example: ${0} /home/frappe/frappe-bench erp.localhost"
  exit 1
fi

if [[ ! -d "${APP_SRC}" ]]; then
  echo "ERROR: App source not found: ${APP_SRC}"
  exit 1
fi

if [[ ! -d "${BENCH_DIR}" ]]; then
  echo "ERROR: Bench dir not found: ${BENCH_DIR}"
  exit 1
fi

if [[ ! -d "${BENCH_DIR}/sites/${SITE}" ]]; then
  echo "ERROR: Site not found: ${BENCH_DIR}/sites/${SITE}"
  exit 1
fi

BENCH_CMD="bench"
if [[ -x "${BENCH_DIR}/env/bin/bench" ]]; then
  BENCH_CMD="${BENCH_DIR}/env/bin/bench"
elif command -v bench >/dev/null 2>&1; then
  BENCH_CMD="bench"
else
  echo "ERROR: bench command not found (PATH yoki ${BENCH_DIR}/env/bin/bench)"
  exit 1
fi

cd "${BENCH_DIR}"

mkdir -p apps

if [[ -d "apps/rfidenter" ]]; then
  TS="$(date +%Y%m%d_%H%M%S)"
  echo "Backup: apps/rfidenter -> apps/rfidenter.bak.${TS}"
  mv "apps/rfidenter" "apps/rfidenter.bak.${TS}"
fi

echo "Copying rfidenter app into bench..."
cp -a "${APP_SRC}" "apps/"

echo "Installing / migrating..."
if "${BENCH_CMD}" --site "${SITE}" list-apps | grep -q "^rfidenter\\b"; then
  "${BENCH_CMD}" --site "${SITE}" migrate
else
  "${BENCH_CMD}" --site "${SITE}" install-app rfidenter
  "${BENCH_CMD}" --site "${SITE}" migrate
fi

echo "Building assets (optional)..."
if ! "${BENCH_CMD}" build --app rfidenter; then
  echo "WARN: bench build failed. Node/yarn kerak bo‘lishi mumkin. Keyinroq serverda build qiling."
fi

echo "Done."
echo "Open: http(s)://<ERP_DOMAIN>/app/rfidenter"
