#!/bin/sh
# Packs the extension into dist/remold-<version>.zip (what Chrome's Load unpacked or the Web Store takes).
set -e
cd "$(dirname "$0")"
v=$(node -p 'require("./manifest.json").version')
mkdir -p dist && rm -f "dist/remold-$v.zip"
zip -qr "dist/remold-$v.zip" manifest.json src icons LICENSE -x '*.DS_Store' 'icons/mark.svg'
echo "dist/remold-$v.zip"
