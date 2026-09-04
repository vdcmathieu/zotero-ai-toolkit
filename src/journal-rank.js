/* eslint-disable no-undef */
// "Journal rank" column for Zotero AI Toolkit.
//
// Adds an item-tree column that grades the journal each item was published
// in, so a library or a literature sweep can be scanned by venue quality:
//
//   green   FT50          - one of the Financial Times 50 journals
//   yellow  A             - rated A* or A in the ABDC Journal Quality List
//                           (plus any journal the user adds in the settings)
//   orange  IF > 10       - impact factor above the threshold (default 10)
//   red     Other         - a journal on none of the lists
//   grey    ?             - impact factor not known yet (lookup pending/failed)
//   blank                 - the item has no journal (book, report, thesis...)
//
// FT50 and ABDC membership come from the bundled lists in src/journal-lists.js
// and are matched by ISSN first, then by normalised journal name. The impact
// factor is Clarivate's proprietary number, so the column uses the closest open
// equivalent: OpenAlex's two-year mean citedness for the journal (same recipe
// as the JIF, computed over OpenAlex's corpus). Lookups happen lazily as rows
// are rendered, are cached on disk in the Zotero data directory, and never
// send anything but the journal name / ISSN to OpenAlex.
//
// No AI model is involved: this feature is deterministic and free.

