/* global Zotero */
"use strict";

/**
 * AI summarizer + highlight categorizer for Zotero AI Toolkit.
 *
 * Loaded into the bootstrap scope by bootstrap.js and exposed as
 * Zotero.AISummarizer so the preferences pane can reach it. The shared
 * preference pane is registered by bootstrap.js, which sets `paneID` here.
 *
 * Security notes:
 *  - API endpoints are hard-coded HTTPS URLs; there is deliberately no
 *    "custom base URL" setting, so a misconfiguration cannot send the
 *    API key anywhere except the chosen provider.
 *  - API keys are never written to the debug log.
 *  - Model output is sanitized (scripts, embeds, event handlers and
 *    javascript: URLs stripped) before being saved into a note.
 */
var AISummarizer = {
	id: null,
	version: null,
	rootURI: null,
	paneID: null,

	PREFIX: "extensions.zotero-ai-toolkit.",

	ANTHROPIC_URL: "https://api.anthropic.com/v1/messages",
	OPENAI_URL: "https://api.openai.com/v1/chat/completions",
	REQUEST_TIMEOUT: 300000, // 5 min — large papers + reasoning models can be slow
	NOTE_TAG: "ai-summary",

	DEFAULT_PROMPT: `You are an expert research assistant helping an academic build a literature-review knowledge base in Zotero.

Summarize the article below. Return WELL-FORMED HTML only (allowed tags: <h2>, <h3>, <p>, <ul>, <ol>, <li>, <strong>, <em>, <blockquote>). Do not include <html>, <head>, <body> tags, markdown, or code fences. Use exactly this structure:

<h2>TL;DR</h2> 2-3 plain-language sentences.
<h2>Research Question &amp; Motivation</h2> What the paper asks and why it matters.
<h2>Methodology</h2> Design, data, sample, and analysis approach.
<h2>Key Findings</h2> Bullet list; include effect sizes / statistics where reported.
<h2>Contributions &amp; Implications</h2> Theoretical and practical contributions.
<h2>Limitations</h2> Stated and evident limitations.
<h2>Notable Quotes</h2> 1-3 short verbatim quotes, with section hints if possible.
<h2>Suggested Keywords</h2> 5-8 tags as a comma-separated list.

Be faithful to the text. If something is not stated in the article, say so instead of guessing. If you were only given an abstract, note that the summary is based on the abstract alone. Write in {language}.`,

	/**
	 * Fixed highlight taxonomy, one category per line: "#color | Name | what belongs there".
	 * Colors are Zotero's standard reader palette. Blue (#2ea8e5) is deliberately
	 * NOT used: raw highlights stay blue, so blue always means "not yet categorized".
	 */
	DEFAULT_CATEGORIES: `#ffd400 | Key finding | Main results, central claims, headline numbers, effect sizes
#5fb236 | Methods & data | Research design, sample, data sources, measures, analysis approach
#a28ae5 | Theory & background | Definitions, key concepts, hypotheses, prior literature
#f19837 | Implications | Contributions, practical and theoretical implications, conclusions
#ff6666 | Limitations & critique | Weaknesses, caveats, boundary conditions, threats to validity
#e56eee | Quotable | Striking phrasing worth quoting verbatim
#aaaaaa | Other | Future research, open questions, context that fits nowhere else`,

	_windowListeners: new Map(),
	_running: false,

	/* ---------------------------------------------------------------- */
	/* Lifecycle                                                        */
	/* ---------------------------------------------------------------- */

	async init({ id, version, rootURI }) {
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
		Zotero.AISummarizer = this;
		// The preference pane is registered by bootstrap.js, which assigns
		// `this.paneID` so we can open it when an API key is missing.
	},

	addToWindow(window) {
		let doc = window.document;
		if (doc.getElementById("ai-summarizer-menuitem")) {
			return;
		}

		// Item context menu entries
		let itemMenu = doc.getElementById("zotero-itemmenu");
		if (itemMenu) {
			let menuitem = doc.createXULElement("menuitem");
			menuitem.id = "ai-summarizer-menuitem";
			menuitem.setAttribute("label", "Summarize with AI");
			menuitem.addEventListener("command", () => this.summarizeSelected(window));
			itemMenu.appendChild(menuitem);

			let catItem = doc.createXULElement("menuitem");
			catItem.id = "ai-categorizer-menuitem";
			catItem.setAttribute("label", "Categorize Highlights with AI");
			catItem.addEventListener("command", () => this.categorizeSelected(window));
			itemMenu.appendChild(catItem);
		}

		// Configurable keyboard shortcut
		let listener = (event) => this._handleKeyDown(event, window);
		doc.addEventListener("keydown", listener, true);
		this._windowListeners.set(window, listener);
	},

	removeFromWindow(window) {
		let doc = window.document;
		for (let id of ["ai-summarizer-menuitem", "ai-categorizer-menuitem"]) {
			let menuitem = doc.getElementById(id);
			if (menuitem) {
				menuitem.remove();
			}
		}
		let listener = this._windowListeners.get(window);
		if (listener) {
			doc.removeEventListener("keydown", listener, true);
			this._windowListeners.delete(window);
		}
	},

	/* ---------------------------------------------------------------- */
	/* Preferences helpers                                              */
	/* ---------------------------------------------------------------- */

	getPref(key) {
		try {
			return Zotero.Prefs.get(this.PREFIX + key, true);
		}
		catch (e) {
			return undefined;
		}
	},

	getIntPref(key, fallback) {
		let n = parseInt(this.getPref(key), 10);
		return Number.isFinite(n) && n > 0 ? n : fallback;
	},

	getProvider() {
		return this.getPref("provider") === "openai" ? "openai" : "anthropic";
	},

	getApiKey(provider) {
		let key = this.getPref(provider === "openai" ? "openaiApiKey" : "anthropicApiKey");
		return (key || "").trim();
	},

	getModel(provider) {
		let model = (this.getPref(provider === "openai" ? "openaiModel" : "anthropicModel") || "").trim();
		if (!model) {
			model = provider === "openai" ? "gpt-5" : "claude-opus-4-8";
		}
		return model;
	},

	/* ---------------------------------------------------------------- */
	/* Keyboard shortcut                                                */
	/* ---------------------------------------------------------------- */

	_handleKeyDown(event, window) {
		if (!this.getPref("shortcutEnabled")) {
			return;
		}
		if (!event.key) {
			return;
		}
		let pressed = event.key.toLowerCase();
		let summarizeKey = (this.getPref("shortcutKey") || "S").toLowerCase();
		let categorizeKey = (this.getPref("categorizeShortcutKey") || "H").toLowerCase();
		let action = null;
		if (pressed === summarizeKey) {
			action = "summarize";
		}
		else if (pressed === categorizeKey) {
			action = "categorize";
		}
		if (!action) {
			return;
		}
		let accel = Zotero.isMac ? event.metaKey : event.ctrlKey;
		if (!!this.getPref("shortcutAccel") !== accel) {
			return;
		}
		if (!!this.getPref("shortcutShift") !== event.shiftKey) {
			return;
		}
		if (!!this.getPref("shortcutAlt") !== event.altKey) {
			return;
		}
		// Never hijack typing inside text fields / the note editor
		let target = event.target;
		if (target && (target.localName === "input" || target.localName === "textarea" || target.isContentEditable)) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		if (action === "categorize") {
			this.categorizeSelected(window);
		}
		else {
			this.summarizeSelected(window);
		}
	},

	/* ---------------------------------------------------------------- */
	/* Main flow                                                        */
	/* ---------------------------------------------------------------- */

	/** Resolves the current selection to unique regular items (attachments map to their parents). */
	_getSelectedRegularItems(window) {
		let pane = window.ZoteroPane || Zotero.getActiveZoteroPane();
		let selected = pane ? pane.getSelectedItems() : [];
		let targets = [];
		let seen = new Set();
		for (let item of selected) {
			let target = null;
			if (item.isRegularItem()) {
				target = item;
			}
			else if (item.isAttachment() && item.parentItemID) {
				let parent = Zotero.Items.get(item.parentItemID);
				if (parent && parent.isRegularItem()) {
					target = parent;
				}
			}
			if (target && !seen.has(target.id)) {
				seen.add(target.id);
				targets.push(target);
			}
		}
		return targets;
	},

	/** Returns {provider, apiKey} or null (after notifying and opening settings). */
	_requireApiKey() {
		let provider = this.getProvider();
		let apiKey = this.getApiKey(provider);
		if (!apiKey) {
			this._notify("AI Toolkit", "No API key configured for " + this._providerLabel(provider)
				+ ". Opening settings…");
			if (this.paneID) {
				Zotero.Utilities.Internal.openPreferences(this.paneID);
			}
			return null;
		}
		return { provider, apiKey };
	},

	async summarizeSelected(window) {
		if (this._running) {
			this._notify("AI Toolkit", "An AI task is already running — please wait for it to finish.");
			return;
		}

		let targets = this._getSelectedRegularItems(window);
		if (!targets.length) {
			this._notify("AI Toolkit", "Select one or more articles (or their attachments) first.");
			return;
		}

		let creds = this._requireApiKey();
		if (!creds) {
			return;
		}
		let { provider, apiKey } = creds;

		this._running = true;
		let pw = new Zotero.ProgressWindow({ closeOnClick: false });
		pw.changeHeadline("Summarize with AI — " + this._providerLabel(provider));
		pw.show();

		let succeeded = 0;
		try {
			for (let item of targets) {
				let title = item.getField("title") || "(untitled)";
				let shortTitle = title.length > 60 ? title.slice(0, 57) + "…" : title;
				let line = new pw.ItemProgress(null, "Summarizing: " + shortTitle);
				try {
					await this._summarizeItem(item, provider, apiKey);
					line.setProgress(100);
					line.setText("Note created: " + shortTitle);
					succeeded++;
				}
				catch (e) {
					Zotero.debug("AI Toolkit summarize error for item " + item.id + ": " + e);
					line.setError();
					line.setText("Failed: " + shortTitle + " — " + this._shortError(e));
				}
			}
		}
		finally {
			this._running = false;
		}

		let summaryLine = new pw.ItemProgress(null,
			"Done: " + succeeded + "/" + targets.length + " summar" + (targets.length === 1 ? "y" : "ies") + " created.");
		summaryLine.setProgress(100);
		pw.startCloseTimer(8000);
	},

	async _summarizeItem(item, provider, apiKey) {
		let extracted = await this._getItemText(item);
		if (!extracted) {
			throw new Error("no full text or abstract available");
		}

		let maxChars = this.getIntPref("maxInputChars", 200000);
		let truncated = false;
		let text = extracted.text;
		if (text.length > maxChars) {
			text = text.slice(0, maxChars);
			truncated = true;
		}

		let systemPrompt = this._buildSystemPrompt();
		let userContent = this._buildUserContent(item, text, extracted.source, truncated);

		let model = this.getModel(provider);
		let raw = provider === "openai"
			? await this._callOpenAI(apiKey, model, systemPrompt, userContent)
			: await this._callAnthropic(apiKey, model, systemPrompt, userContent);

		if (!raw || !raw.trim()) {
			throw new Error("the model returned an empty response");
		}

		let html = this._sanitizeHtml(raw);
		await this._createNote(item, html, { provider, model, source: extracted.source, truncated });
	},

	/* ---------------------------------------------------------------- */
	/* Highlight categorization                                         */
	/* ---------------------------------------------------------------- */

	/** Parses the taxonomy ("#color | Name | description" per line) into category objects. */
	getCategories() {
		let raw = (this.getPref("categories") || "").trim() || this.DEFAULT_CATEGORIES;
		let categories = [];
		let seen = new Set();
		for (let line of raw.split("\n")) {
			let parts = line.split("|").map(p => p.trim());
			if (parts.length < 2 || !/^#[0-9a-fA-F]{6}$/.test(parts[0])) {
				continue;
			}
			let name = parts[1];
			let key = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
			if (!name || !key || seen.has(key)) {
				continue;
			}
			seen.add(key);
			categories.push({
				key: key,
				color: parts[0].toLowerCase(),
				name: name,
				description: parts[2] || "",
			});
		}
		return categories;
	},

	async categorizeSelected(window) {
		if (this._running) {
			this._notify("AI Toolkit", "Another AI task is already running — please wait for it to finish.");
			return;
		}

		let targets = this._getSelectedRegularItems(window);
		if (!targets.length) {
			this._notify("AI Toolkit", "Select one or more articles (or their attachments) first.");
			return;
		}

		let creds = this._requireApiKey();
		if (!creds) {
			return;
		}
		let { provider, apiKey } = creds;

		let categories = this.getCategories();
		if (categories.length < 2) {
			this._notify("AI Toolkit", "The category list in the settings is invalid — reset it to the built-in taxonomy.");
			if (this.paneID) {
				Zotero.Utilities.Internal.openPreferences(this.paneID);
			}
			return;
		}

		this._running = true;
		let pw = new Zotero.ProgressWindow({ closeOnClick: false });
		pw.changeHeadline("Categorize Highlights — " + this._providerLabel(provider));
		pw.show();

		try {
			for (let item of targets) {
				let title = item.getField("title") || "(untitled)";
				let shortTitle = title.length > 60 ? title.slice(0, 57) + "…" : title;
				let line = new pw.ItemProgress(null, "Categorizing highlights: " + shortTitle);
				try {
					let stats = await this._categorizeItem(item, provider, apiKey, categories);
					line.setProgress(100);
					line.setText("Categorized " + stats.categorized + "/" + stats.total
						+ " highlights: " + shortTitle);
				}
				catch (e) {
					Zotero.debug("AI Toolkit categorize error for item " + item.id + ": " + e);
					line.setError();
					line.setText("Failed: " + shortTitle + " — " + this._shortError(e));
				}
			}
		}
		finally {
			this._running = false;
		}
		pw.startCloseTimer(8000);
	},

	async _categorizeItem(item, provider, apiKey, categories) {
		let highlights = this._collectHighlights(item);
		if (!highlights.length) {
			throw new Error("no highlight annotations found — highlight passages in the PDF first");
		}

		let systemPrompt = this._buildCategorizeSystemPrompt(categories);
		let userContent = this._buildCategorizeUserContent(item, highlights);

		let model = this.getModel(provider);
		let raw = provider === "openai"
			? await this._callOpenAI(apiKey, model, systemPrompt, userContent)
			: await this._callAnthropic(apiKey, model, systemPrompt, userContent);

		let assignments = this._extractJsonArray(raw);
		if (!assignments) {
			throw new Error("the model returned no parseable categorization");
		}

		let catByKey = new Map(categories.map(c => [c.key, c]));
		let assigned = new Map(); // highlight index (1-based) -> category
		for (let entry of assignments) {
			let i = parseInt(entry && entry.i, 10);
			let cat = catByKey.get(entry && entry.c);
			if (cat && i >= 1 && i <= highlights.length && !assigned.has(i)) {
				assigned.set(i, cat);
			}
		}
		if (!assigned.size) {
			throw new Error("the model assigned no valid categories");
		}

		let tagAnnotations = !!this.getPref("tagAnnotations");
		let categoryNames = categories.map(c => c.name);
		await Zotero.DB.executeTransaction(async () => {
			for (let [i, cat] of assigned) {
				let annotation = highlights[i - 1].annotation;
				if (annotation.annotationColor !== cat.color) {
					annotation.annotationColor = cat.color;
				}
				if (tagAnnotations) {
					// Drop category tags from earlier runs so re-categorizing stays clean
					for (let tag of annotation.getTags()) {
						if (tag.tag !== cat.name && categoryNames.includes(tag.tag)) {
							annotation.removeTag(tag.tag);
						}
					}
					annotation.addTag(cat.name);
				}
				if (annotation.hasChanged()) {
					await annotation.save();
				}
			}
		});

		if (this.getPref("createDigestNote")) {
			await this._createDigestNote(item, highlights, assigned, categories, {
				provider, model, total: highlights.length,
			});
		}

		return { total: highlights.length, categorized: assigned.size };
	},

	/** Collects highlight/underline annotations with text from all file attachments, in reading order. */
	_collectHighlights(item) {
		let highlights = [];
		for (let attachmentID of item.getAttachments()) {
			let attachment = Zotero.Items.get(attachmentID);
			if (!attachment || !attachment.isFileAttachment()) {
				continue;
			}
			let annotations;
			try {
				annotations = attachment.getAnnotations();
			}
			catch (e) {
				continue;
			}
			for (let annotation of annotations) {
				if (annotation.annotationType !== "highlight" && annotation.annotationType !== "underline") {
					continue;
				}
				let text = (annotation.annotationText || "").trim();
				if (!text) {
					continue;
				}
				highlights.push({
					annotation: annotation,
					text: text,
					page: annotation.annotationPageLabel || "",
					comment: (annotation.annotationComment || "").trim(),
				});
			}
		}
		highlights.sort((a, b) => (a.annotation.annotationSortIndex || "")
			.localeCompare(b.annotation.annotationSortIndex || ""));
		return highlights;
	},

	_buildCategorizeSystemPrompt(categories) {
		let lines = [
			"You are classifying highlighted passages from an academic article into a fixed taxonomy, so that highlight colors mean the same thing across an entire Zotero library.",
			"",
			"Categories (key — name: what belongs there):",
		];
		for (let cat of categories) {
			lines.push("- " + cat.key + " — " + cat.name + (cat.description ? ": " + cat.description : ""));
		}
		let fallback = categories[categories.length - 1].key;
		lines.push("");
		lines.push("Assign exactly one category to every highlight. Judge each passage in the context of the article; the reader's own notes on a highlight, when present, are strong hints. When a passage fits several categories, pick the one most useful for a later literature review. Use \"" + fallback + "\" only when nothing else fits.");
		lines.push("");
		lines.push('Return ONLY a JSON array — no prose, no code fences — with one object per highlight: [{"i": 1, "c": "' + categories[0].key + '"}, …] where "i" is the highlight number and "c" is one of the category keys above.');
		return lines.join("\n");
	},

	_buildCategorizeUserContent(item, highlights) {
		let lines = [
			"Article: " + (item.getField("title") || "Unknown")
				+ (item.getField("date") ? " (" + item.getField("date") + ")" : ""),
		];
		let abstract = (item.getField("abstractNote") || "").trim();
		if (abstract) {
			lines.push("Abstract: " + (abstract.length > 1500 ? abstract.slice(0, 1500) + "…" : abstract));
		}
		lines.push("");
		lines.push("Highlights:");
		highlights.forEach((h, idx) => {
			let prefix = (idx + 1) + ". " + (h.page ? "(p. " + h.page + ") " : "");
			lines.push(prefix + JSON.stringify(h.text));
			if (h.comment) {
				lines.push("   reader's note: " + JSON.stringify(h.comment));
			}
		});
		return lines.join("\n");
	},

	/** Extracts the first JSON array from a model response, tolerating fences and prose. */
	_extractJsonArray(text) {
		if (!text) {
			return null;
		}
		let fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
		if (fenced) {
			text = fenced[1];
		}
		let start = text.indexOf("[");
		let end = text.lastIndexOf("]");
		if (start === -1 || end <= start) {
			return null;
		}
		try {
			let parsed = JSON.parse(text.slice(start, end + 1));
			return Array.isArray(parsed) ? parsed : null;
		}
		catch (e) {
			return null;
		}
	},

	async _createDigestNote(item, highlights, assigned, categories, meta) {
		let esc = s => Zotero.Utilities.htmlSpecialChars(s);
		let title = item.getField("title") || "(untitled)";
		let parts = [
			"<h1>Highlight Digest: " + esc(title) + "</h1>",
			"<p><em>Generated " + esc(new Date().toLocaleString())
				+ " · " + esc(this._providerLabel(meta.provider))
				+ " · " + esc(meta.model)
				+ " · " + meta.total + " highlight" + (meta.total === 1 ? "" : "s") + "</em></p>",
		];
		for (let cat of categories) {
			let entries = [];
			for (let [i, assignedCat] of assigned) {
				if (assignedCat.key === cat.key) {
					entries.push(highlights[i - 1]);
				}
			}
			if (!entries.length) {
				continue;
			}
			parts.push("<h2>" + esc(cat.name) + " (" + entries.length + ")</h2>");
			parts.push("<ul>");
			for (let h of entries) {
				let line = "<li>“" + esc(h.text) + "”" + (h.page ? " (p. " + esc(h.page) + ")" : "");
				if (h.comment) {
					line += "<br/><em>" + esc(h.comment) + "</em>";
				}
				parts.push(line + "</li>");
			}
			parts.push("</ul>");
		}
		let uncategorized = highlights.length - assigned.size;
		if (uncategorized > 0) {
			parts.push("<p><em>" + uncategorized + " highlight" + (uncategorized === 1 ? "" : "s")
				+ " could not be categorized and kept their original color.</em></p>");
		}

		let note = new Zotero.Item("note");
		note.libraryID = item.libraryID;
		note.parentItemID = item.id;
		note.setNote(parts.join("\n"));
		note.addTag("ai-highlights");
		await note.saveTx();
		return note;
	},

	/* ---------------------------------------------------------------- */
	/* Text extraction                                                  */
	/* ---------------------------------------------------------------- */

	async _getItemText(item) {
		let text = "";
		try {
			let attachment = await item.getBestAttachment();
			if (attachment && attachment.isFileAttachment()) {
				text = (await attachment.attachmentText) || "";
			}
		}
		catch (e) {
			Zotero.debug("AI Toolkit: full-text extraction failed: " + e);
		}

		if (text && text.trim().length >= 500) {
			return { text: text.trim(), source: "full text" };
		}

		let abstract = item.getField("abstractNote");
		if (abstract && abstract.trim()) {
			return { text: abstract.trim(), source: "abstract only" };
		}

		if (text && text.trim()) {
			return { text: text.trim(), source: "full text" };
		}
		return null;
	},

	/* ---------------------------------------------------------------- */
	/* Prompt building                                                  */
	/* ---------------------------------------------------------------- */

	_buildSystemPrompt() {
		let template = (this.getPref("promptTemplate") || "").trim() || this.DEFAULT_PROMPT;
		let language = (this.getPref("outputLanguage") || "English").trim() || "English";
		return template.replace(/\{language\}/g, language);
	},

	_buildUserContent(item, text, source, truncated) {
		let creators = item.getCreators()
			.map(c => (c.lastName || c.firstName || "").trim())
			.filter(Boolean);
		let authors = creators.length > 4
			? creators.slice(0, 4).join(", ") + " et al."
			: creators.join(", ");

		let lines = [
			"Article metadata:",
			"Title: " + (item.getField("title") || "Unknown"),
			"Authors: " + (authors || "Unknown"),
			"Date: " + (item.getField("date") || "Unknown"),
			"Publication: " + (item.getField("publicationTitle") || item.getField("publisher") || "Unknown"),
		];
		let doi = item.getField("DOI");
		if (doi) {
			lines.push("DOI: " + doi);
		}
		lines.push("");
		lines.push("Article text (source: " + source + (truncated ? ", truncated to fit the size limit" : "") + "):");
		lines.push('"""');
		lines.push(text);
		lines.push('"""');
		return lines.join("\n");
	},

	/* ---------------------------------------------------------------- */
	/* API clients                                                      */
	/* ---------------------------------------------------------------- */

	_supportsAdaptiveThinking(model) {
		return /fable|opus-4-[678]|sonnet-4-6/i.test(model);
	},

	async _callAnthropic(apiKey, model, systemPrompt, userContent) {
		let body = {
			model: model,
			max_tokens: this.getIntPref("maxOutputTokens", 16000),
			system: systemPrompt,
			messages: [{ role: "user", content: userContent }],
		};
		if (this._supportsAdaptiveThinking(model)) {
			body.thinking = { type: "adaptive" };
		}

		let data = await this._post(this.ANTHROPIC_URL, {
			"Content-Type": "application/json",
			"x-api-key": apiKey,
			"anthropic-version": "2023-06-01",
		}, body);

		if (data.stop_reason === "refusal") {
			let why = data.stop_details && data.stop_details.explanation;
			throw new Error("the model declined to summarize this item" + (why ? " (" + why + ")" : ""));
		}
		return (data.content || [])
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join("\n");
	},

	async _callOpenAI(apiKey, model, systemPrompt, userContent) {
		let body = {
			model: model,
			max_completion_tokens: this.getIntPref("maxOutputTokens", 16000),
			messages: [
				{ role: "system", content: systemPrompt },
				{ role: "user", content: userContent },
			],
		};

		let data = await this._post(this.OPENAI_URL, {
			"Content-Type": "application/json",
			"Authorization": "Bearer " + apiKey,
		}, body);

		let choice = data.choices && data.choices[0];
		return (choice && choice.message && choice.message.content) || "";
	},

	/**
	 * POST JSON and return the parsed response. Retries once on rate
	 * limiting / transient server errors. Never logs request headers.
	 */
	async _post(url, headers, body, isRetry) {
		try {
			let xhr = await Zotero.HTTP.request("POST", url, {
				headers: headers,
				body: JSON.stringify(body),
				responseType: "json",
				timeout: this.REQUEST_TIMEOUT,
			});
			return xhr.response;
		}
		catch (e) {
			let status = e && (e.status || (e.xmlhttp && e.xmlhttp.status));
			if (!isRetry && (status === 429 || status === 529 || status >= 500)) {
				await Zotero.Promise.delay(5000);
				return this._post(url, headers, body, true);
			}
			throw new Error(this._formatHttpError(e));
		}
	},

	_formatHttpError(e) {
		let status = e && (e.status || (e.xmlhttp && e.xmlhttp.status));
		let apiMessage = "";
		try {
			let resp = e.xmlhttp && e.xmlhttp.response;
			if (typeof resp === "string") {
				resp = JSON.parse(resp);
			}
			if (resp && resp.error) {
				apiMessage = resp.error.message || resp.error.type || "";
			}
		}
		catch (parseError) {
			// ignore — fall back to the status code
		}
		if (status === 401) {
			return "invalid API key (HTTP 401)";
		}
		if (status === 429) {
			return "rate limited (HTTP 429)" + (apiMessage ? ": " + apiMessage : "");
		}
		if (status) {
			return "HTTP " + status + (apiMessage ? ": " + apiMessage : "");
		}
		return "network error or timeout — check your connection";
	},

	/* ---------------------------------------------------------------- */
	/* Note creation                                                    */
	/* ---------------------------------------------------------------- */

	_sanitizeHtml(html) {
		html = html.trim();
		// Strip markdown code fences the model may have wrapped around the HTML
		let fenced = html.match(/^```(?:html)?\s*([\s\S]*?)\s*```$/);
		if (fenced) {
			html = fenced[1].trim();
		}

		// No tags at all → treat as plain text and convert to paragraphs
		if (!/[<][a-zA-Z]/.test(html)) {
			return html.split(/\n{2,}/)
				.map(p => "<p>" + Zotero.Utilities.htmlSpecialChars(p).replace(/\n/g, "<br/>") + "</p>")
				.join("\n");
		}

		// Remove active content entirely (tag + body)
		html = html.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "");
		// Remove other dangerous elements
		html = html.replace(/<\/?(?:script|style|iframe|object|embed|form|link|meta|base)\b[^>]*>/gi, "");
		// Remove inline event handlers
		html = html.replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
		// Neutralize javascript: URLs
		html = html.replace(/((?:href|src)\s*=\s*["']?)\s*javascript:[^"'>\s]*/gi, "$1#");
		return html;
	},

	async _createNote(item, html, meta) {
		let title = item.getField("title") || "(untitled)";
		let when = new Date().toLocaleString();
		let header = "<h1>AI Summary: " + Zotero.Utilities.htmlSpecialChars(title) + "</h1>\n"
			+ "<p><em>Generated " + Zotero.Utilities.htmlSpecialChars(when)
			+ " · " + Zotero.Utilities.htmlSpecialChars(this._providerLabel(meta.provider))
			+ " · " + Zotero.Utilities.htmlSpecialChars(meta.model)
			+ " · based on " + Zotero.Utilities.htmlSpecialChars(meta.source)
			+ (meta.truncated ? " (input truncated)" : "")
			+ "</em></p>\n";

		let note = new Zotero.Item("note");
		note.libraryID = item.libraryID;
		note.parentItemID = item.id;
		note.setNote(header + html);
		note.addTag(this.NOTE_TAG);
		await note.saveTx();
		return note;
	},

	/* ---------------------------------------------------------------- */
	/* Settings-pane helpers                                            */
	/* ---------------------------------------------------------------- */

	/** Sends a minimal request so the user can verify their key in settings. */
	async testApiKey() {
		let provider = this.getProvider();
		let apiKey = this.getApiKey(provider);
		if (!apiKey) {
			return { success: false, message: "Enter an API key for " + this._providerLabel(provider) + " first." };
		}
		let model = this.getModel(provider);
		try {
			if (provider === "openai") {
				await this._post(this.OPENAI_URL, {
					"Content-Type": "application/json",
					"Authorization": "Bearer " + apiKey,
				}, {
					model: model,
					max_completion_tokens: 32,
					messages: [{ role: "user", content: "Reply with the single word OK." }],
				}, true);
			}
			else {
				await this._post(this.ANTHROPIC_URL, {
					"Content-Type": "application/json",
					"x-api-key": apiKey,
					"anthropic-version": "2023-06-01",
				}, {
					model: model,
					max_tokens: 32,
					messages: [{ role: "user", content: "Reply with the single word OK." }],
				}, true);
			}
			return { success: true, message: "Success — " + this._providerLabel(provider) + " accepted the key (model: " + model + ")." };
		}
		catch (e) {
			return { success: false, message: "Failed: " + this._shortError(e) };
		}
	},

	/* ---------------------------------------------------------------- */
	/* Misc                                                             */
	/* ---------------------------------------------------------------- */

	_providerLabel(provider) {
		return provider === "openai" ? "OpenAI (ChatGPT)" : "Anthropic (Claude)";
	},

	_shortError(e) {
		let msg = (e && e.message) ? e.message : String(e);
		return msg.length > 200 ? msg.slice(0, 197) + "…" : msg;
	},

	_notify(headline, text) {
		let pw = new Zotero.ProgressWindow();
		pw.changeHeadline(headline);
		pw.addDescription(text);
		pw.show();
		pw.startCloseTimer(6000);
	},
};
