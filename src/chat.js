/* eslint-disable no-undef */
// "Ask a question" chat feature for Zotero AI Toolkit.
//
// Right-click a paper (or open it from the item menu) → a NotebookLM-style
// panel docks on the right edge of the Zotero window. The whole paper is put
// in the model's system prompt once; each question the user types is sent as a
// chat turn, so the conversation is grounded in that single paper and answers
// stay cheap (only the Q&A grows, the paper is the stable prefix).
//
// Like the other tools, this reuses the shared preference helpers, credential
// resolver, text extractor and HTTP client on AISummarizer — it never touches
// the network or the prefs directly, so all tools stay consistent. The panel is
// raw HTML built with createElementNS (the toolkit does not use ztoolkit), and
// every bit of model output is escaped/sanitized before it reaches the DOM.

ZoteroChat = {
	id: null,
	version: null,
	rootURI: null,
	addedElementIDs: [],

	// IDs are unique per window; the panel + its <style> live on documentElement.
	CONTAINER_ID: "ai-toolkit-chat",
	STYLE_ID: "ai-toolkit-chat-style",
	MENUITEM_ID: "ai-toolkit-chat-menuitem",
	XHTML: "http://www.w3.org/1999/xhtml",
	NOTE_TAG: "ai-chat",

	// One open panel per window, keyed by window so multi-window stays isolated.
	_panels: new Map(),

	init({ id, version, rootURI }) {
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
		Zotero.AIChat = this;

		// The grounding instruction. Overridable via the chatSystemPrompt pref;
		// the paper itself is appended by buildSystemPrompt under "=== PAPER ===".
		this.DEFAULT_SYSTEM_PROMPT = [
			"You are a careful research assistant helping a scholar understand a single academic paper they are reading in Zotero. Answer their questions using ONLY the paper provided below under \"=== PAPER ===\".",
			"",
			"- Ground every claim in the paper's own text. Do not add outside facts, and never invent findings, numbers, citations, or quotes.",
			"- If the paper does not contain the answer, say so plainly (e.g. \"The paper doesn't say.\"). If only part of the paper is available (abstract only, or a truncated extract), answer from what is present and note that limitation.",
			"- Be concise and direct. Prefer short paragraphs or bullet points. Quote sparingly, and only verbatim from the paper.",
			"- When a question is ambiguous, briefly state how you read it, then answer.",
		].join("\n");
	},

	// --- UI wiring ---------------------------------------------------------

	addToWindow(window) {
		const doc = window.document;
		const itemmenu = doc.getElementById("zotero-itemmenu");
		if (!itemmenu || doc.getElementById(this.MENUITEM_ID)) return;

		const menuitem = doc.createXULElement("menuitem");
		menuitem.id = this.MENUITEM_ID;
		menuitem.setAttribute("label", "Ask a question (AI)");
		menuitem.addEventListener("command", () => this.run(window));
		itemmenu.appendChild(menuitem);
		if (!this.addedElementIDs.includes(menuitem.id)) this.addedElementIDs.push(menuitem.id);
	},

	removeFromWindow(window) {
		const doc = window.document;
		for (const id of this.addedElementIDs) {
			const elem = doc.getElementById(id);
			if (elem) elem.remove();
		}
		// An open panel must die with the window (also covers shutdown/reload).
		this.destroyPanel(window);
	},

	pickItem(items) {
		if (!items || !items.length) return null;
		for (const it of items) {
			if (it.isRegularItem && it.isRegularItem()) return it;
			if (it.isAttachment && it.isAttachment() && it.parentItemID) {
				return Zotero.Items.get(it.parentItemID);
			}
		}
		return null;
	},

	// --- Main flow ---------------------------------------------------------

	async run(window) {
		const pane = window.ZoteroPane;
		const item = this.pickItem(pane ? pane.getSelectedItems() : []);
		if (!item) {
			window.alert("Zotero AI Toolkit: select a single article to ask about.");
			return;
		}

		// Chat stores its own model pref like every other tool; the provider and
		// API key are inferred + checked by the shared resolver.
		const model = AISummarizer.getModelForTool("chatModel", "claude-sonnet-4-6");
		const creds = AISummarizer._resolveCreds(model);
		if (!creds) return;

		// Pull the paper out once (PDF extraction can be slow → show progress).
		const progress = new Zotero.ProgressWindow({ closeOnClick: true });
		progress.changeHeadline("Ask a question (AI)");
		progress.addDescription("Reading the paper…");
		progress.show();

		let context;
		try {
			const extracted = await AISummarizer._getItemText(item);
			const maxChars = AISummarizer.getIntPref("chatMaxInputChars", 150000);
			let text = "";
			let source = null;
			let truncated = false;
			if (extracted) {
				text = extracted.text;
				source = extracted.source;
				if (text.length > maxChars) {
					text = text.slice(0, maxChars);
					truncated = true;
				}
			}
			context = { item, text, source, truncated };
		}
		catch (e) {
			Zotero.logError(e);
			progress.addDescription("Error reading the paper: " + (e.message || e));
			progress.startCloseTimer(8000);
			return;
		}
		progress.close();

		this.openPanel(window, item, creds, context);
	},

	// --- System prompt -----------------------------------------------------

	buildSystemPrompt(context) {
		const base = (AISummarizer.getPref("chatSystemPrompt") || "").trim() || this.DEFAULT_SYSTEM_PROMPT;
		const item = context.item;

		const meta = [];
		meta.push("Title: " + (item.getField("title") || "Unknown"));
		const creators = item.getCreators()
			.map(c => (c.lastName || c.firstName || "").trim())
			.filter(Boolean);
		meta.push("Authors: " + (creators.slice(0, 8).join(", ") || "Unknown"));
		if (item.getField("date")) meta.push("Date: " + item.getField("date"));
		if (item.getField("publicationTitle")) meta.push("Publication: " + item.getField("publicationTitle"));
		const doi = item.getField("DOI");
		if (doi) meta.push("DOI: " + doi);

		const lines = [base, "", "=== PAPER ===", ...meta, ""];
		if (context.text) {
			lines.push("Full text (source: " + context.source
				+ (context.truncated ? ", truncated to fit the size limit" : "") + "):");
			lines.push('"""');
			lines.push(context.text);
			lines.push('"""');
		}
		else {
			lines.push("(metadata only — no full text or abstract was available for this item)");
		}
		return lines.join("\n");
	},

	// --- Panel -------------------------------------------------------------

	openPanel(window, item, creds, context) {
		// Reopening always starts a fresh chat: tear down any existing panel.
		this.destroyPanel(window);

		const doc = window.document;
		const XHTML = this.XHTML;
		const el = (tag, className) => {
			const node = doc.createElementNS(XHTML, tag);
			if (className) node.className = className;
			return node;
		};

		this._injectStyle(doc);

		// The shared state for this window's conversation.
		const panel = {
			window,
			doc,
			item,
			model: creds.model,
			provider: creds.provider,
			apiKey: creds.apiKey,
			context,
			system: this.buildSystemPrompt(context),
			messages: [], // [{ role: "user"|"assistant", content }]
			busy: false,
			listeners: [],
			focusTimer: null,
		};

		const container = el("div");
		container.id = this.CONTAINER_ID;

		// Header: short title, source/model badge, New chat, Save to note, close.
		const header = el("div", "header");
		const titleText = item.getField("title") || "(untitled)";
		const title = el("div", "title");
		title.textContent = titleText.length > 48 ? titleText.slice(0, 47) + "…" : titleText;
		title.setAttribute("title", titleText);

		const badge = el("div", "badge");
		badge.textContent = (context.source || "metadata only") + " · " + panel.model;

		const newBtn = el("button", "hbtn");
		newBtn.textContent = "New chat";
		newBtn.addEventListener("click", () => this.newChat(panel));

		const saveBtn = el("button", "hbtn");
		saveBtn.textContent = "Save to note";
		saveBtn.addEventListener("click", () => this.saveToNote(panel));

		const closeBtn = el("button", "hbtn close");
		closeBtn.textContent = "×";
		closeBtn.setAttribute("title", "Close");
		closeBtn.addEventListener("click", () => this.destroyPanel(window));

		header.appendChild(title);
		header.appendChild(badge);
		header.appendChild(newBtn);
		header.appendChild(saveBtn);
		header.appendChild(closeBtn);

		// Scrollable transcript (user bubbles right, assistant bubbles left).
		const messagesEl = el("div", "messages");

		// Footer: input + send.
		const footer = el("div", "footer");
		const textarea = el("textarea");
		textarea.setAttribute("rows", "1");
		textarea.setAttribute("placeholder", "Ask about this paper…  (Enter to send, Shift+Enter for a newline)");
		const sendBtn = el("button", "sendbtn");
		sendBtn.textContent = "Send";
		footer.appendChild(textarea);
		footer.appendChild(sendBtn);

		container.appendChild(header);
		container.appendChild(messagesEl);
		container.appendChild(footer);

		// Appended to the <window> root (not inside the XUL flex layout) with
		// position:fixed + high z-index so it floats above #zotero-pane.
		doc.documentElement.appendChild(container);

		panel.container = container;
		panel.messagesEl = messagesEl;
		panel.textarea = textarea;
		panel.sendBtn = sendBtn;

		// Keyboard on the input: Enter sends, Shift+Enter newlines, Esc closes.
		// (A real <textarea> also makes the summarizer's global single-letter
		// shortcut handler skip our typing — it bails on localName "textarea".)
		textarea.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				e.stopPropagation();
				this.sendMessage(panel);
			}
			else if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				this.destroyPanel(window);
			}
		});
		sendBtn.addEventListener("click", () => this.sendMessage(panel));

		// Window-level Esc-to-close while the panel is open (focus may be
		// elsewhere). Tracked so it is removed on teardown — listeners on doc
		// would otherwise leak across plugin reloads.
		const onKey = (e) => {
			if (this._panels.get(window) === panel && e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				this.destroyPanel(window);
			}
		};
		doc.addEventListener("keydown", onKey, true);
		panel.listeners.push({ target: doc, type: "keydown", fn: onKey, capture: true });

		this._panels.set(window, panel);
		this._renderHint(panel);

		// Layout isn't flushed yet right after append → focus on next tick.
		panel.focusTimer = window.setTimeout(() => {
			try { textarea.focus(); }
			catch (e) { /* window may have closed */ }
		}, 0);
	},

	newChat(panel) {
		panel.messages = [];
		this._clearMessages(panel);
		this._renderHint(panel);
		panel.busy = false;
		this._setBusy(panel, false);
		try { panel.textarea.focus(); }
		catch (e) { /* ignore */ }
	},

	destroyPanel(window) {
		const panel = this._panels.get(window);
		if (!panel) return;
		this._panels.delete(window);

		if (panel.focusTimer) {
			try { window.clearTimeout(panel.focusTimer); }
			catch (e) { /* ignore */ }
		}
		for (const l of panel.listeners) {
			try { l.target.removeEventListener(l.type, l.fn, l.capture); }
			catch (e) { /* ignore */ }
		}
		const doc = panel.doc;
		// Idempotent: null-check every node (shutdown + unmount may both call us).
		const container = doc.getElementById(this.CONTAINER_ID);
		if (container) container.remove();
		const style = doc.getElementById(this.STYLE_ID);
		if (style) style.remove();
	},

	// --- Conversation ------------------------------------------------------

	async sendMessage(panel) {
		const text = (panel.textarea.value || "").trim();
		if (!text || panel.busy) return;

		panel.textarea.value = "";
		this._removeHint(panel);
		panel.messages.push({ role: "user", content: text });
		this._appendMessage(panel, "user", text, false);

		panel.busy = true;
		this._setBusy(panel, true);
		const typing = this._appendTyping(panel);

		try {
			const reply = await this._complete(panel);
			typing.remove();
			const answer = reply && reply.text;
			if (!answer || !answer.trim()) {
				this._appendError(panel, "The model returned an empty response.");
			}
			else {
				panel.messages.push({ role: "assistant", content: answer });
				this._appendMessage(panel, "assistant", answer, true);
				if (reply.truncated) {
					this._appendNote(panel, "Response was cut off at the length limit — ask to continue for the rest.");
				}
			}
		}
		catch (e) {
			Zotero.logError(e);
			typing.remove();
			this._appendError(panel, AISummarizer._shortError(e));
		}
		finally {
			panel.busy = false;
			this._setBusy(panel, false);
			try { panel.textarea.focus(); }
			catch (e) { /* ignore */ }
		}
	},

	// Dispatch to the right provider. Both build a multi-turn request on the
	// shared _post: the paper rides in the system prompt, only the Q&A turns
	// (panel.messages) go in the messages array.
	_complete(panel) {
		return panel.provider === "openai"
			? this._callChatOpenAI(panel)
			: this._callChatAnthropic(panel);
	},

	async _callChatAnthropic(panel) {
		const body = {
			model: panel.model,
			max_tokens: AISummarizer.getIntPref("chatMaxOutputTokens", 4096),
			system: panel.system,
			messages: panel.messages.map(m => ({ role: m.role, content: m.content })),
		};
		// Adaptive thinking only for models that support it (the text filter
		// below drops any thinking blocks regardless).
		if (AISummarizer._supportsAdaptiveThinking(panel.model)) {
			body.thinking = { type: "adaptive" };
		}

		const data = await AISummarizer._post(AISummarizer.ANTHROPIC_URL, {
			"Content-Type": "application/json",
			"x-api-key": panel.apiKey,
			"anthropic-version": "2023-06-01",
		}, body);

		if (data.stop_reason === "refusal") {
			const why = data.stop_details && data.stop_details.explanation;
			throw new Error("the model declined to answer" + (why ? " (" + why + ")" : ""));
		}
		const text = (data.content || [])
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join("\n");
		return { text, truncated: data.stop_reason === "max_tokens" };
	},

	async _callChatOpenAI(panel) {
		const body = {
			model: panel.model,
			max_completion_tokens: AISummarizer.getIntPref("chatMaxOutputTokens", 4096),
			messages: [{ role: "system", content: panel.system }]
				.concat(panel.messages.map(m => ({ role: m.role, content: m.content }))),
		};

		const data = await AISummarizer._post(AISummarizer.OPENAI_URL, {
			"Content-Type": "application/json",
			"Authorization": "Bearer " + panel.apiKey,
		}, body);

		const choice = data.choices && data.choices[0];
		if (choice && choice.finish_reason === "content_filter") {
			throw new Error("the response was blocked by the provider's content filter");
		}
		const text = (choice && choice.message && choice.message.content) || "";
		return { text, truncated: !!(choice && choice.finish_reason === "length") };
	},

	// --- Save transcript ---------------------------------------------------

	async saveToNote(panel) {
		if (!panel.messages.length) {
			AISummarizer._notify("AI Toolkit", "Nothing to save yet — ask a question first.");
			return;
		}

		const item = panel.item;
		const esc = s => Zotero.Utilities.htmlSpecialChars(s);
		const title = item.getField("title") || "(untitled)";
		const when = new Date().toLocaleString();
		const sourceNote = panel.context.source || "metadata only";

		const parts = [
			"<h1>AI Chat: " + esc(title) + "</h1>",
			"<p><em>Generated " + esc(when)
				+ " · " + esc(AISummarizer._providerLabel(panel.provider))
				+ " · " + esc(panel.model)
				+ " · based on " + esc(sourceNote)
				+ (panel.context.truncated ? " (input truncated)" : "")
				+ "</em></p>",
		];
		for (const m of panel.messages) {
			parts.push("<p><strong>" + (m.role === "user" ? "You" : "Assistant") + ":</strong></p>");
			// renderMarkdownLite escapes first, so this is safe HTML; sanitize is
			// belt-and-braces before the note is persisted.
			parts.push(this.renderMarkdownLite(m.content));
		}

		const html = AISummarizer._sanitizeHtml(parts.join("\n"));
		const note = new Zotero.Item("note");
		note.libraryID = item.libraryID;
		note.parentItemID = item.id;
		note.setNote(html);
		note.addTag(this.NOTE_TAG);
		try {
			await note.saveTx();
			AISummarizer._notify("AI Toolkit", "Saved the chat as a note on “" + title + "”.");
		}
		catch (e) {
			Zotero.logError(e);
			AISummarizer._notify("AI Toolkit", "Could not save the note: " + AISummarizer._shortError(e));
		}
	},

	// --- Rendering helpers -------------------------------------------------

	/**
	 * Turns model text into a tiny, SAFE subset of HTML. Everything is escaped
	 * with htmlSpecialChars FIRST, so the only tags in the result are the ones
	 * we add here (paragraphs, <br/>, bullets, bold/italic, inline code). Raw
	 * model text never reaches innerHTML un-escaped.
	 */
	renderMarkdownLite(text) {
		const esc = Zotero.Utilities.htmlSpecialChars(String(text == null ? "" : text).trim());
		const inline = (s) => s
			.replace(/`([^`]+)`/g, "<code>$1</code>")
			.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
			.replace(/\*([^*]+)\*/g, "<em>$1</em>");

		const blocks = esc.split(/\n{2,}/).filter(b => b.trim() !== "");
		const out = [];
		for (const block of blocks) {
			const lines = block.split("\n");
			const isList = lines.length > 0 && lines.every(l => /^\s*-\s+/.test(l));
			if (isList) {
				out.push("<ul>" + lines
					.map(l => "<li>" + inline(l.replace(/^\s*-\s+/, "")) + "</li>")
					.join("") + "</ul>");
			}
			else {
				out.push("<p>" + inline(block).replace(/\n/g, "<br/>") + "</p>");
			}
		}
		return out.join("");
	},

	_appendMessage(panel, role, content, markdown) {
		const doc = panel.doc;
		const row = doc.createElementNS(this.XHTML, "div");
		row.className = "row " + role;
		const bubble = doc.createElementNS(this.XHTML, "div");
		bubble.className = "bubble";
		if (markdown) {
			bubble.innerHTML = this.renderMarkdownLite(content); // escaped inside
		}
		else {
			bubble.textContent = content; // untrusted/user text → never innerHTML
		}
		row.appendChild(bubble);
		panel.messagesEl.appendChild(row);
		this._scrollToBottom(panel);
		return bubble;
	},

	_appendTyping(panel) {
		const doc = panel.doc;
		const row = doc.createElementNS(this.XHTML, "div");
		row.className = "row assistant";
		const bubble = doc.createElementNS(this.XHTML, "div");
		bubble.className = "bubble typing";
		bubble.textContent = "Thinking…";
		row.appendChild(bubble);
		panel.messagesEl.appendChild(row);
		this._scrollToBottom(panel);
		return row;
	},

	_appendError(panel, message) {
		const doc = panel.doc;
		const row = doc.createElementNS(this.XHTML, "div");
		row.className = "row assistant";
		const bubble = doc.createElementNS(this.XHTML, "div");
		bubble.className = "bubble error";
		bubble.textContent = "Error: " + message;
		row.appendChild(bubble);
		panel.messagesEl.appendChild(row);
		this._scrollToBottom(panel);
	},

	_appendNote(panel, message) {
		const doc = panel.doc;
		const row = doc.createElementNS(this.XHTML, "div");
		row.className = "row note";
		const span = doc.createElementNS(this.XHTML, "div");
		span.className = "note-text";
		span.textContent = message;
		row.appendChild(span);
		panel.messagesEl.appendChild(row);
		this._scrollToBottom(panel);
	},

	_renderHint(panel) {
		const doc = panel.doc;
		const row = doc.createElementNS(this.XHTML, "div");
		row.className = "row note hint";
		const span = doc.createElementNS(this.XHTML, "div");
		span.className = "note-text";
		span.textContent = panel.context.text
			? "Ask anything about this paper. Answers are grounded only in its text."
			: "No full text or abstract was found, so answers rely on the metadata only.";
		row.appendChild(span);
		panel.messagesEl.appendChild(row);
	},

	_removeHint(panel) {
		const hint = panel.messagesEl.querySelector(".row.hint");
		if (hint) hint.remove();
	},

	_clearMessages(panel) {
		while (panel.messagesEl.firstChild) {
			panel.messagesEl.firstChild.remove();
		}
	},

	_setBusy(panel, busy) {
		panel.sendBtn.disabled = busy;
		panel.textarea.disabled = busy;
	},

	_scrollToBottom(panel) {
		panel.messagesEl.scrollTop = panel.messagesEl.scrollHeight;
	},

	// --- Styling -----------------------------------------------------------

	_injectStyle(doc) {
		if (doc.getElementById(this.STYLE_ID)) return;
		const style = doc.createElementNS(this.XHTML, "style");
		style.id = this.STYLE_ID;
		style.textContent = this._css();
		doc.documentElement.appendChild(style);
	},

	// Colors are driven by prefers-color-scheme (which Zotero 7 updates to match
	// its own light/dark setting); everything is scoped under #ai-toolkit-chat so
	// nothing leaks into Zotero's own widgets.
	_css() {
		return [
			"#ai-toolkit-chat {",
			"  position: fixed; top: 0; right: 0; bottom: 0; width: 380px; z-index: 9999;",
			"  display: flex; flex-direction: column;",
			"  color-scheme: light dark;",
			"  background: #ffffff; color: #1a1a1a;",
			"  border-left: 1px solid rgba(0,0,0,.15);",
			"  box-shadow: -2px 0 12px rgba(0,0,0,.12);",
			"  font: 13px/1.5 -apple-system, system-ui, sans-serif;",
			"}",
			"@media (prefers-color-scheme: dark) {",
			"  #ai-toolkit-chat { background: #2b2a33; color: #f0f0f4; border-left-color: rgba(255,255,255,.15); }",
			"}",
			"#ai-toolkit-chat .header {",
			"  display: flex; align-items: center; gap: 6px; padding: 8px 10px;",
			"  border-bottom: 1px solid rgba(127,127,127,.25);",
			"}",
			"#ai-toolkit-chat .header .title {",
			"  font-weight: 600; flex: 1 1 auto; min-width: 0;",
			"  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;",
			"}",
			"#ai-toolkit-chat .badge { font-size: 11px; opacity: .7; white-space: nowrap; }",
			"#ai-toolkit-chat .hbtn {",
			"  font: inherit; font-size: 12px; cursor: pointer;",
			"  background: transparent; color: inherit;",
			"  border: 1px solid rgba(127,127,127,.4); border-radius: 6px; padding: 2px 8px;",
			"}",
			"#ai-toolkit-chat .hbtn:hover { background: rgba(127,127,127,.15); }",
			"#ai-toolkit-chat .hbtn.close { border: none; font-size: 18px; line-height: 1; padding: 0 6px; }",
			"#ai-toolkit-chat .messages {",
			"  flex: 1 1 auto; overflow-y: auto; padding: 10px;",
			"  display: flex; flex-direction: column; gap: 8px;",
			"}",
			"#ai-toolkit-chat .row { display: flex; }",
			"#ai-toolkit-chat .row.user { justify-content: flex-end; }",
			"#ai-toolkit-chat .row.assistant { justify-content: flex-start; }",
			"#ai-toolkit-chat .row.note { justify-content: center; }",
			"#ai-toolkit-chat .note-text { font-size: 12px; opacity: .65; font-style: italic; text-align: center; max-width: 90%; }",
			"#ai-toolkit-chat .bubble {",
			"  max-width: 85%; padding: 7px 10px; border-radius: 12px;",
			"  overflow-wrap: anywhere; white-space: normal;",
			"}",
			"#ai-toolkit-chat .row.user .bubble { background: #2ea8e5; color: #ffffff; border-bottom-right-radius: 3px; }",
			"#ai-toolkit-chat .row.assistant .bubble { background: rgba(127,127,127,.16); border-bottom-left-radius: 3px; }",
			"#ai-toolkit-chat .bubble.typing { opacity: .7; font-style: italic; }",
			"#ai-toolkit-chat .bubble.error { background: rgba(220,60,60,.18); color: #c0392b; }",
			"#ai-toolkit-chat .bubble p { margin: 0 0 6px; }",
			"#ai-toolkit-chat .bubble p:last-child { margin-bottom: 0; }",
			"#ai-toolkit-chat .bubble ul { margin: 0 0 6px; padding-left: 18px; }",
			"#ai-toolkit-chat .bubble code {",
			"  font-family: ui-monospace, monospace; font-size: .92em;",
			"  background: rgba(127,127,127,.22); padding: 0 3px; border-radius: 3px;",
			"}",
			"#ai-toolkit-chat .footer {",
			"  display: flex; gap: 6px; padding: 8px 10px;",
			"  border-top: 1px solid rgba(127,127,127,.25);",
			"}",
			"#ai-toolkit-chat .footer textarea {",
			"  flex: 1 1 auto; resize: none; min-height: 38px; max-height: 120px;",
			"  font: inherit; color: inherit; background: transparent;",
			"  border: 1px solid rgba(127,127,127,.4); border-radius: 8px; padding: 6px 8px;",
			"}",
			"#ai-toolkit-chat .footer textarea:disabled { opacity: .6; }",
			"#ai-toolkit-chat .sendbtn {",
			"  font: inherit; cursor: pointer; align-self: stretch;",
			"  background: #2ea8e5; color: #ffffff; border: none; border-radius: 8px; padding: 0 14px;",
			"}",
			"#ai-toolkit-chat .sendbtn:disabled { opacity: .5; cursor: default; }",
		].join("\n");
	},
};
