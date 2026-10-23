// Runs in iframes only, and is kept tiny because it loads into every frame on
// every page. Forwards the modifier release and the search shortcut to the
// top frame, which owns the overlay (content.js).

(() => {
	if (window === window.top) return;
	const api = globalThis.browser ?? globalThis.chrome;
	const isMac = /Mac/.test(navigator.platform);
	const MODIFIERS = ["Meta", "Control", "Alt", "Shift"];
	const controller = new AbortController();

	let search = { code: "Slash", meta: isMac, ctrl: !isMac, alt: false, shift: false };
	api.storage.sync.get("searchShortcut").then((s) => s.searchShortcut && (search = s.searchShortcut), () => {});
	api.storage.onChanged.addListener((changes) => {
		if (changes.searchShortcut) search = changes.searchShortcut.newValue ?? search;
	});

	function send(message) {
		try {
			api.runtime.sendMessage({ type: "relay", message }).catch(() => {});
		} catch {
			controller.abort(); // orphaned by an extension reload
		}
	}

	let sawOtherKey = false; // a visible key went down while a modifier was held

	addEventListener(
		"keydown",
		(e) => {
			sawOtherKey = !MODIFIERS.includes(e.key);
			const isSearch =
				e.code === search.code &&
				e.metaKey === search.meta &&
				e.ctrlKey === search.ctrl &&
				e.altKey === search.alt &&
				e.shiftKey === search.shift;
			if (isSearch) {
				e.preventDefault();
				e.stopImmediatePropagation();
				send({ type: "search" });
			}
		},
		{ capture: true, signal: controller.signal },
	);

	addEventListener(
		"keyup",
		(e) => {
			// The switch shortcut itself never reaches the page, so a release
			// with no visible key in between is the only one worth relaying.
			if (MODIFIERS.includes(e.key) && !sawOtherKey) send({ type: "modUp", key: e.key });
		},
		{ capture: true, signal: controller.signal },
	);
})();
