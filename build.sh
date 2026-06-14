#!/bin/bash
# Packages the plugin into an installable .xpi (a Zotero plugin is just a
# zip of the plugin root). Output: ai-summarizer.xpi
set -euo pipefail
cd "$(dirname "$0")"

XPI="ai-summarizer.xpi"
rm -f "$XPI"
zip -r "$XPI" manifest.json bootstrap.js prefs.js content \
	-x '*.DS_Store' > /dev/null
echo "Built $XPI"
