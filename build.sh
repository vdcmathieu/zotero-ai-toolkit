#!/usr/bin/env bash
# Build zotero-ai-toolkit.xpi from the plugin source.
# A Zotero plugin is just a zip of the plugin root.
set -euo pipefail
cd "$(dirname "$0")"

OUT="zotero-ai-toolkit.xpi"
rm -f "$OUT"

zip -r -FS "$OUT" \
	manifest.json \
	bootstrap.js \
	prefs.js \
	src \
	preferences \
	-x '*.DS_Store' > /dev/null

echo "Built $OUT"
