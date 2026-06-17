/* eslint-disable no-undef */
// "Suggest folder" feature for Zotero AI Toolkit.
//
// Right-click a paper (or press the shortcut) → the model reads the paper,
// looks at the collections (folders) that already exist in the library, and
// recommends where to file it: either an existing folder or a brand-new one
// (shown with a [CREATE] tag). The recommendation appears in a popup; from
// there the user can file/move the paper into the recommended folder.
//
// It reuses the shared preference helpers and API clients on AISummarizer and
// the JSON parser on ZoteroExpandAI, so all three tools stay consistent.

ZoteroSort = {
	id: null,
	version: null,
	rootURI: null,
	addedElementIDs: [],

	init({ id, version, rootURI }) {
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
	},

	// --- UI wiring ---------------------------------------------------------

	addToWindow(window) {
		const doc = window.document;
		const itemmenu = doc.getElementById("zotero-itemmenu");
		if (!itemmenu || doc.getElementById("ai-toolkit-sort-menuitem")) return;

		const menuitem = doc.createXULElement("menuitem");
		menuitem.id = "ai-toolkit-sort-menuitem";
		menuitem.setAttribute("label", "Suggest folder (AI)");
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
	},

	// --- Main flow ---------------------------------------------------------

	async run(window) {
		const pane = window.ZoteroPane;
		const item = this.pickItem(pane.getSelectedItems());
		if (!item) {
			window.alert("Zotero AI Toolkit: select a single article to find a folder for.");
			return;
		}

		const model = AISummarizer.getPref("sortModel") || "claude-sonnet-4-6";
		const provider = AISummarizer.providerForModel(model);
		const apiKey = AISummarizer.getApiKey(provider);
		if (!apiKey) {
			window.alert(
				"Zotero AI Toolkit: no API key set.\n\n"
				+ "Suggest folder is set to use " + model + ", so open\n"
				+ "Settings → AI Toolkit and paste your "
				+ (provider === "openai" ? "OpenAI (GPT)" : "Anthropic (Claude)")
				+ " API key."
			);
			return;
		}

		// The collection the user is currently browsing is treated as the
		// source ("To sort"); a successful file moves the paper out of it.
		const source = (pane.getSelectedCollection && pane.getSelectedCollection()) || null;
		const folders = this.getCollections(item.libraryID);

		const progress = new Zotero.ProgressWindow({ closeOnClick: true });
		progress.changeHeadline("Suggest folder");
		progress.addDescription("Reading the paper and your folders…");
		progress.show();

		try {
			const extracted = await AISummarizer._getItemText(item);
			const text = extracted ? extracted.text.slice(0, 8000) : "";
			const systemPrompt = this.buildSystemPrompt();
			const userContent = this.buildUserContent(item, text, folders, source);

			const raw = provider === "openai"
				? await AISummarizer._callOpenAI(apiKey, model, systemPrompt, userContent)
				: await AISummarizer._callAnthropic(apiKey, model, systemPrompt, userContent);

			const rec = ZoteroExpandAI.parseResult(raw);
			progress.close();
			await this.present(window, item, rec, folders, source);
		}
		catch (e) {
			Zotero.logError(e);
			progress.addDescription("Error: " + (e.message || e));
			progress.startCloseTimer(8000);
		}
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

	// --- Collections -------------------------------------------------------

	/** Returns {entries:[{collection, path, depth}], byNormPath:Map, pathById:Map}. */
	getCollections(libraryID) {
		const all = Zotero.Collections.getByLibrary(libraryID, true) || [];
		const byId = new Map(all.map(c => [c.id, c]));
		const pathOf = (c) => {
			const parts = [];
			const seen = new Set();
			let cur = c;
			while (cur && !seen.has(cur.id)) {
				seen.add(cur.id);
				parts.unshift(cur.name);
				cur = cur.parentID ? byId.get(cur.parentID) : null;
			}
			return parts.join(" / ");
		};

		const entries = all.map((c) => {
			const path = pathOf(c);
			return { collection: c, path, depth: path.split(" / ").length - 1 };
		});
		entries.sort((a, b) => a.path.localeCompare(b.path));

		const byNormPath = new Map();
		const pathById = new Map();
		for (const e of entries) {
			byNormPath.set(this.normPath(e.path), e.collection);
			pathById.set(e.collection.id, e.path);
		}
		return { entries, byNormPath, pathById };
	},

	normPath(p) {
		return String(p == null ? "" : p)
			.split("/")
			.map(s => s.trim().toLowerCase())
			.filter(Boolean)
			.join(" / ");
	},

	// --- Prompt ------------------------------------------------------------

	buildSystemPrompt() {
		return [
			"You are an academic librarian who files papers into the right folder of a Zotero library.",
			"",
			"You are given a paper and the list of folders (collections) that already exist, as",
			"hierarchical paths and the ability to create new folder to your liking. Recommend", 
			"the single best destination folder for this paper.",
			"",
			"Rules:",
			"- Strongly prefer an EXISTING folder whenever the paper fits one thematically.",
			"- Only propose creating a NEW folder when no existing folder is a good fit.",
			"- A new folder name should be short, match the naming style of the existing folders,",
			"  and be general enough to hold related future papers (a theme, not this one paper).",
			"- Do not recommend the folder the paper is already filed in.",
			"",
			"Return ONLY a JSON object inside a ```json code block, with this shape:",
			"{",
			'  "existing": true | false,',
			'  "path": "<full path of the existing folder, exactly as listed>",   // when existing=true',
			'  "name": "<new folder name>",                                        // when existing=false',
			'  "parent": "<full path of an existing folder to nest the new one under, or empty>",',
			'  "reason": "<one short sentence>",',
			'  "alternatives": ["<other plausible existing folder path>", "..."]',
			"}",
			"Do not include any prose outside the JSON code block.",
		].join("\n");
	},

	buildUserContent(item, text, folders, source) {
		const lines = [];
		lines.push("Existing folders:");
		if (folders.entries.length) {
			for (const e of folders.entries) lines.push("- " + e.path);
		}
		else {
			lines.push("(none yet — the library has no folders)");
		}
		lines.push("");

		const currentPath = source ? folders.pathById.get(source.id) : null;
		if (currentPath) lines.push("The paper is currently filed in: " + currentPath);
		lines.push("");

		lines.push("Paper:");
		lines.push("Title: " + (item.getField("title") || "Unknown"));
		const creators = item.getCreators()
			.map(c => (c.lastName || c.firstName || "").trim())
			.filter(Boolean);
		lines.push("Authors: " + (creators.slice(0, 6).join(", ") || "Unknown"));
		if (item.getField("date")) lines.push("Date: " + item.getField("date"));
		if (item.getField("publicationTitle")) lines.push("Publication: " + item.getField("publicationTitle"));
		const abstract = (item.getField("abstractNote") || "").trim();
		if (abstract) lines.push("Abstract: " + abstract);
		if (text) {
			lines.push("");
			lines.push("Excerpt:");
			lines.push(text);
		}
		return lines.join("\n");
	},

	// --- Recommendation popup ---------------------------------------------

	async present(window, item, rec, folders, source) {
		let create = rec.existing === false || !!rec.create;
		let target = null;
		if (!create) {
			target = folders.byNormPath.get(this.normPath(rec.path || rec.name || rec.folder));
			if (!target) create = true; // model named a folder we don't have → offer to create it
		}

		let name;
		let parentColl = null;
		let parentDisplay = "";
		if (create) {
			name = String(rec.name || rec.folder || rec.path || "New folder").trim();
			if (name.includes("/")) name = name.split("/").pop().trim();
			if (rec.parent) parentColl = folders.byNormPath.get(this.normPath(rec.parent)) || null;
			// Default: create as a sibling of the source folder (e.g. next to "To sort").
			if (!parentColl && source && source.parentID) {
				parentColl = Zotero.Collections.get(source.parentID) || null;
			}
			parentDisplay = parentColl ? (folders.pathById.get(parentColl.id) || parentColl.name) : "top level";
		}
		else {
			name = target.name;
		}

		// Build the popup text — folder name first, with a CREATE tag when new.
		const msgLines = [];
		msgLines.push("Recommended folder:");
		msgLines.push("");
		msgLines.push("    " + name + (create ? "    [ CREATE ]" : ""));
		msgLines.push("");
		if (rec.reason) msgLines.push(String(rec.reason));
		if (create) {
			msgLines.push("");
			msgLines.push("New folder, created under: " + parentDisplay);
		}
		else if (folders.pathById.get(target.id)) {
			msgLines.push("");
			msgLines.push("Path: " + folders.pathById.get(target.id));
		}
		if (Array.isArray(rec.alternatives) && rec.alternatives.length) {
			msgLines.push("");
			msgLines.push("Other options: " + rec.alternatives.slice(0, 3).join("  ·  "));
		}

		const moving = source && (!target || source.id !== target.id);
		const applyLabel = create
			? "Create & file"
			: (moving ? "Move here" : "File here");

		const ps = Services.prompt;
		const flags = ps.BUTTON_POS_0 * ps.BUTTON_TITLE_IS_STRING
			+ ps.BUTTON_POS_1 * ps.BUTTON_TITLE_IS_STRING;
		const choice = ps.confirmEx(
			window,
			"Suggest folder",
			msgLines.join("\n"),
			flags,
			applyLabel,
			"Cancel",
			null,
			null,
			{ value: false }
		);

		if (choice !== 0) return;

		try {
			const dest = await this.apply(item, { create, target, name, parentColl }, source);
			AISummarizer._notify("AI Toolkit",
				"Filed “" + (item.getField("title") || "item") + "” into " + dest.name + ".");
		}
		catch (e) {
			Zotero.logError(e);
			window.alert("Could not file the paper:\n\n" + (e.message || e));
		}
	},

	async apply(item, plan, source) {
		let dest = plan.target;
		if (plan.create) {
			dest = new Zotero.Collection();
			dest.libraryID = item.libraryID;
			dest.name = plan.name;
			if (plan.parentColl) dest.parentID = plan.parentColl.id;
			await dest.saveTx();
		}

		item.addToCollection(dest.id);
		// Move out of the folder being browsed, if that's a real collection.
		if (source && source.id !== dest.id && typeof item.removeFromCollection === "function") {
			try { item.removeFromCollection(source.id); }
			catch (e) { /* item may not be in the source collection; non-fatal */ }
		}
		await item.saveTx();
		return dest;
	},
};