ZoteroJournalRank = {
	id: null,
	version: null,
	rootURI: null,

	DATA_KEY: "journalRank",
	OPENALEX_URL: "https://api.openalex.org/sources",
	CACHE_FILE: "journal-rank-cache.json",
	CACHE_TTL_MS: 90 * 24 * 60 * 60 * 1000, // re-check a journal's citedness every 90 days
	MISS_TTL_MS: 14 * 24 * 60 * 60 * 1000, // retry journals OpenAlex did not know after 14 days
	LOOKUP_GAP_MS: 150, // stay far below OpenAlex's 10 req/s polite limit

	// Tier definitions. `rank` is the sort key prefix so that sorting the
	// column groups rows FT50 → A → IF → Other → unknown.
	TIERS: {
		FT50: { rank: "1", label: "FT50", bg: "#2e7d32", fg: "#ffffff" },
		A: { rank: "2", label: "A", bg: "#f5c518", fg: "#1a1a1a" },
		IF: { rank: "3", label: "IF > 10", bg: "#ef6c00", fg: "#ffffff" },
		OTHER: { rank: "4", label: "Other", bg: "#c62828", fg: "#ffffff" },
		UNKNOWN: { rank: "5", label: "?", bg: "#9e9e9e", fg: "#ffffff" },
	},

	_registeredKey: null,
	_ft50ByIssn: new Map(),
	_ft50ByName: new Map(),
	_abdcByIssn: new Map(),
	_abdcByName: new Map(),
	_extraA: { raw: null, names: new Set(), issns: new Set() },

	_cache: {}, // journal key -> { citedness, name, issn, found, ts }
	_cacheLoaded: false,
	_cachePath: null,
	_saveTimer: null,

	_detailByItem: new Map(), // item id -> { tier, detail } for the cell tooltip
	_itemsByKey: new Map(), // journal key -> Set(item id) to refresh after a lookup
	_queue: [], // pending lookups: { key, name, issn }
	_queued: new Set(),
	_failed: new Map(), // key -> timestamp of a failed (network) lookup, retried after 1h
	_draining: false,

	// --- Lifecycle ---------------------------------------------------------

	init({ id, version, rootURI }) {
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
		Zotero.AIJournalRank = this;

		this._buildIndexes();
		this._cachePath = PathUtils.join(Zotero.DataDirectory.dir, "zotero-ai-toolkit", this.CACHE_FILE);
		this._loadCache().catch(e => Zotero.logError(e));

		this._registeredKey = Zotero.ItemTreeManager.registerColumn({
			dataKey: this.DATA_KEY,
			label: "Journal rank",
			pluginID: id,
			enabledTreeIDs: ["main"],
			flex: 0,
			width: "90",
			staticWidth: true,
			minWidth: 60,
			zoteroPersist: ["width", "hidden", "sortDirection"],
			dataProvider: (item, dataKey) => this.dataProvider(item, dataKey),
			renderCell: function (index, data, column, isFirstColumn, doc) {
				// `this` is the item tree (Zotero applies renderCell on it).
				return ZoteroJournalRank.renderCell(this, index, data, column, doc);
			},
		});
	},

	shutdown() {
		if (this._registeredKey) {
			try { Zotero.ItemTreeManager.unregisterColumn(this._registeredKey); }
			catch (e) { Zotero.logError(e); }
			this._registeredKey = null;
		}
		if (this._saveTimer) {
			clearTimeout(this._saveTimer);
			this._saveTimer = null;
			this._saveCache().catch(e => Zotero.logError(e));
		}
		if (Zotero.AIJournalRank === this) delete Zotero.AIJournalRank;
	},

	// Nothing is added per window: the column lives in the item tree.
	addToWindow() {},
	removeFromWindow() {},

	// --- Bundled lists -----------------------------------------------------

	_buildIndexes() {
		const lists = (typeof ZoteroJournalLists !== "undefined" && ZoteroJournalLists) || {};
		for (const j of lists.FT50 || []) {
			for (const issn of j.issn || []) this._ft50ByIssn.set(this.normIssn(issn), j);
			this._ft50ByName.set(this.normName(j.name), j);
			for (const alias of j.aliases || []) this._ft50ByName.set(this.normName(alias), j);
		}
		for (const j of lists.ABDC_A || []) {
			for (const issn of j.issn || []) this._abdcByIssn.set(this.normIssn(issn), j);
			// Keep the first (A*) entry if two ABDC rows normalise to one name.
			const key = this.normName(j.name);
			if (!this._abdcByName.has(key)) this._abdcByName.set(key, j);
		}
	},

	/** Journal names normalised for matching: case, "&", "The", punctuation, "(US)" suffixes. */
	normName(name) {
		return String(name == null ? "" : name)
			.toLowerCase()
			.replace(/&/g, " and ")
			.replace(/\s*\([^)]*\)\s*$/, "")
			.replace(/^the\s+/, "")
			.replace(/[^a-z0-9]+/g, " ")
			.trim()
			.replace(/\s+/g, " ");
	},

	normIssn(issn) {
		const s = String(issn == null ? "" : issn).toUpperCase().replace(/[^0-9X]/g, "");
		return s.length === 8 ? s.slice(0, 4) + "-" + s.slice(4) : "";
	},

	/** Every ISSN on the item (the field can hold several, comma/space separated). */
	_itemIssns(item) {
		let raw = "";
		try { raw = item.getField("ISSN") || ""; }
		catch (e) { return []; }
		return raw.split(/[\s,;]+/).map(s => this.normIssn(s)).filter(Boolean);
	},

	/** User-added A journals from the settings, one name or ISSN per line. */
	_userAList() {
		const raw = String(AISummarizer.getPref("journalRankExtraA") || "");
		if (raw !== this._extraA.raw) {
			const names = new Set();
			const issns = new Set();
			for (const line of raw.split("\n")) {
				const s = line.trim();
				if (!s || s.startsWith("#")) continue;
				const issn = this.normIssn(s);
				if (issn && /^[0-9]{4}-?[0-9]{3}[0-9X]$/i.test(s)) issns.add(issn);
				else names.add(this.normName(s));
			}
			this._extraA = { raw, names, issns };
		}
		return this._extraA;
	},

	_threshold() {
		const n = parseFloat(AISummarizer.getPref("journalRankIfThreshold"));
		return Number.isFinite(n) && n > 0 ? n : 10;
	},

	// --- Classification ----------------------------------------------------

	/**
	 * Grades one item. Returns { tier, detail, key } where tier is a TIERS key
	 * or null for items without a journal, and detail is the tooltip text.
	 */
	classify(item) {
		let journal = "";
		try { journal = (item.getField("publicationTitle") || "").trim(); }
		catch (e) { journal = ""; }
		const issns = this._itemIssns(item);
		if (!journal && !issns.length) return { tier: null, detail: "", key: null };

		const name = this.normName(journal);
		const key = issns[0] || ("name:" + name);

		for (const issn of issns) {
			const j = this._ft50ByIssn.get(issn);
			if (j) return { tier: "FT50", detail: "FT50 · " + j.name, key };
		}
		if (name && this._ft50ByName.has(name)) {
			return { tier: "FT50", detail: "FT50 · " + this._ft50ByName.get(name).name, key };
		}

		const extra = this._userAList();
		for (const issn of issns) {
			if (extra.issns.has(issn)) return { tier: "A", detail: "A journal (your list) · " + (journal || issn), key };
			const j = this._abdcByIssn.get(issn);
			if (j) return { tier: "A", detail: "ABDC 2022 " + j.rating + " · " + j.name, key };
		}
		if (name && extra.names.has(name)) {
			return { tier: "A", detail: "A journal (your list) · " + journal, key };
		}
		if (name && this._abdcByName.has(name)) {
			const j = this._abdcByName.get(name);
			return { tier: "A", detail: "ABDC 2022 " + j.rating + " · " + j.name, key };
		}

		// Not on a list: decide on the impact-factor proxy.
		const threshold = this._threshold();
		const entry = this._cache[key];
		if (entry && entry.found && typeof entry.citedness === "number") {
			const cited = entry.citedness.toFixed(1);
			const src = "2-yr mean citedness " + cited + " (OpenAlex, " + (entry.name || journal) + ")";
			if (entry.citedness > threshold) {
				return { tier: "IF", detail: "Impact factor above " + threshold + " · " + src, key };
			}
			return { tier: "OTHER", detail: "Not FT50 / ABDC A · " + src, key };
		}
		if (entry && !entry.found) {
			return { tier: "OTHER", detail: "Not FT50 / ABDC A · journal not found on OpenAlex", key };
		}
		return { tier: "UNKNOWN", detail: "Impact factor not looked up yet", key };
	},

	dataProvider(item, _dataKey) {
		try {
			if (!item || !item.isRegularItem || !item.isRegularItem()) return "";
			const res = this.classify(item);
			this._detailByItem.set(item.id, res);
			if (!res.tier) return "";
			if (res.tier === "UNKNOWN") this._enqueueLookup(res.key, item);
			const tier = this.TIERS[res.tier];
			return tier.rank + " " + tier.label;
		}
		catch (e) {
			Zotero.logError(e);
			return "";
		}
	},

	renderCell(tree, index, data, column, doc) {
		const cell = doc.createElement("span");
		cell.className = "cell " + column.className;
		if (!data) return cell;

		const code = data.charAt(0);
		const tierKey = Object.keys(this.TIERS).find(k => this.TIERS[k].rank === code);
		const tier = tierKey && this.TIERS[tierKey];
		if (!tier) {
			cell.textContent = data;
			return cell;
		}

		const pill = doc.createElement("span");
		pill.textContent = tier.label;
		pill.style.cssText = "display:inline-block;padding:0 7px;border-radius:9px;line-height:16px;"
			+ "font-size:11px;font-weight:600;letter-spacing:0.02em;white-space:nowrap;"
			+ "background:" + tier.bg + ";color:" + tier.fg + ";";
		cell.appendChild(pill);

		try {
			const row = tree && tree.getRow && tree.getRow(index);
			const item = row && row.ref;
			const res = item && this._detailByItem.get(item.id);
			if (res && res.detail) cell.title = res.detail;
		}
		catch (e) { /* tooltip only */ }
		return cell;
	},

	// --- Impact-factor lookups (OpenAlex) ----------------------------------

	_enqueueLookup(key, item) {
		if (!key) return;
		let set = this._itemsByKey.get(key);
		if (!set) {
			set = new Set();
			this._itemsByKey.set(key, set);
		}
		set.add(item.id);

		if (!this._cacheLoaded) return; // dataProvider runs again once the cache is in
		if (AISummarizer.getPref("journalRankLookup") === false) return;
		if (this._queued.has(key)) return;
		const failedAt = this._failed.get(key);
		if (failedAt && Date.now() - failedAt < 60 * 60 * 1000) return;

		let name = "";
		try { name = (item.getField("publicationTitle") || "").trim(); }
		catch (e) { name = ""; }
		this._queued.add(key);
		this._queue.push({ key, name, issn: this._itemIssns(item)[0] || "" });
		this._drainQueue();
	},

	async _drainQueue() {
		if (this._draining) return;
		this._draining = true;
		try {
			while (this._queue.length) {
				const job = this._queue.shift();
				let entry = null;
				try {
					entry = await this._lookup(job.name, job.issn);
				}
				catch (e) {
					Zotero.debug("Zotero AI Toolkit: journal lookup failed for " + (job.issn || job.name) + ": " + e);
					this._failed.set(job.key, Date.now());
				}
				this._queued.delete(job.key);
				if (entry) {
					this._cache[job.key] = entry;
					this._scheduleSave();
				}
				this._refreshItems(job.key);
				await Zotero.Promise.delay(this.LOOKUP_GAP_MS);
			}
		}
		finally {
			this._draining = false;
		}
	},

	/**
	 * Resolves a journal on OpenAlex: by ISSN when there is one, otherwise by a
	 * name search accepted only when a result's name matches after
	 * normalisation. Returns a cache entry ({found:false} when unknown).
	 */
	async _lookup(name, issn) {
		const select = "display_name,issn_l,issn,summary_stats,type";
		let results = [];
		if (issn) {
			results = await this._getSources("filter=issn:" + encodeURIComponent(issn) + "&select=" + select);
		}
		let match = results[0] || null;
		if (!match && name) {
			results = await this._getSources("search=" + encodeURIComponent(name) + "&per-page=5&select=" + select);
			const want = this.normName(name);
			match = results.find(r => this.normName(r.display_name) === want)
				|| results.find(r => (r.issn || []).some(i => this.normIssn(i) === issn) && issn)
				|| null;
		}
		if (!match) return { found: false, ts: Date.now() };
		const stats = match.summary_stats || {};
		const cited = stats["2yr_mean_citedness"];
		return {
			found: true,
			citedness: typeof cited === "number" ? cited : null,
			name: match.display_name || name,
			issn: match.issn_l || issn || "",
			ts: Date.now(),
		};
	},

	async _getSources(query) {
		const xhr = await Zotero.HTTP.request("GET", this.OPENALEX_URL + "?" + query, {
			responseType: "json",
			timeout: 20000,
		});
		const data = xhr.response || {};
		return Array.isArray(data.results) ? data.results : [];
	},

	/** Clears the row cache of every item filed under this journal so the cell re-renders. */
	_refreshItems(key) {
		const set = this._itemsByKey.get(key);
		if (!set || !set.size) return;
		const ids = [...set];
		this._itemsByKey.delete(key);
		try {
			Zotero.Notifier.trigger("refresh", "item", ids);
		}
		catch (e) {
			Zotero.logError(e);
		}
	},

	_refreshAll() {
		const ids = [...this._detailByItem.keys()];
		this._detailByItem.clear();
		this._itemsByKey.clear();
		if (ids.length) {
			try { Zotero.Notifier.trigger("refresh", "item", ids); }
			catch (e) { Zotero.logError(e); }
		}
	},

	// --- Disk cache --------------------------------------------------------

	async _loadCache() {
		try {
			if (await IOUtils.exists(this._cachePath)) {
				const raw = await Zotero.File.getContentsAsync(this._cachePath);
				const parsed = JSON.parse(raw);
				if (parsed && typeof parsed === "object" && parsed.entries) {
					const now = Date.now();
					for (const [key, entry] of Object.entries(parsed.entries)) {
						if (!entry || typeof entry.ts !== "number") continue;
						const ttl = entry.found ? this.CACHE_TTL_MS : this.MISS_TTL_MS;
						if (now - entry.ts < ttl) this._cache[key] = entry;
					}
				}
			}
		}
		catch (e) {
			Zotero.debug("Zotero AI Toolkit: could not read journal rank cache: " + e);
		}
		finally {
			this._cacheLoaded = true;
			// Rows rendered before the cache was ready are re-graded now.
			this._refreshAll();
		}
	},

	_scheduleSave() {
		if (this._saveTimer) return;
		this._saveTimer = setTimeout(() => {
			this._saveTimer = null;
			this._saveCache().catch(e => Zotero.logError(e));
		}, 2000);
	},

	async _saveCache() {
		await Zotero.File.createDirectoryIfMissingAsync(PathUtils.parent(this._cachePath));
		await Zotero.File.putContentsAsync(this._cachePath, JSON.stringify({
			version: 1,
			source: "OpenAlex sources API, summary_stats.2yr_mean_citedness",
			entries: this._cache,
		}));
	},

	/** Settings-pane action: forget every looked-up impact factor and re-query. */
	async clearCache() {
		this._cache = {};
		this._failed.clear();
		this._queue = [];
		this._queued.clear();
		try {
			if (await IOUtils.exists(this._cachePath)) await IOUtils.remove(this._cachePath);
		}
		catch (e) {
			Zotero.logError(e);
		}
		this._refreshAll();
	},

	/** Settings-pane action: re-grade every row (after editing the A list or threshold). */
	refresh() {
		this._refreshAll();
	},
};
