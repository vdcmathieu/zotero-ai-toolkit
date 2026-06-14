/* Default preferences for AI Paper Summarizer.
 * Numeric values are stored as strings so the preference pane can bind
 * them to plain text inputs; the code parses them with sane fallbacks. */
pref("extensions.zotero.aisummarizer.provider", "anthropic");
pref("extensions.zotero.aisummarizer.anthropicApiKey", "");
pref("extensions.zotero.aisummarizer.openaiApiKey", "");
pref("extensions.zotero.aisummarizer.anthropicModel", "claude-opus-4-8");
pref("extensions.zotero.aisummarizer.openaiModel", "gpt-5");
pref("extensions.zotero.aisummarizer.maxOutputTokens", "16000");
pref("extensions.zotero.aisummarizer.maxInputChars", "200000");
pref("extensions.zotero.aisummarizer.outputLanguage", "English");
pref("extensions.zotero.aisummarizer.promptTemplate", "");
pref("extensions.zotero.aisummarizer.shortcutEnabled", true);
pref("extensions.zotero.aisummarizer.shortcutAccel", true);
pref("extensions.zotero.aisummarizer.shortcutShift", true);
pref("extensions.zotero.aisummarizer.shortcutAlt", false);
pref("extensions.zotero.aisummarizer.shortcutKey", "S");
pref("extensions.zotero.aisummarizer.categorizeShortcutKey", "H");
pref("extensions.zotero.aisummarizer.categories", "");
pref("extensions.zotero.aisummarizer.createDigestNote", true);
pref("extensions.zotero.aisummarizer.tagAnnotations", true);
