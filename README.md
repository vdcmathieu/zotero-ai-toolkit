# AI Paper Summarizer for Zotero

A Zotero plugin (compatible with Zotero 7–9) that does two things from your library:

1. **Summarizes selected articles** with an LLM and saves the result as a structured, literature-review-ready child note on the item.
2. **Color-codes your highlights** — read and highlight everything in one color, then let the LLM recolor each highlight into a fixed, consistent taxonomy (key finding, methods, theory, limitations, …) so colors mean the same thing in every paper.

It works with **Anthropic Claude** or **OpenAI ChatGPT**. There is no hosted service and no account to create for the plugin itself — **you bring your own API key** (from [Anthropic](https://console.anthropic.com/) or [OpenAI](https://platform.openai.com/)) and pay the provider directly per use. Your key is stored locally in your Zotero profile, and paper text is sent only to the provider you choose, only when you trigger an action. See [Security & privacy](#security--privacy) and [Costs](#costs).

## Features

- **Structured, literature-review-ready notes**: TL;DR, research question & motivation, methodology, key findings, contributions, limitations, notable quotes, and suggested keywords.
- **Reads the real paper**: uses the full text Zotero has indexed from the item's best attachment (PDF, EPUB, snapshot) and falls back to the abstract — the note records which source was used.
- **Batch mode**: select several items (or their attachments) and summarize them all, with a per-item progress window.
- **Two providers**: store both an Anthropic and an OpenAI key, switch providers with one dropdown, and enter any model ID (defaults: `claude-opus-4-8` and `gpt-5`).
- **Customizable prompt**: edit the summary template in the settings (with a `{language}` placeholder), set the output language, and tune output-token / input-size limits.
- **Configurable keyboard shortcuts**: default `Cmd/Ctrl + Shift + S` to summarize, `Cmd/Ctrl + Shift + H` to categorize highlights; modifiers and keys are configurable. Both also available via right-click.
- **Traceable output**: every note is tagged `ai-summary` / `ai-highlights` and carries a header with the date, provider, model, and text source.
- **AI highlight categorization**: highlight everything in one color while reading, then let the LLM recolor each highlight into a fixed taxonomy — the same colors mean the same thing in every article.

## Highlight categorization

Workflow: read the PDF and highlight anything interesting **all in blue** (or any single color).
When done, select the item in the library and press `Cmd/Ctrl + Shift + H` (or right-click →
*Categorize Highlights with AI*). The plugin sends the highlighted passages (plus title/abstract
for context) to the LLM, which assigns each one a category from a fixed taxonomy. Each highlight is
then **recolored in place** to its category color and tagged with the category name, and a
*Highlight Digest* note groups all highlights by category with page numbers.

Built-in taxonomy (uses Zotero's standard palette — **blue is reserved**, so a blue highlight
always means "not yet categorized"):

| Color | Category | What belongs there |
| --- | --- | --- |
| 🟡 Yellow | Key finding | Main results, central claims, headline numbers |
| 🟢 Green | Methods & data | Design, sample, data sources, measures, analysis |
| 🟣 Purple | Theory & background | Definitions, concepts, hypotheses, prior literature |
| 🟠 Orange | Implications | Contributions, practical/theoretical implications |
| 🔴 Red | Limitations & critique | Weaknesses, caveats, threats to validity |
| 🩷 Magenta | Quotable | Striking phrasing worth quoting verbatim |
| ⚪ Gray | Other | Future research, open questions, everything else |

The taxonomy is editable in the settings (one `#color | Name | description` per line) but is meant
to stay **fixed across articles** so you can read colors at a glance. Re-running the command
re-categorizes all highlights (tags from previous runs are cleaned up), so it is safe to run again
after a second reading pass. Highlights the model can't classify keep their original color — anything
still blue is unprocessed.

## Installation

1. Build the plugin package:
   ```bash
   ./build.sh
   ```
   This produces `ai-summarizer.xpi`.
2. In Zotero 7: **Tools → Plugins → ⚙︎ → Install Plugin From File…** and pick `ai-summarizer.xpi`.
3. Open **Zotero → Settings → AI Summarizer**, paste your API key
   ([Anthropic Console](https://console.anthropic.com/) or [OpenAI Platform](https://platform.openai.com/)),
   and click **Test API key**.

## Usage

1. Select one or more articles in your library (selecting a PDF attachment works too — the parent item is used).
2. Press **Cmd/Ctrl + Shift + S**, or right-click → **Summarize with AI**.
3. A progress window tracks each item; a child note titled *AI Summary: …* appears under each item, tagged `ai-summary`.

Running it again on the same item creates an additional note (existing notes are never modified or deleted).

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| Provider | Anthropic (Claude) | Which API is used; both keys can be stored |
| Claude model | `claude-opus-4-8` | Highest quality; `claude-sonnet-4-6` / `claude-haiku-4-5` are faster & cheaper |
| ChatGPT model | `gpt-5` | Any chat-completions model ID works |
| Output language | English | Inserted into the prompt via `{language}` |
| Max output tokens | 16000 | Upper bound for the generated summary |
| Max input characters | 200000 | Longer article text is truncated (noted in the summary) |
| Prompt template | built-in | Leave empty to use the built-in academic template |
| Shortcut | Cmd/Ctrl+Shift+S | Modifiers and letter are configurable |

## Security & privacy

- **Where your key lives**: in your Zotero profile's preferences, unencrypted, on this computer only (Zotero offers no OS-keychain API to plugins). The key is masked in the settings UI and never written to logs. Anyone with access to your user account/profile directory could read it — treat the machine accordingly, and prefer a key with a spending limit.
- **Where your data goes**: article text and metadata are sent **only** to the provider you selected (`api.anthropic.com` or `api.openai.com`) over HTTPS, and **only** when you explicitly trigger a summarization. The endpoints are hard-coded — there is deliberately no "custom server" setting that could redirect your key or text elsewhere.
- **Model output is sanitized** (scripts, embeds, event handlers, `javascript:` URLs stripped) before being saved into a note.
- Check your institution's policy before sending unpublished or licensed full texts to a third-party API; the abstract-only fallback applies automatically when no full text is available.

## Costs

Each summary is one API call. As a rough guide, a 30-page paper (~15k words) summarized with `claude-opus-4-8` costs in the order of $0.15–0.40; `claude-sonnet-4-6` roughly a third of that; `claude-haiku-4-5` a tenth. Set a monthly spending limit in your provider console.

## Troubleshooting

- **"no full text or abstract available"** — Zotero hasn't indexed the attachment yet. Open the PDF once or right-click the attachment → *Reindex Item*, or add an abstract.
- **"invalid API key (HTTP 401)"** — re-paste the key and use *Test API key* in settings.
- **Rate limits (HTTP 429)** — the plugin retries once automatically; for big batches, wait a moment and re-run the failed items.
- **Shortcut does nothing** — make sure focus is on the library (not inside a text field) and that items are selected; check the shortcut configuration in settings.
- Debug output: **Help → Debug Output Logging** — plugin messages are prefixed with `AI Summarizer`.

## Publishing note

Zotero 8+ requires `applications.zotero.update_url` in `manifest.json`. It currently points
to an inert placeholder on `example.com` (an IANA-reserved domain that can never be registered,
so no third party can ever serve a malicious update from it). If you publish this plugin,
replace it with the URL of a real `updates.json` you control (e.g. on GitHub) so users
receive updates.

## Development

```
manifest.json            Plugin manifest (Zotero 7 bootstrapped plugin)
bootstrap.js             Lifecycle hooks (startup/shutdown, window hooks)
prefs.js                 Default preferences
content/summarizer.js    Core: extraction, API clients, sanitization, note creation
content/preferences.xhtml  Settings pane UI
content/preferences.js     Settings pane logic (test key, prompt buttons)
build.sh                 Packages everything into ai-summarizer.xpi
```

No build toolchain or dependencies — plain JavaScript running in Zotero's privileged environment. To iterate quickly, install once, then edit files and reinstall the rebuilt `.xpi` (or use Zotero's plugin development mode with a source directory).
