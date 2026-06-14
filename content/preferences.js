/* global Zotero, document */
"use strict";

/**
 * Script for the AI Summarizer preferences pane. Preference <-> element
 * binding is handled by Zotero via the `preference` attributes in
 * preferences.xhtml; this script only wires up the buttons.
 */
(function () {
	function $(id) {
		return document.getElementById(id);
	}

	function setStatus(text, ok) {
		let status = $("ai-summarizer-test-result");
		if (status) {
			status.textContent = text;
			status.style.color = ok ? "green" : "red";
		}
	}

	function setPromptTemplate(value) {
		Zotero.Prefs.set("aisummarizer.promptTemplate", value);
		let textarea = $("ai-summarizer-prompt");
		if (textarea) {
			textarea.value = value;
		}
	}

	function init() {
		let testButton = $("ai-summarizer-test-key");
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

		let loadDefaultButton = $("ai-summarizer-load-default-prompt");
		if (loadDefaultButton) {
			loadDefaultButton.addEventListener("click", () => {
				setPromptTemplate(Zotero.AISummarizer.DEFAULT_PROMPT);
			});
		}

		let clearButton = $("ai-summarizer-clear-prompt");
		if (clearButton) {
			clearButton.addEventListener("click", () => {
				setPromptTemplate("");
			});
		}

		let setCategories = (value) => {
			Zotero.Prefs.set("aisummarizer.categories", value);
			let textarea = $("ai-summarizer-categories");
			if (textarea) {
				textarea.value = value;
			}
		};
		let loadCategoriesButton = $("ai-summarizer-load-default-categories");
		if (loadCategoriesButton) {
			loadCategoriesButton.addEventListener("click", () => {
				setCategories(Zotero.AISummarizer.DEFAULT_CATEGORIES);
			});
		}
		let clearCategoriesButton = $("ai-summarizer-clear-categories");
		if (clearCategoriesButton) {
			clearCategoriesButton.addEventListener("click", () => {
				setCategories("");
			});
		}
	}

	init();
})();
