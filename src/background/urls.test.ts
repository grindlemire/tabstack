import { describe, expect, test } from "bun:test";
import { overlayCanRun } from "./urls";

describe("overlayCanRun", () => {
	test("web pages", () => {
		expect(overlayCanRun("https://example.com/")).toBe(true);
		expect(overlayCanRun("http://localhost:8080/app")).toBe(true);
		expect(overlayCanRun("https://chrome.google.com/search")).toBe(true);
	});

	test("not the browser's own pages, whichever browser", () => {
		for (const url of [
			"chrome://extensions/",
			"chrome-extension://abc/settings.html",
			"chrome-search://local-ntp/local-ntp.html",
			"edge://settings",
			"brave://settings",
			"vivaldi://settings",
			"opera://settings",
			"about:blank",
			"about:newtab",
			"moz-extension://abc/switcher.html",
			"devtools://devtools/bundled/inspector.html",
			"view-source:https://example.com/",
		])
			expect(overlayCanRun(url)).toBe(false);
	});

	test("not files, data: or a page with no address", () => {
		expect(overlayCanRun("file:///Users/me/notes.txt")).toBe(false);
		expect(overlayCanRun("data:text/html,hi")).toBe(false);
		expect(overlayCanRun("")).toBe(false);
		expect(overlayCanRun(undefined)).toBe(false);
	});

	test("not the extension stores", () => {
		expect(overlayCanRun("https://chromewebstore.google.com/detail/tabstack/abc")).toBe(false);
		expect(overlayCanRun("https://chrome.google.com/webstore/detail/abc")).toBe(false);
		expect(overlayCanRun("https://addons.mozilla.org/en-US/firefox/addon/tabstack/")).toBe(false);
	});
});
