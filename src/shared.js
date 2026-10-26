// Settings and keyboard-shortcut helpers used by every tabstack context.

globalThis.TabstackShared = (() => {
	const api = globalThis.browser ?? globalThis.chrome;
	const isMac = /Mac/.test(navigator.platform);
	// runtime.getBrowserInfo would tell, but page scripts don't get it
	const isFirefox = navigator.userAgent.includes("Firefox/");

	const DEFAULTS = {
		searchShortcut: { code: "Slash", key: "/", meta: isMac, ctrl: !isMac, alt: false, shift: false },
		autoSwitch: true,
		includeClosed: false,
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

	// This profile's name and mark ({ name, mark }), or null, now and whenever
	// it changes. profiles.js keeps it; the Firefox build never has one.
	function watchLabel(fn) {
		api.storage.local.get("profileLabel").then(({ profileLabel }) => fn(profileLabel ?? null));
		api.storage.onChanged.addListener((changes, area) => {
			if (area === "local" && changes.profileLabel) fn(changes.profileLabel.newValue ?? null);
		});
	}

	// An icon from icons.js, by its path, in the color of the text around it.
	function iconSvg(path) {
		const ns = "http://www.w3.org/2000/svg";
		const svg = document.createElementNS(ns, "svg");
		svg.setAttribute("viewBox", "0 0 256 256");
		const p = document.createElementNS(ns, "path");
		p.setAttribute("d", path);
		p.setAttribute("fill", "currentColor");
		svg.append(p);
		return svg;
	}

	// How light a #rrggbb color looks, from 0 (black) to 1 (white).
	function lightness(color) {
		const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255);
		return 0.2126 * r + 0.7152 * g + 0.0722 * b;
	}

	// What's drawn on a solid mark: white, or near black on a pale color.
	const inkOn = (color) => (lightness(color) > 0.7 ? "#1d1d1f" : "#fff");

	// A profile's mark ({ icon or glyph, color, style }) as an element, for
	// the page to size: its icon, or its letter. A solid mark is drawn on its
	// color, and a clear one in it.
	function markElement(mark, path) {
		const node = document.createElement("span");
		node.className = `mark ${mark.style === "clear" ? "clear" : "solid"}`;
		node.style.setProperty("--mark", mark.color);
		node.style.setProperty("--ink", inkOn(mark.color));
		if (path) node.append(iconSvg(path));
		else node.textContent = mark.glyph ?? "";
		return node;
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

	return { api, isMac, isFirefox, DEFAULTS, loadSettings, onSettingsChange, watchLabel, iconSvg, lightness, inkOn, markElement, matches, fromEvent, keyName, format };
})();
