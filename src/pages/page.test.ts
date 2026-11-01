import { describe, expect, test } from "bun:test";
import { keycaps, ms } from "./page";

describe("keycaps", () => {
	test("a symbol each, then the key", () => {
		expect(keycaps("⇧⌘K")).toEqual(["⇧", "⌘", "K"]);
		expect(keycaps("⌃⌘→")).toEqual(["⌃", "⌘", "→"]);
	});

	test("a key with a long name stays whole", () => {
		expect(keycaps("⇧⌘Space")).toEqual(["⇧", "⌘", "Space"]);
	});

	test("split at + where the browser spells it out", () => {
		expect(keycaps("Ctrl+Shift+K")).toEqual(["Ctrl", "Shift", "K"]);
	});

	test("none for no shortcut", () => {
		expect(keycaps("")).toEqual([]);
	});
});

describe("ms", () => {
	test("seconds or milliseconds, as CSS writes them", () => {
		expect(ms("0.16s")).toBe(160);
		expect(ms(" 0.3s")).toBe(300);
		expect(ms("45ms")).toBe(45);
	});
});
