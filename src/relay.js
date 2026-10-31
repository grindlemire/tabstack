// Kept tiny because it loads into every frame on every page. In every frame,
// it passes on the page turning its microphone or camera on or off (media.js).
// In iframes, it also forwards the modifier release and the search shortcut
// to the top frame, which owns the overlay (content.js).

(() => {
	const api = globalThis.browser ?? globalThis.chrome;

	addEventListener("message", (e) => {
		if (e.source !== window || e.data?.tabstack !== "media") return;
		try {
			api.runtime.sendMessage({ type: "media", live: !!e.data.live }).catch(() => {});
		} catch {
			// orphaned by an extension reload
		}
	});

	if (window === window.top) return;
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

	// The page can dispatch keys too, so only the browser's own count.
	addEventListener(
		"keydown",
		(e) => {
			if (!e.isTrusted) return;
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
			if (!e.isTrusted) return;
			// The switch shortcut itself never reaches the page, so a release
			// with no visible key in between is the only one worth relaying.
			if (MODIFIERS.includes(e.key) && !sawOtherKey) send({ type: "modUp", key: e.key });
		},
		{ capture: true, signal: controller.signal },
	);
})();
