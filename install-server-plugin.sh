#!/usr/bin/env bash
set -euo pipefail

ST_DIR="${1:-/opt/sillytavern}"
PLUGIN_DIR="${ST_DIR}/plugins/sillytavern-incremental-save"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -d "${SOURCE_DIR}/server-plugin" ]; then
  echo "server-plugin directory not found" >&2
  exit 1
fi

mkdir -p "${PLUGIN_DIR}"
cp "${SOURCE_DIR}/server-plugin/package.json" "${PLUGIN_DIR}/package.json"
cp "${SOURCE_DIR}/server-plugin/index.js" "${PLUGIN_DIR}/index.js"

echo "Installed server plugin to ${PLUGIN_DIR}"
echo "Make sure config/config.yaml has: enableServerPlugins: true"
