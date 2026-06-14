/* global Zotero, Services */
"use strict";

var AISummarizer;

function log(msg) {
	Zotero.debug("AI Summarizer (bootstrap): " + msg);
}

function install() {}

async function startup({ id, version, rootURI }) {
	log("Starting " + version);

	Services.scriptloader.loadSubScript(rootURI + "content/summarizer.js");
	await AISummarizer.init({ id, version, rootURI });

	// Add UI to any windows that are already open
	for (let win of Zotero.getMainWindows()) {
		AISummarizer.addToWindow(win);
	}
}

function onMainWindowLoad({ window }) {
	if (AISummarizer) {
		AISummarizer.addToWindow(window);
	}
}

function onMainWindowUnload({ window }) {
	if (AISummarizer) {
		AISummarizer.removeFromWindow(window);
	}
}

function shutdown() {
	log("Shutting down");
	if (AISummarizer) {
		for (let win of Zotero.getMainWindows()) {
			AISummarizer.removeFromWindow(win);
		}
		if (Zotero.AISummarizer) {
			delete Zotero.AISummarizer;
		}
	}
	AISummarizer = undefined;
}

function uninstall() {}
