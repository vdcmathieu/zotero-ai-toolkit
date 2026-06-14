# Zotero Expand

A [Zotero 7](https://www.zotero.org/) plugin that turns any paper in your library
into a reading list. Select an article, and an AI (**Claude** or **GPT**) reads
its text and bibliography, searches the web, and recommends further reading on
the same topic — saved as a note on the item.

## What it does

1. You select an article and choose **“Find further reading (AI)”** from the
   right-click menu.
2. The plugin pulls the item's metadata and the extracted full text of its PDF
   (which normally includes the reference list).
3. It sends that to your chosen model with **web search** enabled. The model
   understands the paper, looks at what it already cites, and finds new,
   relevant sources online — verifying each one.
4. The recommendations (title, authors, link/DOI, and a reason for each) are
   saved as a **child note** on the item.

## Requirements

- Zotero 7
- An API key from **[Anthropic](https://console.anthropic.com/)** (Claude,
  recommended) or **[OpenAI](https://platform.openai.com/)** (GPT)

Your key is stored in Zotero's local preferences and sent only to the provider
you pick. API usage is billed by that provider.

## Install

1. Download `zotero-expand.xpi` from the
   [Releases](https://github.com/vandemathieu/zotero-expand/releases) page
   (or run `./build.sh` to create it from source).
2. In Zotero: **Tools → Plugins → gear icon → Install Plugin From File…** and
   select the `.xpi`.
3. Open **Settings → Zotero Expand**, choose a provider, and paste your API key.

## Use

Right-click an article (or its PDF) → **Find further reading (AI)**. A progress
popup appears; when it finishes, a note with the recommendations is added to the
item and selected. Always double-check sources before citing — models can still
get details wrong.

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| Provider | Claude | Claude (Anthropic) or OpenAI |
| API key | — | Stored locally |
| Model | provider default | `claude-opus-4-8` / `gpt-4o`; override if you like |
| Number of recommendations | 8 | 1–30 |

## How it works

It's a bootstrapped plugin (`bootstrap.js`) that adds an item-menu command. The
controller (`src/expand.js`) gathers text via Zotero's full-text index and saves
the result as a note; the AI client (`src/ai.js`) calls the Anthropic Messages
API or the OpenAI Responses API with their built-in web-search tools and parses
the JSON response.

## License

[MIT](LICENSE)
