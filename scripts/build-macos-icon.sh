#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_PNG="${1:-${ROOT_DIR}/public/logo.png}"
OUT_ICNS="${2:-${ROOT_DIR}/public/icon.icns}"
OUT_DOCK_PNG="${3:-${ROOT_DIR}/public/icon-dock.png}"
OUT_TRAY_PNG="${4:-${ROOT_DIR}/public/tray-mac.png}"
ICONSET_DIR="${ROOT_DIR}/public/icon.iconset"
TMP_DIR="$(mktemp -d)"
PADDED_MASTER="${TMP_DIR}/padded-master.png"
INNER_SIZE="${INNER_SIZE:-824}"
TRAY_INNER_SIZE="${TRAY_INNER_SIZE:-44}"

if [[ ! -f "${SRC_PNG}" ]]; then
  echo "source png not found: ${SRC_PNG}" >&2
  exit 1
fi

cleanup() {
  rm -rf "${ICONSET_DIR}" "${TMP_DIR}"
}

trap cleanup EXIT

rm -rf "${ICONSET_DIR}"
mkdir -p "${ICONSET_DIR}"

sips -z "${INNER_SIZE}" "${INNER_SIZE}" "${SRC_PNG}" --out "${PADDED_MASTER}" >/dev/null
sips -p 1024 1024 "${PADDED_MASTER}" --out "${OUT_DOCK_PNG}" >/dev/null

TRAY_MASTER="${TMP_DIR}/tray-master.png"
sips -z "${TRAY_INNER_SIZE}" "${TRAY_INNER_SIZE}" "${SRC_PNG}" --out "${TRAY_MASTER}" >/dev/null
sips -p 64 64 "${TRAY_MASTER}" --out "${OUT_TRAY_PNG}" >/dev/null

for size in 16 32 128 256 512; do
  sips -z "${size}" "${size}" "${OUT_DOCK_PNG}" --out "${ICONSET_DIR}/icon_${size}x${size}.png" >/dev/null
  retina_size=$((size * 2))
  sips -z "${retina_size}" "${retina_size}" "${OUT_DOCK_PNG}" --out "${ICONSET_DIR}/icon_${size}x${size}@2x.png" >/dev/null
done

iconutil -c icns "${ICONSET_DIR}" -o "${OUT_ICNS}"

echo "generated ${OUT_ICNS}"
echo "generated ${OUT_DOCK_PNG}"
echo "generated ${OUT_TRAY_PNG}"
