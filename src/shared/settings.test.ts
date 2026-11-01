import { describe, expect, test } from "bun:test";
import { DEFAULTS, withDefaults } from "./settings";

const ctrlK = { code: "KeyK", key: "K", meta: false, ctrl: true, alt: false, shift: false };

describe("withDefaults", () => {
	test("the defaults for what isn't stored", () => {
		expect(withDefaults({})).toEqual(DEFAULTS);
		expect(withDefaults({ autoSwitch: false }).searchOnPage).toBe(true);
	});

	test("what's stored over them", () => {
		const s = withDefaults({ searchShortcut: ctrlK, searchOnPage: false });
		expect(s.searchShortcut).toEqual(ctrlK);
		expect(s.searchOnPage).toBe(false);
	});

	test("a shortcut stored as null (pre-release 1.2) is the default, turned off", () => {
		const s = withDefaults({ searchShortcut: null, showTimings: true });
		expect(s.searchShortcut).toEqual(DEFAULTS.searchShortcut);
		expect(s.searchOnPage).toBe(false);
		expect(s.showTimings).toBe(true);
	});
});
