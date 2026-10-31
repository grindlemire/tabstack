import { describe, expect, test } from "bun:test";
import { parseShortcut } from "./shortcut";

const chromeMac = { isMac: true, isFirefox: false };
const chromeElse = { isMac: false, isFirefox: false };
const firefoxMac = { isMac: true, isFirefox: true };
const firefoxElse = { isMac: false, isFirefox: true };

describe("parseShortcut", () => {
	test("Chrome on macOS: symbols, no separators", () => {
		expect(parseShortcut("⌘J", chromeMac)).toEqual({ code: "KeyJ", modifier: "Meta" });
		expect(parseShortcut("⌥⌘J", chromeMac)).toEqual({ code: "KeyJ", modifier: "Meta" });
		expect(parseShortcut("⌃J", chromeMac)).toEqual({ code: "KeyJ", modifier: "Control" });
		expect(parseShortcut("⌥⇧J", chromeMac)).toEqual({ code: "KeyJ", modifier: "Alt" });
		expect(parseShortcut("⇧⌘,", chromeMac)).toEqual({ code: "Comma", modifier: "Meta" });
		expect(parseShortcut("⌃⌘→", chromeMac)).toEqual({ code: "ArrowRight", modifier: "Meta" });
	});

	test("Chrome on Windows and Linux", () => {
		expect(parseShortcut("Ctrl+J", chromeElse)).toEqual({ code: "KeyJ", modifier: "Control" });
		expect(parseShortcut("Ctrl+Shift+Space", chromeElse)).toEqual({ code: "Space", modifier: "Control" });
		expect(parseShortcut("Alt+Shift+Right", chromeElse)).toEqual({ code: "ArrowRight", modifier: "Alt" });
		expect(parseShortcut("Ctrl+5", chromeElse)).toEqual({ code: "Digit5", modifier: "Control" });
		expect(parseShortcut("Alt+F7", chromeElse)).toEqual({ code: "F7", modifier: "Alt" });
		expect(parseShortcut("Ctrl+Period", chromeElse)).toEqual({ code: "Period", modifier: "Control" });
	});

	test("Firefox on macOS: Ctrl means Command, MacCtrl means Control", () => {
		expect(parseShortcut("Command+J", firefoxMac)).toEqual({ code: "KeyJ", modifier: "Meta" });
		expect(parseShortcut("Ctrl+J", firefoxMac)).toEqual({ code: "KeyJ", modifier: "Meta" });
		expect(parseShortcut("MacCtrl+J", firefoxMac)).toEqual({ code: "KeyJ", modifier: "Control" });
		expect(parseShortcut("MacCtrl+Command+Left", firefoxMac)).toEqual({ code: "ArrowLeft", modifier: "Meta" });
		expect(parseShortcut("Alt+Shift+Comma", firefoxMac)).toEqual({ code: "Comma", modifier: "Alt" });
	});

	test("Firefox elsewhere", () => {
		expect(parseShortcut("Ctrl+J", firefoxElse)).toEqual({ code: "KeyJ", modifier: "Control" });
		expect(parseShortcut("Alt+Shift+Down", firefoxElse)).toEqual({ code: "ArrowDown", modifier: "Alt" });
	});

	test("no shortcut: no key, and the platform's usual modifier", () => {
		expect(parseShortcut("", chromeMac)).toEqual({ code: null, modifier: "Meta" });
		expect(parseShortcut("", chromeElse)).toEqual({ code: null, modifier: "Control" });
	});

	test("a key it doesn't know has no code, but keeps its modifier", () => {
		expect(parseShortcut("Ctrl+MediaPlayPause", chromeElse)).toEqual({ code: null, modifier: "Control" });
	});
});
