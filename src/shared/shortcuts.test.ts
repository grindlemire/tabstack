import { describe, expect, test } from "bun:test";
import { format, fromEvent, keyName, matches, type Shortcut } from "./shortcuts";

// Only the fields the helpers read.
const key = (code: string, key: string, mods: Partial<KeyboardEvent> = {}) =>
	({ code, key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods }) as KeyboardEvent;

const cmdSlash: Shortcut = { code: "Slash", key: "/", meta: true, ctrl: false, alt: false, shift: false };

describe("matches", () => {
	test("the same key with the same modifiers", () => {
		expect(matches(key("Slash", "/", { metaKey: true }), cmdSlash)).toBe(true);
	});

	test("by the physical key, whatever it types", () => {
		expect(matches(key("Slash", "÷", { metaKey: true }), cmdSlash)).toBe(true);
		expect(matches(key("Period", "/", { metaKey: true }), cmdSlash)).toBe(false);
	});

	test("every modifier has to agree, held or not", () => {
		expect(matches(key("Slash", "/"), cmdSlash)).toBe(false);
		expect(matches(key("Slash", "/", { metaKey: true, shiftKey: true }), cmdSlash)).toBe(false);
		expect(matches(key("Slash", "/", { ctrlKey: true }), cmdSlash)).toBe(false);
		expect(matches(key("Slash", "/", { metaKey: true, altKey: true }), cmdSlash)).toBe(false);
	});

	test("a cleared shortcut matches nothing", () => {
		expect(matches(key("Slash", "/", { metaKey: true }), null)).toBe(false);
		expect(matches(key("KeyA", "a"), null)).toBe(false);
	});
});

describe("keyName", () => {
	test("letters and digits by their key, whatever Shift or Alt makes them", () => {
		expect(keyName("KeyK", "˚")).toBe("K");
		expect(keyName("Digit1", "!")).toBe("1");
	});

	test("punctuation and arrows by their symbol", () => {
		expect(keyName("Slash", "?")).toBe("/");
		expect(keyName("BracketLeft", "{")).toBe("[");
		expect(keyName("ArrowRight", "ArrowRight")).toBe("→");
	});

	test("anything else as the browser names it", () => {
		expect(keyName("F5", "F5")).toBe("F5");
		expect(keyName("IntlBackslash", "§")).toBe("§");
	});
});

describe("fromEvent", () => {
	test("a key and the modifiers held with it", () => {
		expect(fromEvent(key("KeyK", "K", { shiftKey: true, metaKey: true }))).toEqual({
			code: "KeyK",
			key: "K",
			meta: true,
			ctrl: false,
			alt: false,
			shift: true,
		});
	});

	test("names the physical key", () => {
		expect(fromEvent(key("Slash", "÷", { altKey: true }))?.key).toBe("/");
	});

	test("nothing yet for a lone modifier", () => {
		for (const name of ["Meta", "Control", "Alt", "Shift"]) {
			expect(fromEvent(key(`${name}Left`, name, { metaKey: name === "Meta" }))).toBeNull();
		}
	});
});

describe("format", () => {
	const all: Shortcut = { code: "KeyK", key: "K", meta: true, ctrl: true, alt: true, shift: true };

	test("as symbols on a Mac, in the order the menus use", () => {
		expect(format(cmdSlash, true)).toBe("⌘/");
		expect(format(all, true)).toBe("⌃⌥⇧⌘K");
	});

	test("as words joined by + elsewhere", () => {
		expect(format({ ...cmdSlash, meta: false, ctrl: true }, false)).toBe("Ctrl+/");
		expect(format(all, false)).toBe("Ctrl+Alt+Shift+Meta+K");
	});
});
