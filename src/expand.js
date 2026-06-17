/* eslint-disable no-undef */
// "Find further reading" feature for Zotero AI Toolkit: adds a menu item,
// gathers the selected article's text + bibliography, calls the AI, and saves
// the recommendations as a child note on the item.
//
// Provider, API keys and models are shared across the whole toolkit and live
// under the extensions.zotero-ai-toolkit.* preferences.

ZoteroExpand = {
	id: null,
	version: null,
	rootURI: null,
	PREFIX: "extensions.zotero-ai-toolkit.",
	addedElementIDs: [],

	init({ id, version, rootURI }) {
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
	},

	getPref(key) {
		return Zotero.Prefs.get(this.PREFIX + key, true);
	},

	getProvider() {
		return this.getPref("provider") === "openai" ? "openai" : "anthropic";
	},

	getApiKey(provider) {
		const key = this.getPref(provider === "openai" ? "openaiApiKey" : "anthropicApiKey");
		return (key || "").trim();
	},

	getModel(provider) {
		return (this.getPref(provider === "openai" ? "openaiModel" : "anthropicModel") || "").trim();
	},

	providerLabel(provider) {
		return provider === "openai" ? "OpenAI (GPT)" : "Anthropic (Claude)";
	},

	// --- UI wiring ---------------------------------------------------------

	addToWindow(window) {
		const doc = window.document;
		const itemmenu = doc.getElementById("zotero-itemmenu");
		if (!itemmenu || doc.getElementById("zotero-expand-itemmenu")) return;

		const menuitem = doc.createXULElement("menuitem");
		menuitem.id = "zotero-expand-itemmenu";
		menuitem.setAttribute("label", "Find further reading (AI)");
		menuitem.addEventListener("command", () => {
			this.run(window);
		});
		itemmenu.appendChild(menuitem);
		this.storeAddedElement(menuitem);
	},

	storeAddedElement(elem) {
		if (!elem.id) throw new Error("Element must have an id");
		if (!this.addedElementIDs.includes(elem.id)) this.addedElementIDs.push(elem.id);
	},

	removeFromWindow(window) {
		const doc = window.document;
		for (const id of this.addedElementIDs) {
			const elem = doc.getElementById(id);
			if (elem) elem.remove();
		}
	},

	// --- Main flow ---------------------------------------------------------

	async run(window) {
		const provider = this.getProvider();
		const apiKey = this.getApiKey(provider);

		if (!apiKey) {
			window.alert(
				"Zotero AI Toolkit: no API key set.\n\n"
				+ "Open Settings → AI Toolkit and paste your "
				+ this.providerLabel(provider)
				+ " API key."
			);
			return;
		}

		const pane = window.ZoteroPane;
		const selected = pane.getSelectedItems();
		const item = this.pickItem(selected);
		if (!item) {
			window.alert("Zotero AI Toolkit: please select a single article (not a collection or note).");
			return;
		}

		const progress = new Zotero.ProgressWindow({ closeOnClick: true });
		progress.changeHeadline("Find further reading");
		const line = progress.ItemProgress
			? new progress.ItemProgress("chrome://zotero/skin/treeitem-journalArticle@2x.png", "Reading article…")
			: null;
		progress.addDescription("Reading the article and searching for further reading…");
		progress.show();

		try {
			const meta = this.getMeta(item);
			const articleText = await this.getFullText(item);
			const maxChars = parseInt(this.getPref("maxChars")) || 120000;
			const trimmed = articleText.length > maxChars
				? articleText.slice(0, maxChars)
				: articleText;

			const count = parseInt(this.getPref("numRecommendations")) || 8;
			const model = this.getModel(provider);

			const result = await ZoteroExpandAI.recommend({
				provider,
				apiKey,
				model,
				count,
				articleText: trimmed,
				meta,
			});

			const noteItem = await this.saveNote(item, result, provider, model);

			if (line) line.setProgress(100);
			const num = (result.recommendations || []).length;
			progress.addDescription("Added " + num + " recommendation" + (num === 1 ? "" : "s") + " as a note.");
			progress.startCloseTimer(5000);

			// Select the new note so the user sees it immediately.
			if (noteItem) {
				try { await pane.selectItem(noteItem.id); } catch (e) { /* non-fatal */ }
			}
		}
		catch (e) {
			Zotero.logError(e);
			progress.addDescription("Error: " + e.message);
			progress.startCloseTimer(8000);
			window.alert("Find further reading failed:\n\n" + e.message);
		}
	},

	pickItem(items) {
		if (!items || !items.length) return null;
		for (const it of items) {
			if (it.isRegularItem && it.isRegularItem()) return it;
			// If a PDF/attachment is selected, use its parent.
			if (it.isAttachment && it.isAttachment() && it.parentItemID) {
				return Zotero.Items.get(it.parentItemID);
			}
		}
		return null;
	},

	getMeta(item) {
		const creators = item.getCreators()
			.map(c => (c.firstName ? c.firstName + " " : "") + (c.lastName || c.name || ""))
			.filter(Boolean)
			.join("; ");
		return {
			title: item.getField("title"),
			creators: creators,
			date: item.getField("date"),
			publication: item.getField("publicationTitle") || item.getField("publisher"),
			DOI: item.getField("DOI"),
			abstract: item.getField("abstractNote"),
		};
	},

	async getFullText(item) {
		const parts = [];
		const attachmentIDs = item.getAttachments ? item.getAttachments() : [];
		for (const id of attachmentIDs) {
			const att = Zotero.Items.get(id);
			if (!att || !att.isFileAttachment || !att.isFileAttachment()) continue;
			try {
				const text = await att.attachmentText;
				if (text && text.trim()) parts.push(text);
			}
			catch (e) {
				Zotero.logError(e);
			}
		}
		return parts.join("\n\n");
	},

	// --- Output ------------------------------------------------------------

	escape(s) {
		return String(s == null ? "" : s)
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;");
	},

	buildNoteHTML(result, provider, model) {
		const esc = s => this.escape(s);
		const recs = result.recommendations || [];
		const topics = result.topics || [];

		let html = "<h1>Further reading (AI)</h1>";
		if (result.summary) {
			html += "<p><b>Article summary:</b> " + esc(result.summary) + "</p>";
		}
		if (topics.length) {
			html += "<p><b>Key topics:</b> " + topics.map(esc).join(", ") + "</p>";
		}

		html += "<ol>";
		for (const r of recs) {
			let line = "<b>" + esc(r.title) + "</b>";
			const bits = [];
			if (r.authors) bits.push(esc(r.authors));
			if (r.year) bits.push(esc(r.year));
			if (r.venue) bits.push("<i>" + esc(r.venue) + "</i>");
			if (bits.length) line += " &mdash; " + bits.join(", ");

			let linkHref = "";
			if (r.url) linkHref = r.url;
			else if (r.doi) linkHref = "https://doi.org/" + String(r.doi).replace(/^https?:\/\/doi\.org\//, "");
			if (linkHref) {
				const safeHref = esc(linkHref);
				line += '<br/><a href="' + safeHref + '">' + safeHref + "</a>";
			}
			if (r.reason) line += "<br/><span>" + esc(r.reason) + "</span>";
			if (r.source) line += " <i>[" + esc(r.source) + "]</i>";
			html += "<li>" + line + "</li>";
		}
		html += "</ol>";

		const when = new Date().toLocaleString();
		html += "<p><small>Generated by Zotero AI Toolkit on " + esc(when)
			+ " using " + esc(this.providerLabel(provider)) + (model ? " / " + esc(model) : "")
			+ ". Verify sources before citing.</small></p>";
		return html;
	},

	async saveNote(item, result, provider, model) {
		const note = new Zotero.Item("note");
		note.libraryID = item.libraryID;
		note.parentID = item.id;
		note.setNote(this.buildNoteHTML(result, provider, model));
		note.addTag("ai-further-reading");
		await note.saveTx();
		return note;
	},
};
