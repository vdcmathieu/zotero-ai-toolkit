/* eslint-disable no-undef */
// "Citations" column for Zotero AI Toolkit.
//
// Adds an item-tree column with the number of times each item has been cited,
// so a library or a literature sweep can be sorted by impact:
//
//   1,725   citation count for the item
//   0       the paper is indexed but has no citations yet
//   -       no record found for this item
//   ...     lookup pending
//   blank   nothing to look up (no DOI, no title - notes, attachments...)
//
// Counts come from OpenAlex (`cited_by_count`), with Crossref
// (`is-referenced-by-count`) as a fallback for items OpenAlex does not know.
// Both are free, need no API key, and are matched by DOI first, then PMID,
// then an exact title match. Google Scholar is deliberately not used: it has
// no API, forbids automated queries, and serves a CAPTCHA after a handful of
// them, which would break the user's own Scholar access. Its counts are
// roughly 30-50% higher than OpenAlex's because it also counts theses,
// preprints and other non-indexed sources.
//
// Lookups happen lazily as rows are rendered, are batched 50 DOIs per request,
// are cached on disk in the Zotero data directory, and never send anything but
// the item's identifiers (or title) to OpenAlex / Crossref.
//
// No AI model is involved: this feature is deterministic and free.

ZoteroCitations = {
	id: null,
	version: null,
	rootURI: null,

	DATA_KEY: "citationCount",
	OPENALEX_URL: "https://api.openalex.org/works",
	CROSSREF_URL: "https://api.crossref.org/works/",
	CACHE_FILE: "citation-cache.json",
	CACHE_TTL_MS: 30 * 24 * 60 * 60 * 1000, // counts grow slowly: re-check a paper every 30 days
	MISS_TTL_MS: 14 * 24 * 60 * 60 * 1000, // retry papers no source knew after 14 days
	FAIL_RETRY_MS: 60 * 60 * 1000, // after a network error, wait an hour before retrying
	LOOKUP_GAP_MS: 150, // stay far below OpenAlex's 10 req/s polite limit
	BATCH_SIZE: 50, // OpenAlex accepts 50 OR'd values in one filter
	DRAIN_DELAY_MS: 100, // let a screen of rows queue up before the first request
	SORT_WIDTH: 10, // zero-padded prefix width; the tree sorts cells as strings

	_registeredKey: null,

	_cache: {}, // resolution key -> { found, count, source, title, year, ts }
	_cacheLoaded: false,
	_cachePath: null,
	_saveTimer: null,

	_detailByItem: new Map(), // item id -> tooltip text
	_itemsByKey: new Map(), // resolution key -> Set(item id) to refresh after a lookup
	_queue: [], // pending lookups: { key, doi, pmid, title, year }
	_queued: new Set(),
	_failed: new Map(), // key -> timestamp of a failed (network) lookup
	_draining: false,
	_drainTimer: null,

	// --- Lifecycle ---------------------------------------------------------

	init({ id, version, rootURI }) {
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
		Zotero.AICitations = this;

		this._cachePath = PathUtils.join(Zotero.DataDirectory.dir, "zotero-ai-toolkit", this.CACHE_FILE);
		this._loadCache().catch(e => Zotero.logError(e));

		this._registeredKey = Zotero.ItemTreeManager.registerColumn({
			dataKey: this.DATA_KEY,
			label: "Citations",
			pluginID: id,
			enabledTreeIDs: ["main"],
			flex: 0,
			width: "70",
			staticWidth: true,
			minWidth: 50,
			zoteroPersist: ["width", "hidden", "sortDirection"],
			dataProvider: (item, dataKey) => this.dataProvider(item, dataKey),
			renderCell: function (index, data, column, isFirstColumn, doc) {
				// `this` is the item tree (Zotero applies renderCell on it).
				return ZoteroCitations.renderCell(this, index, data, column, doc);
			},
		});
	},

	shutdown() {
		if (this._registeredKey) {
			try { Zotero.ItemTreeManager.unregisterColumn(this._registeredKey); }
			catch (e) { Zotero.logError(e); }
			this._registeredKey = null;
		}
		if (this._drainTimer) {
			clearTimeout(this._drainTimer);
			this._drainTimer = null;
		}
		if (this._saveTimer) {
			clearTimeout(this._saveTimer);
			this._saveTimer = null;
			this._saveCache().catch(e => Zotero.logError(e));
		}
		if (Zotero.AICitations === this) delete Zotero.AICitations;
	},

	// Nothing is added per window: the column lives in the item tree.
	addToWindow() {},
	removeFromWindow() {},

	// --- Item identifiers --------------------------------------------------

	_field(item, name) {
		try { return (item.getField(name) || "").trim(); }
		catch (e) { return ""; } // the field does not exist on this item type
	},

	/** Bare, lower-cased DOI from the DOI field or from Extra. */
	_itemDoi(item) {
		let raw = this._field(item, "DOI");
		if (!raw) {
			const m = /(?:^|\n)\s*DOI\s*:\s*(\S+)/i.exec(this._field(item, "extra"));
			if (m) raw = m[1];
		}
		if (!raw) {
			// arXiv preprints have a DataCite DOI derived from their ID.
			const id = this._arxivId(item);
			if (id) return ("10.48550/arxiv." + id).toLowerCase();
		}
		return this.normDoi(raw);
	},

	normDoi(raw) {
		let s = String(raw == null ? "" : raw).trim();
		if (!s) return "";
		try {
			const cleaned = Zotero.Utilities.cleanDOI(s);
			if (cleaned) s = cleaned;
		}
		catch (e) { /* fall through to the regex below */ }
		s = s.replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:)/i, "").trim();
		const m = /^(10\.\d{4,9}\/\S+)$/.exec(s);
		return m ? m[1].replace(/[.,;)]+$/, "").toLowerCase() : "";
	},

	_pmid(item) {
		const m = /(?:^|\n)\s*PMID\s*:?\s*(\d+)/i.exec(this._field(item, "extra"));
		return m ? m[1] : "";
	},

	_arxivId(item) {
		const extra = this._field(item, "extra");
		let m = /(?:^|\n)\s*arXiv\s*:?\s*(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)/i.exec(extra);
		if (!m) m = /arxiv\.org\/abs\/(\S+)/i.exec(this._field(item, "url"));
		return m ? m[1].replace(/v\d+$/i, "") : "";
	},

	_year(item) {
		let raw = "";
		try { raw = item.getField("date", true, true) || ""; }
		catch (e) { raw = ""; }
		const m = /(\d{4})/.exec(raw);
		const y = m ? parseInt(m[1], 10) : NaN;
		return Number.isFinite(y) && y > 1500 ? y : null;
	},

	/** Titles normalised for matching: case, punctuation, whitespace. */
	normTitle(title) {
		return String(title == null ? "" : title)
			.toLowerCase()
			.replace(/[‘’“”]/g, "")
			.replace(/[^a-z0-9]+/g, " ")
			.trim()
			.replace(/\s+/g, " ");
	},

	/**
	 * How an item is looked up. Returns { key, doi, pmid, title, year } or
	 * null when there is nothing usable to search on.
	 */
	resolve(item) {
		const doi = this._itemDoi(item);
		const pmid = doi ? "" : this._pmid(item);
		const title = this._field(item, "title");
		const year = this._year(item);
		let key = "";
		if (doi) key = "doi:" + doi;
		else if (pmid) key = "pmid:" + pmid;
		else if (this.normTitle(title).length >= 15) key = "title:" + this.normTitle(title) + "|" + (year || "");
		if (!key) return null;
		return { key, doi, pmid, title, year };
	},

	// --- Column ------------------------------------------------------------

	/** Fixed-width numeric prefix so the tree's string sort orders counts numerically. */
	_sortKey(count) {
		const n = Number.isFinite(count) && count > 0 ? Math.min(count, 9999999999) : 0;
		return String(n).padStart(this.SORT_WIDTH, "0");
	},

	_format(count) {
		try { return count.toLocaleString(); }
		catch (e) { return String(count); }
	},

	dataProvider(item, _dataKey) {
		try {
			if (!item || !item.isRegularItem || !item.isRegularItem()) return "";
			const res = this.resolve(item);
			if (!res) return "";

			const entry = this._cache[res.key];
			if (entry && entry.found && typeof entry.count === "number") {
				this._detailByItem.set(item.id, this._tooltip(entry, res));
				return this._sortKey(entry.count) + " " + this._format(entry.count);
			}
			if (entry && !entry.found) {
				this._detailByItem.set(item.id, "No citation record found on OpenAlex or Crossref");
				return this._sortKey(0) + " -";
			}
			this._detailByItem.set(item.id, "Citation count not looked up yet");
			this._enqueueLookup(res, item);
			return this._sortKey(0) + " ...";
		}
		catch (e) {
			Zotero.logError(e);
			return "";
		}
	},

	_tooltip(entry, res) {
		const parts = [this._format(entry.count) + " citation" + (entry.count === 1 ? "" : "s")];
		const year = entry.year || res.year;
		const age = year ? new Date().getFullYear() - year + 1 : 0;
		if (age > 1 && entry.count > 0) {
			parts.push((entry.count / age).toFixed(1) + "/year since " + year);
		}
		parts.push(entry.source === "crossref" ? "Crossref" : "OpenAlex");
		if (entry.title && this.normTitle(entry.title) !== this.normTitle(res.title)) {
			parts.push("matched: " + entry.title);
		}
		if (entry.ts) parts.push("checked " + new Date(entry.ts).toLocaleDateString());
		return parts.join(" · ");
	},

	renderCell(tree, index, data, column, doc) {
		const cell = doc.createElement("span");
		cell.className = "cell " + column.className;
		// Numbers read best right-aligned. Zotero's `.cell` is a block-level flex
		// item, so text-align does the job; its own 8px padding is left alone so
		// the column lines up with the others.
		cell.style.cssText = "text-align:right;font-variant-numeric:tabular-nums;"
			+ "font-feature-settings:'tnum';";
		if (!data) return cell;

		const text = data.slice(data.indexOf(" ") + 1);
		const value = doc.createElement("span");
		value.textContent = text;
		// Unknown and not-found read as absent data, not as a low score.
		if (text === "..." || text === "-") value.style.opacity = "0.4";
		else if (text === "0") value.style.opacity = "0.6";
		cell.appendChild(value);

		try {
			const row = tree && tree.getRow && tree.getRow(index);
			const item = row && row.ref;
			const detail = item && this._detailByItem.get(item.id);
			if (detail) cell.title = detail;
		}
		catch (e) { /* tooltip only */ }
		return cell;
	},

	// --- Lookups -----------------------------------------------------------

	_enqueueLookup(res, item) {
		let set = this._itemsByKey.get(res.key);
		if (!set) {
			set = new Set();
			this._itemsByKey.set(res.key, set);
		}
		set.add(item.id);

		if (!this._cacheLoaded) return; // dataProvider runs again once the cache is in
		if (AISummarizer.getPref("citationsLookup") === false) return;
		if (this._queued.has(res.key)) return;
		const failedAt = this._failed.get(res.key);
		if (failedAt && Date.now() - failedAt < this.FAIL_RETRY_MS) return;

		this._queued.add(res.key);
		this._queue.push(res);
		// Zotero renders a whole screen of rows in one synchronous pass, so the
		// drain waits a tick: that turns a page of items into one batched request.
		if (!this._drainTimer) {
			this._drainTimer = setTimeout(() => {
				this._drainTimer = null;
				this._drainQueue();
			}, this.DRAIN_DELAY_MS);
		}
	},

	/** DOIs with an OR/`,` separator in them cannot ride in a batched filter. */
	_batchable(job) {
		return !!job.doi && !/[|,]/.test(job.doi);
	},

	async _drainQueue() {
		if (this._draining) return;
		this._draining = true;
		try {
			while (this._queue.length) {
				const chunk = this._queue.splice(0, this.BATCH_SIZE);
				const batched = chunk.filter(j => this._batchable(j));
				const singles = chunk.filter(j => !this._batchable(j));
				if (batched.length) {
					await this._runDoiBatch(batched);
					await Zotero.Promise.delay(this.LOOKUP_GAP_MS);
				}
				for (const job of singles) {
					await this._runSingle(job);
					await Zotero.Promise.delay(this.LOOKUP_GAP_MS);
				}
			}
		}
		finally {
			this._draining = false;
		}
	},

	/** One OpenAlex request for up to BATCH_SIZE DOIs, then Crossref for the misses. */
	async _runDoiBatch(jobs) {
		let byDoi = null;
		try {
			const filter = "doi:" + jobs.map(j => encodeURIComponent(j.doi)).join("|");
			const results = await this._getWorks(filter + "&per-page=" + jobs.length);
			byDoi = new Map();
			for (const work of results) {
				const doi = this.normDoi(work.doi);
				if (doi) byDoi.set(doi, work);
			}
		}
		catch (e) {
			Zotero.debug("Zotero AI Toolkit: citation batch failed: " + e);
			for (const job of jobs) this._finish(job, null);
			return;
		}

		for (const job of jobs) {
			const work = byDoi.get(job.doi);
			if (work) {
				this._finish(job, this._entryFromWork(work));
				continue;
			}
			let entry = null;
			try { entry = await this._resolveMiss(job); }
			catch (e) {
				Zotero.debug("Zotero AI Toolkit: citation fallback failed for " + job.key + ": " + e);
				this._finish(job, null);
				continue;
			}
			this._finish(job, entry || { found: false, ts: Date.now() });
			await Zotero.Promise.delay(this.LOOKUP_GAP_MS);
		}
	},

	/**
	 * A DOI OpenAlex does not have: ask Crossref, which owns most DOIs, then
	 * fall back to the title. The title pass matters for arXiv preprints -
	 * their DataCite DOI (10.48550/...) is unknown to Crossref and only
	 * patchily indexed by OpenAlex, but the paper itself is in there.
	 */
	async _resolveMiss(job) {
		const entry = await this._crossref(job.doi);
		if (entry) return entry;
		if (!job.title) return null;
		await Zotero.Promise.delay(this.LOOKUP_GAP_MS);
		return this._byTitle(job);
	},

	/** One item that could not be batched: by PMID, by DOI, or by exact title. */
	async _runSingle(job) {
		let entry = null;
		try {
			if (job.pmid) {
				const results = await this._getWorks("pmid:" + encodeURIComponent(job.pmid));
				if (results[0]) entry = this._entryFromWork(results[0]);
			}
			if (!entry && job.doi) {
				const results = await this._getWorks("doi:" + encodeURIComponent(job.doi));
				if (results[0]) entry = this._entryFromWork(results[0]);
				if (!entry) entry = await this._resolveMiss(job);
			}
			if (!entry && !job.doi && job.title) {
				entry = await this._byTitle(job);
			}
		}
		catch (e) {
			Zotero.debug("Zotero AI Toolkit: citation lookup failed for " + job.key + ": " + e);
			this._finish(job, null);
			return;
		}
		this._finish(job, entry || { found: false, ts: Date.now() });
	},

	/**
	 * Title search, accepted only on an exact normalised-title match and, when
	 * the item has a year, a publication year within one - a near-miss here
	 * would silently show someone else's citation count.
	 */
	async _byTitle(job) {
		const results = await this._getWorks(
			"title.search:" + encodeURIComponent(job.title) + "&per-page=10"
		);
		const want = this.normTitle(job.title);
		const matches = results.filter((w) => {
			if (this.normTitle(w.title) !== want) return false;
			if (job.year && w.publication_year) return Math.abs(w.publication_year - job.year) <= 1;
			return true;
		});
		if (!matches.length) return null;
		// OpenAlex often holds a preprint and a published record for the same
		// paper; the more cited one is the canonical version.
		const best = matches.reduce((a, b) => ((b.cited_by_count || 0) > (a.cited_by_count || 0) ? b : a));
		return this._entryFromWork(best);
	},

	_entryFromWork(work) {
		const count = work.cited_by_count;
		return {
			found: true,
			count: typeof count === "number" ? count : 0,
			source: "openalex",
			title: work.title || work.display_name || "",
			year: work.publication_year || null,
			ts: Date.now(),
		};
	},

	async _getWorks(query) {
		const xhr = await Zotero.HTTP.request("GET", this.OPENALEX_URL
			+ "?filter=" + query
			+ "&select=doi,title,publication_year,cited_by_count", {
			responseType: "json",
			timeout: 20000,
			// Fail fast: Zotero would otherwise retry 5xx for up to an hour,
			// stalling the queue. _failed handles the retry an hour later.
			errorDelayMax: 0,
		});
		const data = xhr.response || {};
		return Array.isArray(data.results) ? data.results : [];
	},

	async _crossref(doi) {
		let xhr;
		try {
			xhr = await Zotero.HTTP.request("GET", this.CROSSREF_URL + encodeURIComponent(doi), {
				responseType: "json",
				timeout: 20000,
				errorDelayMax: 0,
				successCodes: [200, 404],
			});
		}
		catch (e) {
			if (e && e.status === 404) return null;
			throw e;
		}
		if (!xhr || xhr.status === 404) return null;
		const msg = (xhr.response || {}).message;
		if (!msg) return null;
		const count = msg["is-referenced-by-count"];
		return {
			found: true,
			count: typeof count === "number" ? count : 0,
			source: "crossref",
			title: Array.isArray(msg.title) ? msg.title[0] : (msg.title || ""),
			year: this._crossrefYear(msg),
			ts: Date.now(),
		};
	},

	_crossrefYear(msg) {
		const parts = ((msg.issued || {})["date-parts"] || [])[0];
		return Array.isArray(parts) && parts[0] ? parts[0] : null;
	},

	/** Records a finished lookup. A null entry means a network error: retry later. */
	_finish(job, entry) {
		this._queued.delete(job.key);
		if (entry) {
			this._cache[job.key] = entry;
			this._failed.delete(job.key);
			this._scheduleSave();
		}
		else {
			this._failed.set(job.key, Date.now());
		}
		this._refreshItems(job.key);
	},

	/** Clears the row cache of every item resolved to this key so the cell re-renders. */
	_refreshItems(key) {
		const set = this._itemsByKey.get(key);
		if (!set || !set.size) return;
		const ids = [...set];
		this._itemsByKey.delete(key);
		try { Zotero.Notifier.trigger("refresh", "item", ids); }
		catch (e) { Zotero.logError(e); }
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
			Zotero.debug("Zotero AI Toolkit: could not read citation cache: " + e);
		}
		finally {
			this._cacheLoaded = true;
			// Rows rendered before the cache was ready are re-read now.
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
			source: "OpenAlex works.cited_by_count, Crossref is-referenced-by-count",
			entries: this._cache,
		}));
	},

	/** Settings-pane action: forget every count and look them all up again. */
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

	/** Settings-pane action: re-read every row from the cache. */
	refresh() {
		this._refreshAll();
	},

	/** Settings-pane action: how many counts are cached right now. */
	cacheSize() {
		return Object.keys(this._cache).length;
	},
};
