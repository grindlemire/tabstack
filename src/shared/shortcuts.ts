// Keyboard-shortcut helpers used by every tabstack context.

import { isMac } from "./api";

// A key and the modifiers held with it. code is the physical key (e.code),
// and key the name it's shown by.
export interface Shortcut {
	code: string;
	key: string;
	meta: boolean;
	ctrl: boolean;
	alt: boolean;
	shift: boolean;
}

export function matches(e: KeyboardEvent, shortcut: Shortcut): boolean {
	return (
		e.code === shortcut.code &&
		e.metaKey === shortcut.meta &&
		e.ctrlKey === shortcut.ctrl &&
		e.altKey === shortcut.alt &&
		e.shiftKey === shortcut.shift
	);
}

// biome-ignore format: a table, kept a few to a line
const KEY_NAMES: Record<string, string> = {
	Slash: "/", Period: ".", Comma: ",", Semicolon: ";", Quote: "'", Backquote: "`",
	BracketLeft: "[", BracketRight: "]", Backslash: "\\", Minus: "-", Equal: "=",
	Space: "Space", Enter: "Enter", Tab: "Tab",
	ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
};

// Names the physical key, since e.key changes with Alt and Shift.
export function keyName(code: string, fallback: string): string {
	if (/^Key[A-Z]$/.test(code)) return code.slice(3);
	if (/^Digit\d$/.test(code)) return code.slice(5);
	return KEY_NAMES[code] ?? fallback;
}

// Returns null for a lone modifier press.
export function fromEvent(e: KeyboardEvent): Shortcut | null {
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

export function format(s: Shortcut): string {
	if (isMac) return `${s.ctrl ? "⌃" : ""}${s.alt ? "⌥" : ""}${s.shift ? "⇧" : ""}${s.meta ? "⌘" : ""}${s.key}`;
	return [s.ctrl && "Ctrl", s.alt && "Alt", s.shift && "Shift", s.meta && "Meta", s.key].filter(Boolean).join("+");
}
