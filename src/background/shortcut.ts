// Reads the switch shortcut as commands.getAll reports it.

import type { Modifier } from "../shared/messages";

// Chrome reports "⌥⌘J" on macOS and "Ctrl+J" elsewhere; Firefox uses
// "Command" and "MacCtrl", and its "Ctrl" means Command on macOS.
// biome-ignore format: a table, kept a few to a line
const SHORTCUT_KEYS: Record<string, string> = {
	",": "Comma", Comma: "Comma", ".": "Period", Period: "Period", Space: "Space",
	Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown", Insert: "Insert", Delete: "Delete",
	"↑": "ArrowUp", Up: "ArrowUp", "↓": "ArrowDown", Down: "ArrowDown",
	"←": "ArrowLeft", Left: "ArrowLeft", "→": "ArrowRight", Right: "ArrowRight",
};

// The shortcut's key as e.code (Shift with it goes back a tab), or null for
// one it doesn't know, and its modifier, the key whose release ends a cycle.
export function parseShortcut(
	shortcut: string,
	{ isMac, isFirefox }: { isMac: boolean; isFirefox: boolean },
): { code: string | null; modifier: Modifier } {
	const key = shortcut.includes("+") ? shortcut.split("+").pop()! : shortcut.replace(/[⌃⌥⇧⌘]/g, "");

	let code: string | null = SHORTCUT_KEYS[key] ?? null;
	if (/^[a-z]$/i.test(key)) code = `Key${key.toUpperCase()}`;
	else if (/^\d$/.test(key)) code = `Digit${key}`;
	else if (/^F\d+$/.test(key)) code = key;

	let modifier: Modifier = isMac ? "Meta" : "Control";
	if (/⌘|Command/.test(shortcut)) modifier = "Meta";
	else if (/⌃|MacCtrl/.test(shortcut)) modifier = "Control";
	else if (/Ctrl/.test(shortcut)) modifier = isMac && isFirefox ? "Meta" : "Control";
	else if (/⌥|Alt/.test(shortcut)) modifier = "Alt";

	return { code, modifier };
}
