/* eslint-disable no-undef */
// Wires the preference pane fields to Zotero.Prefs. Runs in the pane window
// scope, with `document` and `Zotero` available.

{
	const PREFIX = "extensions.zotero-expand.";
	const $ = id => document.getElementById(id);

	const get = (key, fallback) => {
		const v = Zotero.Prefs.get(PREFIX + key, true);
		return (v === undefined || v === null || v === "") ? fallback : v;
	};
	const set = (key, val) => Zotero.Prefs.set(PREFIX + key, val, true);

	// Load current values into the fields.
	$("ze-provider").value = get("provider", "claude");
	$("ze-apikey").value = get("apiKey", "");
	$("ze-model").value = get("model", "");
	$("ze-count").value = get("numRecommendations", 8);

	// Persist on change.
	$("ze-provider").addEventListener("command", (e) => {
		set("provider", e.target.value);
	});
	$("ze-apikey").addEventListener("change", (e) => {
		set("apiKey", e.target.value.trim());
	});
	$("ze-model").addEventListener("change", (e) => {
		set("model", e.target.value.trim());
	});
	$("ze-count").addEventListener("change", (e) => {
		let n = parseInt(e.target.value, 10);
		if (isNaN(n) || n < 1) n = 8;
		if (n > 30) n = 30;
		set("numRecommendations", n);
		e.target.value = n;
	});
}
