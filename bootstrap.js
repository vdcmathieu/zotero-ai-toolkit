/* eslint-disable no-undef */
// Bootstrap lifecycle for Zotero Expand (Zotero 7 bootstrapped plugin).

var ZoteroExpand;
var ZoteroExpandAI;

function log(msg) {
	Zotero.debug("Zotero Expand: " + msg);
}

function install() {}

async function startup({ id, version, rootURI }) {
	log("Starting up v" + version);

	// Load the AI client and the main controller into this scope.
	Services.scriptloader.loadSubScript(rootURI + "src/ai.js");
	Services.scriptloader.loadSubScript(rootURI + "src/expand.js");

	ZoteroExpand.init({ id, version, rootURI });
	ZoteroExpand.addToAllWindows();

	// Register the preference pane.
	Zotero.PreferencePanes.register({
		pluginID: "zotero-expand@vandemathieu",
		src: rootURI + "preferences/preferences.xhtml",
		scripts: [rootURI + "preferences/preferences.js"],
		label: "Zotero Expand",
	});
}

function onMainWindowLoad({ window }) {
	if (ZoteroExpand) {
		ZoteroExpand.addToWindow(window);
	}
}

function onMainWindowUnload({ window }) {
	if (ZoteroExpand) {
		ZoteroExpand.removeFromWindow(window);
	}
}

function shutdown() {
	log("Shutting down");
	if (ZoteroExpand) {
		ZoteroExpand.removeFromAllWindows();
	}
	ZoteroExpand = undefined;
	ZoteroExpandAI = undefined;
}

function uninstall() {}
