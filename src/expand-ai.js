/* eslint-disable no-undef */
// AI client for the "Find further reading" feature.
// Talks to Claude (Anthropic) or OpenAI directly over HTTPS using Zotero.HTTP,
// asking the model to read an article + its bibliography and use web search to
// recommend further reading. Returns a structured object.

ZoteroExpandAI = {
	DEFAULT_MODELS: {
		anthropic: "claude-opus-4-8",
		openai: "gpt-5.4",
	},

	/**
	 * @param {Object} opts {provider, apiKey, model, count, articleText, meta}
	 * @returns {Promise<Object>} {summary, topics, recommendations:[...]}
	 */
	async recommend(opts) {
		const provider = opts.provider === "openai" ? "openai" : "anthropic";
		const model = opts.model || this.DEFAULT_MODELS[provider];
		const prompt = this.buildPrompt(opts.articleText, opts.meta, opts.count);

		let rawText;
		if (provider === "openai") {
			rawText = await this.callOpenAI(opts.apiKey, model, prompt);
		}
		else {
			rawText = await this.callClaude(opts.apiKey, model, prompt);
		}
		return this.parseResult(rawText);
	},

	buildPrompt(articleText, meta, count) {
		const n = count || 8;
		const metaLines = [];
		if (meta.title) metaLines.push("Title: " + meta.title);
		if (meta.creators) metaLines.push("Authors: " + meta.creators);
		if (meta.date) metaLines.push("Date: " + meta.date);
		if (meta.publication) metaLines.push("Publication: " + meta.publication);
		if (meta.DOI) metaLines.push("DOI: " + meta.DOI);
		if (meta.abstract) metaLines.push("Abstract: " + meta.abstract);

		const haveFullText = articleText && articleText.trim().length > 0;

		return [
			"You are a research librarian helping a scholar find further reading.",
			"",
			"Below is an academic article from the user's Zotero library: its metadata, and (if available) its extracted full text, which usually ends with the bibliography / reference list.",
			"",
			"Task:",
			"1. Understand the article's core topic, methods, and arguments.",
			"2. Read its bibliography to see what it already builds on.",
			"3. Use web search to find up to " + n + " strong further-reading works on the same topic. Search before recommending — do not rely on memory. Prefer works NOT already in the bibliography; include a cited work only if it is foundational. Favour peer-reviewed papers, books, and authoritative sources.",
			"",
			"Verification (hard rule): for EVERY recommendation, confirm via web search that the work really exists, and give a resolvable identifier — prefer a DOI (https://doi.org/...), else a real URL you actually retrieved. Never invent or guess a title, author, year, DOI, or URL. If you cannot verify a work, drop it. " + n + " is a maximum, not a quota: returning fewer verified items is correct — do not pad. Leave both \"url\" and \"doi\" empty only for a verified work drawn from the bibliography that genuinely has neither; never both empty for a web find.",
			"",
			"Set \"source\" to \"bibliography\" if the work is in the article's reference list, otherwise \"web\" (if both, use \"bibliography\"). Do not recommend the article itself or list any work twice.",
			"",
			"Return ONLY a JSON object inside a ```json code block, with EXACTLY these keys:",
			"{",
			'  "summary": "1-2 sentences. If no full text was provided, begin with: (Based on metadata and web search; full text unavailable.) If you returned fewer than ' + n + ' items, say why here.",',
			'  "topics": ["3-6 key topics"],',
			'  "recommendations": [',
			'    { "title": "", "authors": "", "year": "", "venue": "", "url": "", "doi": "", "reason": "one sentence: how it relates — extends / contradicts / supplies method or data for / reviews the article", "source": "web" }',
			"  ]",
			"}",
			"No prose outside the code block. Spend the response on verified recommendations, not prose.",
			"",
			"=== ARTICLE METADATA ===",
			metaLines.join("\n") || "(none)",
			"",
			"=== ARTICLE FULL TEXT (may include bibliography) ===",
			haveFullText
				? articleText
				: "(No extracted full text available. Base your understanding on the metadata/abstract above and on web search.)",
		].join("\n");
	},

	async callClaude(apiKey, model, prompt) {
		const url = "https://api.anthropic.com/v1/messages";
		const messages = [{ role: "user", content: prompt }];
		let data;

		// Loop to handle pause_turn (server-side web-search continuation).
		for (let i = 0; i < 6; i++) {
			const payload = {
				model: model,
				max_tokens: 4096,
				tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 6 }],
				messages: messages,
			};

			const xhr = await Zotero.HTTP.request("POST", url, {
				headers: {
					"Content-Type": "application/json",
					"x-api-key": apiKey,
					"anthropic-version": "2023-06-01",
					"anthropic-dangerous-direct-browser-access": "true",
				},
				body: JSON.stringify(payload),
				responseType: "json",
				timeout: 240000,
				successCodes: false,
			});

			data = xhr.response || JSON.parse(xhr.responseText);
			if (xhr.status < 200 || xhr.status >= 300) {
				const msg = data && data.error ? data.error.message : xhr.responseText;
				throw new Error("Claude API error " + xhr.status + ": " + msg);
			}

			if (data.stop_reason === "pause_turn") {
				messages.push({ role: "assistant", content: data.content });
				continue;
			}
			break;
		}

		let text = "";
		for (const block of data.content) {
			if (block.type === "text") text += block.text + "\n";
		}
		return text;
	},

	async callOpenAI(apiKey, model, prompt) {
		const url = "https://api.openai.com/v1/responses";
		const payload = {
			model: model,
			tools: [{ type: "web_search_preview" }],
			input: prompt,
		};

		const xhr = await Zotero.HTTP.request("POST", url, {
			headers: {
				"Content-Type": "application/json",
				"Authorization": "Bearer " + apiKey,
			},
			body: JSON.stringify(payload),
			responseType: "json",
			timeout: 240000,
			successCodes: false,
		});

		const data = xhr.response || JSON.parse(xhr.responseText);
		if (xhr.status < 200 || xhr.status >= 300) {
			const msg = data && data.error ? data.error.message : xhr.responseText;
			throw new Error("OpenAI API error " + xhr.status + ": " + msg);
		}

		// Prefer the convenience field if present.
		if (data.output_text) return data.output_text;

		let text = "";
		for (const item of data.output || []) {
			if (item.type === "message" && Array.isArray(item.content)) {
				for (const c of item.content) {
					if (c.type === "output_text") text += c.text + "\n";
				}
			}
		}
		return text;
	},

	parseResult(text) {
		if (!text || !text.trim()) {
			throw new Error("The model returned an empty response.");
		}
		let jsonStr = text;
		const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
		if (fence) {
			jsonStr = fence[1];
		}
		else {
			const s = text.indexOf("{");
			const e = text.lastIndexOf("}");
			if (s >= 0 && e > s) jsonStr = text.slice(s, e + 1);
		}
		try {
			return JSON.parse(jsonStr);
		}
		catch (e) {
			throw new Error("Could not parse the model's JSON response.\n\n" + text.slice(0, 500));
		}
	},
};
