import { describe, expect, test } from "bun:test";
import { cleanClosed, cleanInfo, cleanTab, strings } from "./profiles";

describe("cleanInfo", () => {
	test("keeps what a profile says of itself when it's the right type", () => {
		const info = {
			name: "Work",
			mark: { icon: "briefcase", color: "#0a84ff", style: "clear" as const },
			claims: ["corp.com", "github.com/acme"],
			where: "Profile 1",
			done: "run-1",
			shared: { values: { stack: false, dupes: true }, at: 5 },
		};
		expect(cleanInfo(info)).toEqual(info);
	});

	test("drops fields of the wrong type", () => {
		expect(
			cleanInfo({
				name: 5,
				mark: { color: "#000", icon: 1, glyph: {}, style: "bold", path: "M0 0" },
				claims: [1, {}, "corp.com", null],
				where: [],
				done: false,
				shared: { values: { stack: "no", dupes: true }, at: 1 },
			}),
		).toEqual({
			mark: { color: "#000" },
			claims: ["corp.com"],
			shared: { values: { dupes: true }, at: 1 },
		});
	});

	test("a mark without a string color, claims that aren't a list, shared without its time", () => {
		expect(cleanInfo({ mark: { color: 5, glyph: "W" }, claims: "x", shared: { values: {} } })).toEqual({
			mark: null,
			claims: [],
		});
	});

	test("info that isn't an object is none", () => {
		for (const info of [undefined, null, "x", 5, ["a"]]) expect(cleanInfo(info)).toBeUndefined();
	});
});

describe("strings", () => {
	test("the strings in a list, or none", () => {
		expect(strings(["a", 1, "b"])).toEqual(["a", "b"]);
		expect(strings(null)).toEqual([]);
		expect(strings("a")).toEqual([]);
	});
});

describe("cleanTab", () => {
	test("keeps a well-formed row from another profile, without a thumbnail", () => {
		const tab = {
			id: 4,
			windowId: 2,
			title: "Inbox",
			url: "https://mail.example.com/",
			icon: "data:image/png;base64,AA",
			audible: true,
			call: false,
			thumb: "data:image/jpeg;base64,BB",
		};
		expect(cleanTab(tab)).toEqual({ ...tab, thumb: null });
	});

	test("drops fields of the wrong type, and rows without ids", () => {
		expect(cleanTab({ id: 1, windowId: 1, title: 5, url: {}, icon: "javascript:x", audible: "yes" })).toEqual({
			id: 1,
			windowId: 1,
			icon: null,
			audible: false,
			call: false,
			thumb: null,
		});
		for (const bad of [null, "tab", [], { id: "1", windowId: 1 }, { id: 1 }]) expect(cleanTab(bad)).toBeNull();
	});
});

describe("cleanClosed", () => {
	test("keeps the session id, title and address when they're strings", () => {
		expect(cleanClosed({ sessionId: "s1", title: "Docs", url: "https://docs.example.com/", icon: null })).toEqual({
			closed: true,
			sessionId: "s1",
			title: "Docs",
			url: "https://docs.example.com/",
			icon: null,
		});
		expect(cleanClosed({ sessionId: 3, title: ["x"] })).toEqual({ closed: true, icon: null });
		expect(cleanClosed(7)).toBeNull();
	});
});
