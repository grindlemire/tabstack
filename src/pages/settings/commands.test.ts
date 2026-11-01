import { describe, expect, test } from "bun:test";
import type { Shortcut } from "../../shared/shortcuts";
import { firefoxShortcut, prettyCommand } from "./commands";

const shortcut = (code: string, mods: Partial<Shortcut> = {}): Shortcut => ({
	code,
	key: code,
	meta: false,
	ctrl: false,
	alt: false,
	shift: false,
	...mods,
});

describe("prettyCommand", () => {
	test("nothing for a command with no shortcut", () => {
		expect(prettyCommand(undefined, true)).toBe("");
		expect(prettyCommand("", false)).toBe("");
	});

	test("Firefox's names as symbols on a Mac", () => {
		expect(prettyCommand("Command+J", true)).toBe("⌘J");
		// in Firefox's order, not the menus'
		expect(prettyCommand("Command+Shift+Space", true)).toBe("⌘⇧Space");
		expect(prettyCommand("MacCtrl+Command+Right", true)).toBe("⌃⌘Right");
		expect(prettyCommand("Alt+Shift+J", true)).toBe("⌥⇧J");
	});

	test("Chrome's symbols as they are", () => {
		expect(prettyCommand("⌘J", true)).toBe("⌘J");
	});

	test("words as they are elsewhere", () => {
		expect(prettyCommand("Ctrl+Shift+J", false)).toBe("Ctrl+Shift+J");
	});
});

describe("firefoxShortcut", () => {
	test("letters, digits and F-keys by their name", () => {
		expect(firefoxShortcut(shortcut("KeyJ", { meta: true }), true)).toBe("Command+J");
		expect(firefoxShortcut(shortcut("Digit3", { alt: true }), true)).toBe("Alt+3");
		expect(firefoxShortcut(shortcut("F7", { ctrl: true }), false)).toBe("Ctrl+F7");
	});

	test("the other keys Firefox allows, by its names for them", () => {
		expect(firefoxShortcut(shortcut("ArrowLeft", { alt: true }), false)).toBe("Alt+Left");
		expect(firefoxShortcut(shortcut("Space", { ctrl: true, shift: true }), false)).toBe("Ctrl+Shift+Space");
	});

	test("Ctrl is MacCtrl on a Mac, and Cmd is Command", () => {
		expect(firefoxShortcut(shortcut("KeyJ", { ctrl: true, meta: true }), true)).toBe("Command+MacCtrl+J");
		expect(firefoxShortcut(shortcut("KeyJ", { ctrl: true }), false)).toBe("Ctrl+J");
	});

	test("modifiers in the order Firefox wants", () => {
		expect(firefoxShortcut(shortcut("KeyK", { alt: true, meta: true, ctrl: true, shift: true }), true)).toBe(
			"Alt+Command+MacCtrl+Shift+K",
		);
	});

	test("null for a key Firefox won't bind", () => {
		expect(firefoxShortcut(shortcut("Slash", { meta: true }), true)).toBeNull();
		expect(firefoxShortcut(shortcut("F13", { ctrl: true }), false)).toBeNull();
	});
});
