/* global Zotero, document */
"use strict";

/**
 * Script for the Zotero AI Toolkit preferences pane. Preference <-> element
 * binding is handled by Zotero via the `preference` attributes in
 * preferences.xhtml; this script only wires up the buttons.
 */
(function () {
	const PREFIX = "extensions.zotero-ai-toolkit.";

	function $(id) {
		return document.getElementById(id);
	}

	function setStatus(text, ok) {
		let status = $("ai-toolkit-test-result");
		if (status) {
			status.textContent = text;
			status.style.color = ok ? "green" : "red";
		}
	}

	function setPref(key, value) {
		// Full pref path (second arg `true`), matching the toolkit's modules.
		Zotero.Prefs.set(PREFIX + key, value, true);
	}

	function setPromptTemplate(value) {
		setPref("promptTemplate", value);
		let textarea = $("ai-toolkit-prompt");
		if (textarea) {
			textarea.value = value;
		}
	}

	function setCategories(value) {
		setPref("categories", value);
		let textarea = $("ai-toolkit-categories");
		if (textarea) {
			textarea.value = value;
		}
	}

	function setChatPrompt(value) {
		setPref("chatSystemPrompt", value);
		let textarea = $("ai-toolkit-chat-prompt");
		if (textarea) {
			textarea.value = value;
		}
	}

	function init() {
		let testButton = $("ai-toolkit-test-key");
		if (testButton) {
			testButton.addEventListener("click", async () => {
				setStatus("Testing…", true);
				testButton.disabled = true;
				try {
					let result = await Zotero.AISummarizer.testApiKey();
					setStatus(result.message, result.success);
				}
				catch (e) {
					setStatus("Failed: " + e, false);
				}
				finally {
					testButton.disabled = false;
				}
			});
		}

		let loadDefaultButton = $("ai-toolkit-load-default-prompt");
		if (loadDefaultButton) {
			loadDefaultButton.addEventListener("click", () => {
				setPromptTemplate(Zotero.AISummarizer.DEFAULT_PROMPT);
			});
		}

		let clearButton = $("ai-toolkit-clear-prompt");
		if (clearButton) {
			clearButton.addEventListener("click", () => {
				setPromptTemplate("");
			});
		}

		let loadCategoriesButton = $("ai-toolkit-load-default-categories");
		if (loadCategoriesButton) {
			loadCategoriesButton.addEventListener("click", () => {
				setCategories(Zotero.AISummarizer.DEFAULT_CATEGORIES);
			});
		}
		let clearCategoriesButton = $("ai-toolkit-clear-categories");
		if (clearCategoriesButton) {
			clearCategoriesButton.addEventListener("click", () => {
				setCategories("");
			});
		}

		let loadDefaultChatButton = $("ai-toolkit-load-default-chat-prompt");
		if (loadDefaultChatButton) {
			loadDefaultChatButton.addEventListener("click", () => {
				setChatPrompt(Zotero.AIChat.DEFAULT_SYSTEM_PROMPT);
			});
		}
		let clearChatButton = $("ai-toolkit-clear-chat-prompt");
		if (clearChatButton) {
			clearChatButton.addEventListener("click", () => {
				setChatPrompt("");
			});
		}
	}

	init();
})();
