# Zotero AI Toolkit

A [Zotero](https://www.zotero.org/) plugin (compatible with Zotero 7–9) that adds
a growing set of AI features to your library. It works with **Anthropic Claude**
or **OpenAI ChatGPT** — you bring your own API key and pay the provider directly.
There is no hosted service: your key is stored locally and paper text is sent only
to the provider you choose, only when you trigger a command.

It currently bundles three tools, all sharing one provider/key/model configuration:

1. **Summarize papers** — structured, literature-review-ready child notes.
2. **Categorize highlights** — recolor your highlights into a fixed, consistent taxonomy.
3. **Find further reading** — read a paper + its bibliography, search the web, and
   save a note of recommended sources.

## Features

### Summarize with AI
- **Structured notes**: TL;DR, research question & motivation, methodology, key findings,
  contributions, limitations, notable quotes, and suggested keywords.
- **Reads the real paper**: uses the full text Zotero has indexed from the item's best
  attachment (PDF, EPUB, snapshot) and falls back to the abstract — the note records
  which source was used.
- **Batch mode**: select several items and summarize them all with a per-item progress window.
- **Customizable prompt**: edit the template (with a `{language}` placeholder), set the
  output language, and tune output-token / input-size limits.
- Every note is tagged `ai-summary` and carries a header with date, provider, model, and source.

### Categorize Highlights with AI
Read the PDF and highlight anything interesting **all in one color** (e.g. blue). When done,
select the item and press `Cmd/Ctrl + Shift + H` (or right-click → *Categorize Highlights with AI*).
The model assigns each highlight a category from a fixed taxonomy; each highlight is **recolored
in place** and tagged, and a *Highlight Digest* note groups them by category with page numbers.

Built-in taxonomy (Zotero's standard palette — **blue is reserved** so a blue highlight always
means "not yet categorized"):

| Color | Category | What belongs there |
| --- | --- | --- |
| 🟡 Yellow | Key finding | Main results, central claims, headline numbers |
| 🟢 Green | Methods & data | Design, sample, data sources, measures, analysis |
| 🟣 Purple | Theory & background | Definitions, concepts, hypotheses, prior literature |
| 🟠 Orange | Implications | Contributions, practical/theoretical implications |
| 🔴 Red | Limitations & critique | Weaknesses, caveats, threats to validity |
| 🩷 Magenta | Quotable | Striking phrasing worth quoting verbatim |
| ⚪ Gray | Other | Future research, open questions, everything else |

The taxonomy is editable in the settings but is meant to stay **fixed across articles**.
Re-running re-categorizes all highlights (old category tags are cleaned up), so it is safe to
re-run after another reading pass. Highlights the model can't classify keep their original color.

### Find Further Reading with AI
Right-click an article → **Find further reading (AI)**. The plugin pulls the item's metadata
and extracted full text (which usually includes the reference list), sends it to your chosen
model with **web search** enabled, and saves the recommendations (title, authors, link/DOI, and
a reason for each) as a child note tagged `ai-further-reading`. Always double-check sources
before citing — models can still get details wrong.

## Installation

1. Build the plugin package:
   ```bash
   ./build.sh
   ```
   This produces `zotero-ai-toolkit.xpi`.
2. In Zotero: **Tools → Plugins → ⚙︎ → Install Plugin From File…** and pick the `.xpi`.
3. Open **Zotero → Settings → AI Toolkit**, choose a provider, paste your API key
   ([Anthropic Console](https://console.anthropic.com/) or
   [OpenAI Platform](https://platform.openai.com/)), and click **Test API key**.

## Usage

| Action | How |
| --- | --- |
| Summarize | Select item(s) → `Cmd/Ctrl + Shift + S` or right-click → *Summarize with AI* |
| Categorize highlights | Select item(s) → `Cmd/Ctrl + Shift + H` or right-click → *Categorize Highlights with AI* |
| Find further reading | Right-click an article → *Find further reading (AI)* |

Selecting a PDF attachment works too — the parent item is used. Running a command again creates
a new note; existing notes are never modified or deleted.

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| Provider | Anthropic (Claude) | Shared by all tools; both keys can be stored |
| Claude model | `claude-opus-4-8` | `claude-sonnet-4-6` / `claude-haiku-4-5` are faster & cheaper |
| ChatGPT model | `gpt-5` | Any model ID accepted by the API works |
| Output language | English | Inserted into the summary prompt via `{language}` |
| Max output tokens | 16000 | Upper bound for generated summaries |
| Max input characters | 200000 | Longer article text is truncated (noted in the summary) |
| Summary prompt template | built-in | Leave empty to use the built-in academic template |
| Highlight categories | built-in taxonomy | `#color | Name | description` per line |
| Number of recommendations | 8 | 1–30, for Find Further Reading |
| Shortcuts | Cmd/Ctrl+Shift+S / +H | Modifiers and letters configurable |

## Security & privacy

- **Where your key lives**: in your Zotero profile's preferences, unencrypted, on this computer
  only (Zotero offers no OS-keychain API to plugins). The key is masked in the settings UI and
  never written to logs. Prefer a key with a spending limit.
- **Where your data goes**: article text and metadata are sent **only** to the provider you
  selected (`api.anthropic.com` or `api.openai.com`) over HTTPS, and **only** when you explicitly
  trigger a command. The endpoints are hard-coded — there is deliberately no "custom server" setting.
- **Model output is sanitized** (scripts, embeds, event handlers, `javascript:` URLs stripped)
  before being saved into a note.
- Check your institution's policy before sending unpublished or licensed full texts to a
  third-party API; the abstract-only fallback applies automatically when no full text is available.

## Costs

Each command is one (or, for further-reading, a few) API call(s). As a rough guide, a 30-page
paper summarized with `claude-opus-4-8` costs on the order of $0.15–0.40; `claude-sonnet-4-6`
roughly a third of that; `claude-haiku-4-5` a tenth. Set a monthly spending limit in your
provider console.

## Publishing note

Zotero 8+ requires `applications.zotero.update_url` in `manifest.json`. It points at a
`updates.json` in this repo; if you fork or publish, point it at an `updates.json` you control
so users receive updates.

## Development

```
manifest.json               Plugin manifest (Zotero 7 bootstrapped plugin)
bootstrap.js                Lifecycle hooks; loads modules, registers the shared pref pane
prefs.js                    Default preferences (single extensions.zotero-ai-toolkit.* namespace)
src/summarizer.js           Summarize + highlight categorization (Zotero.AISummarizer)
src/expand.js               Find further reading — controller (ZoteroExpand)
src/expand-ai.js            Find further reading — AI client (ZoteroExpandAI)
preferences/preferences.xhtml   Shared settings pane UI
preferences/preferences.js      Settings pane logic (test key, prompt/category buttons)
build.sh                    Packages everything into zotero-ai-toolkit.xpi
```

No build toolchain or dependencies — plain JavaScript running in Zotero's privileged
environment. To iterate quickly, install once, then edit files and reinstall the rebuilt
`.xpi` (or use Zotero's plugin development mode with a source directory).

This plugin merges two earlier projects — **Zotero Expand** (find further reading) and the
**AI Paper Summarizer** (summarize + categorize) — whose commit histories are preserved here.

## License

[MIT](LICENSE)
