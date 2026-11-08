import { describe, expect, test } from "bun:test";
import { extensionApi } from "./api";

const chromeApi = { runtime: { sendMessage: () => {} } } as unknown as typeof chrome;

describe("extensionApi", () => {
	test("Firefox's browser.*", () => {
		const browser = { runtime: { sendMessage: () => {} } };
		expect(extensionApi({ browser, chrome: chromeApi })).toBe(browser as unknown as typeof chrome);
	});

	test("chrome.* when there's no browser", () => {
		expect(extensionApi({ chrome: chromeApi })).toBe(chromeApi);
	});

	test("not a page element named browser", () => {
		// an element, a collection of elements with that id, a form whose
		// control is named runtime
		for (const browser of [{ id: "browser" }, { length: 2, 0: {}, 1: {} }, { runtime: { id: "runtime" } }])
			expect(extensionApi({ browser, chrome: chromeApi })).toBe(chromeApi);
	});

	test("not a cross-origin frame named browser", () => {
		const frame = new Proxy(
			{},
			{
				get() {
					throw new DOMException("Blocked a frame", "SecurityError");
				},
			},
		);
		expect(extensionApi({ browser: frame, chrome: chromeApi })).toBe(chromeApi);
	});
});
