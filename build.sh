#!/usr/bin/env bash
# Build zotero-expand.xpi from the plugin source.
set -euo pipefail
cd "$(dirname "$0")"

OUT="zotero-expand.xpi"
rm -f "$OUT"

zip -r -FS "$OUT" \
	manifest.json \
	bootstrap.js \
	prefs.js \
	src \
	preferences \
	-x '*.DS_Store'

echo "Built $OUT"
