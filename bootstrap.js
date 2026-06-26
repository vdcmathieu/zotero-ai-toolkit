/* eslint-disable no-undef */
// Bootstrap lifecycle for Zotero AI Toolkit (Zotero 7 bootstrapped plugin).
//
// The toolkit bundles several independent AI features, each in its own module
// under src/. This file loads them, registers a single shared preference pane,
// and wires every feature's UI into each Zotero window.

var ZoteroExpand;
var ZoteroExpandAI;
var AISummarizer;
var ZoteroSort;
var ZoteroChat;

const PLUGIN_ID = "zotero-ai-toolkit@vandemathieu";

function log(msg) {
	Zotero.debug("Zotero AI Toolkit: " + msg);
}

function install() {}

async function startup({ id, version, rootURI }) {
	log("Starting up v" + version);

	// Load every feature module into this scope.
	Services.scriptloader.loadSubScript(rootURI + "src/expand-ai.js");
	Services.scriptloader.loadSubScript(rootURI + "src/expand.js");
	Services.scriptloader.loadSubScript(rootURI + "src/summarizer.js");
	Services.scriptloader.loadSubScript(rootURI + "src/sorter.js");
	Services.scriptloader.loadSubScript(rootURI + "src/chat.js");

	// Initialise each controller.
	ZoteroExpand.init({ id, version, rootURI });
	await AISummarizer.init({ id, version, rootURI });
	ZoteroSort.init({ id, version, rootURI });
	ZoteroChat.init({ id, version, rootURI });

	// One shared preference pane for the whole toolkit.
	const paneID = await Zotero.PreferencePanes.register({
		pluginID: PLUGIN_ID,
		src: rootURI + "preferences/preferences.xhtml",
		scripts: [rootURI + "preferences/preferences.js"],
		label: "AI Toolkit",
	});
	// The summarizer opens this pane when no API key is configured.
	AISummarizer.paneID = paneID;

	addToAllWindows();
}

function addToAllWindows() {
	for (const win of Zotero.getMainWindows()) {
		if (win.ZoteroPane) addToWindow(win);
	}
}

function addToWindow(window) {
	if (ZoteroExpand) ZoteroExpand.addToWindow(window);
	if (AISummarizer) AISummarizer.addToWindow(window);
	if (ZoteroSort) ZoteroSort.addToWindow(window);
	if (ZoteroChat) ZoteroChat.addToWindow(window);
}

function removeFromWindow(window) {
	if (ZoteroExpand) ZoteroExpand.removeFromWindow(window);
	if (AISummarizer) AISummarizer.removeFromWindow(window);
	if (ZoteroSort) ZoteroSort.removeFromWindow(window);
	if (ZoteroChat) ZoteroChat.removeFromWindow(window);
}

function onMainWindowLoad({ window }) {
	addToWindow(window);
}

function onMainWindowUnload({ window }) {
	removeFromWindow(window);
}

function shutdown() {
	log("Shutting down");
	for (const win of Zotero.getMainWindows()) {
		removeFromWindow(win);
	}
	if (Zotero.AISummarizer) {
		delete Zotero.AISummarizer;
	}
	if (Zotero.AIChat) {
		delete Zotero.AIChat;
	}
	ZoteroExpand = undefined;
	ZoteroExpandAI = undefined;
	AISummarizer = undefined;
	ZoteroSort = undefined;
	ZoteroChat = undefined;
}

function uninstall() {}
