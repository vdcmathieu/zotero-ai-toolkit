// Default preferences for Zotero AI Toolkit.
// Zotero loads this file automatically from the plugin root.
//
// All features share one provider selection and one pair of API keys/models,
// so you configure your credentials once and every tool uses them.

// --- Shared: provider, keys, models ---------------------------------------
pref("extensions.zotero-ai-toolkit.provider", "anthropic");
pref("extensions.zotero-ai-toolkit.anthropicApiKey", "");
pref("extensions.zotero-ai-toolkit.openaiApiKey", "");
pref("extensions.zotero-ai-toolkit.anthropicModel", "claude-opus-4-8");
pref("extensions.zotero-ai-toolkit.openaiModel", "gpt-5");

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
