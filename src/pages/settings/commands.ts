// The browser's own commands (switch, search, and the profile ones), as the
// popup shows and, in Firefox, rebinds them.

import { isMac } from "../../shared/api";
import type { Shortcut } from "../../shared/shortcuts";

// Chrome reports "⌘J" on macOS already; Firefox reports "Command+J".
export function prettyCommand(shortcut: string | undefined, mac = isMac): string {
	if (!shortcut) return "";
	if (!mac) return shortcut;
	return shortcut
		.replace("MacCtrl+", "⌃")
		.replace("Alt+", "⌥")
		.replace("Shift+", "⇧")
		.replace(/(Command|Ctrl)\+/, "⌘");
}

// Firefox's names for the keys a command may use.
// biome-ignore format: a table, kept a few to a line
const FIREFOX_KEYS: Record<string, string> = {
	Comma: "Comma", Period: "Period", Space: "Space", Home: "Home", End: "End",
	PageUp: "PageUp", PageDown: "PageDown", Insert: "Insert", Delete: "Delete",
	ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
};

// A recorded shortcut as commands.update takes it, or null for a key
// Firefox won't bind.
export function firefoxShortcut(s: Shortcut, mac = isMac): string | null {
	const key = /^Key[A-Z]$/.test(s.code)
		? s.code.slice(3)
		: /^Digit\d$/.test(s.code)
			? s.code.slice(5)
			: /^F([1-9]|1[0-2])$/.test(s.code)
				? s.code
				: FIREFOX_KEYS[s.code];
	if (!key) return null;
	const mods = [];
	if (s.alt) mods.push("Alt");
	if (mac && s.meta) mods.push("Command");
	if (s.ctrl) mods.push(mac ? "MacCtrl" : "Ctrl");
	if (s.shift) mods.push("Shift");
	return [...mods, key].join("+");
}
