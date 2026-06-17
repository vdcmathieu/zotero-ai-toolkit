// Default preferences for Zotero AI Toolkit.
// Zotero loads this file automatically from the plugin root.
//
// All features share one pair of API keys (Anthropic + OpenAI). Each tool then
// picks its own model from a unified list of Claude and GPT models; the
// provider and which key to use are inferred from the chosen model ID.

// --- Shared: API keys -----------------------------------------------------
pref("extensions.zotero-ai-toolkit.anthropicApiKey", "");
pref("extensions.zotero-ai-toolkit.openaiApiKey", "");

// --- Per-tool model (Claude or GPT; provider inferred from the ID) ---------
pref("extensions.zotero-ai-toolkit.summarizeModel", "claude-sonnet-4-6");
pref("extensions.zotero-ai-toolkit.categorizeModel", "claude-haiku-4-5");
pref("extensions.zotero-ai-toolkit.expandModel", "claude-opus-4-8");
pref("extensions.zotero-ai-toolkit.sortModel", "claude-sonnet-4-6");

// --- Summarize ------------------------------------------------------------
pref("extensions.zotero-ai-toolkit.maxOutputTokens", "16000");
pref("extensions.zotero-ai-toolkit.maxInputChars", "200000");
pref("extensions.zotero-ai-toolkit.outputLanguage", "English");
pref("extensions.zotero-ai-toolkit.promptTemplate", "");

// --- Highlight categorization ---------------------------------------------
pref("extensions.zotero-ai-toolkit.categories", "");
pref("extensions.zotero-ai-toolkit.createDigestNote", true);
pref("extensions.zotero-ai-toolkit.tagAnnotations", true);

// --- Find further reading -------------------------------------------------
pref("extensions.zotero-ai-toolkit.numRecommendations", 8);
pref("extensions.zotero-ai-toolkit.maxChars", 120000);

// --- Keyboard shortcuts ---------------------------------------------------
pref("extensions.zotero-ai-toolkit.shortcutEnabled", true);
pref("extensions.zotero-ai-toolkit.shortcutAccel", true);
pref("extensions.zotero-ai-toolkit.shortcutShift", true);
pref("extensions.zotero-ai-toolkit.shortcutAlt", false);
pref("extensions.zotero-ai-toolkit.shortcutKey", "S");
pref("extensions.zotero-ai-toolkit.categorizeShortcutKey", "H");
pref("extensions.zotero-ai-toolkit.sortShortcutKey", "F");
