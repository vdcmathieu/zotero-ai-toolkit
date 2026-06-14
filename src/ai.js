/* eslint-disable no-undef */
// AI clients for Zotero Expand.
// Talks to Claude (Anthropic) or OpenAI directly over HTTPS using Zotero.HTTP,
// asking the model to read an article + its bibliography and use web search to
// recommend further reading. Returns a structured object.

ZoteroExpandAI = {
	DEFAULT_MODELS: {
		claude: "claude-opus-4-8",
		openai: "gpt-4o",
	},

	/**
	 * @param {Object} opts {provider, apiKey, model, count, articleText, meta}
	 * @returns {Promise<Object>} {summary, topics, recommendations:[...]}
	 */
	async recommend(opts) {
		const provider = opts.provider || "claude";
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
			"Below is an academic article from the user's Zotero library: its",
			"metadata, and (if available) its extracted full text, which usually",
			"includes the bibliography / reference list at the end.",
			"",
			"Your task:",
			"1. Read and understand the article's core topic, methods, and arguments.",
			"2. Read the bibliography to see what the article already builds on.",
			"3. Use web search to find " + n + " strong recommendations for further",
			"   reading on the same topic. Prefer works NOT already in the article's",
			"   bibliography, but you may include a key cited work if it is essential.",
			"   Favour peer-reviewed papers, books, and authoritative sources.",
			"   Verify each recommendation actually exists via web search and give a",
			"   real, working URL or DOI.",
			"",
			"Return ONLY a JSON object inside a ```json code block, with this shape:",
			"{",
			'  "summary": "1-3 sentence summary of the article",',
			'  "topics": ["key topic", "..."],',
			'  "recommendations": [',
			"    {",
			'      "title": "...",',
			'      "authors": "...",',
			'      "year": "...",',
			'      "venue": "journal / publisher / site",',
			'      "url": "https://... (or empty)",',
			'      "doi": "... (or empty)",',
			'      "reason": "why this is relevant to the article",',
			'      "source": "web" or "bibliography"',
			"    }",
			"  ]",
			"}",
			"",
			"Do not include any prose outside the JSON code block.",
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
