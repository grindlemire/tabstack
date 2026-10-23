// Settings and keyboard-shortcut helpers used by every tabstack context.

globalThis.TabstackShared = (() => {
	const api = globalThis.browser ?? globalThis.chrome;
	const isMac = /Mac/.test(navigator.platform);
	const isFirefox = typeof api.runtime.getBrowserInfo === "function";

	const DEFAULTS = {
		searchShortcut: { code: "Slash", key: "/", meta: isMac, ctrl: !isMac, alt: false, shift: false },
		autoSwitch: true,
		includeClosed: true,
		thisWindowOnly: false,
		showTimings: false,
	};

	async function loadSettings() {
		return { ...DEFAULTS, ...(await api.storage.sync.get(null)) };
	}

	function onSettingsChange(fn) {
		api.storage.onChanged.addListener((changes, area) => {
			if (area === "sync") loadSettings().then(fn);
		});
	}

	function matches(e, shortcut) {
		return (
			e.code === shortcut.code &&
			e.metaKey === shortcut.meta &&
			e.ctrlKey === shortcut.ctrl &&
			e.altKey === shortcut.alt &&
			e.shiftKey === shortcut.shift
		);
	}

	const KEY_NAMES = {
		Slash: "/", Period: ".", Comma: ",", Semicolon: ";", Quote: "'", Backquote: "`",
		BracketLeft: "[", BracketRight: "]", Backslash: "\\", Minus: "-", Equal: "=",
		Space: "Space", Enter: "Enter", Tab: "Tab",
		ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
	};

	// Names the physical key, since e.key changes with Alt and Shift.
	function keyName(code, fallback) {
		if (/^Key[A-Z]$/.test(code)) return code.slice(3);
		if (/^Digit\d$/.test(code)) return code.slice(5);
		return KEY_NAMES[code] ?? fallback;
	}

	// Returns null for a lone modifier press.
	function fromEvent(e) {
		if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return null;
		return {
			code: e.code,
			key: keyName(e.code, e.key),
			meta: e.metaKey,
			ctrl: e.ctrlKey,
			alt: e.altKey,
			shift: e.shiftKey,
		};
	}

	function format(s) {
		if (isMac) return `${s.ctrl ? "⌃" : ""}${s.alt ? "⌥" : ""}${s.shift ? "⇧" : ""}${s.meta ? "⌘" : ""}${s.key}`;
		return [s.ctrl && "Ctrl", s.alt && "Alt", s.shift && "Shift", s.meta && "Meta", s.key].filter(Boolean).join("+");
	}

	return { api, isMac, isFirefox, DEFAULTS, loadSettings, onSettingsChange, matches, fromEvent, keyName, format };
})();
