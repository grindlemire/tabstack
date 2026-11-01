import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { covers, pageKey } from "./covers";

// The helper's covers (cmd/tabstack/tabs_test.go) runs the same cases.
interface Case {
	pattern: string;
	url: string;
	covers: boolean;
}
const cases: Case[] = await Bun.file(join(import.meta.dir, "../../testdata/covers.json")).json();

describe("covers", () => {
	test.each(cases)("%o", ({ pattern, url, covers: want }) => {
		expect(covers(pattern, new URL(url))).toBe(want);
	});
});

describe("pageKey", () => {
	test("leaves out the fragment and a trailing slash", () => {
		expect(pageKey("https://corp.com/a/#top")).toBe("https://corp.com/a");
		expect(pageKey("https://corp.com/")).toBe(pageKey("https://corp.com"));
	});

	test("a tab with no address, or not a URL, matches nothing", () => {
		expect(pageKey(undefined)).toBeNull();
		expect(pageKey("")).toBeNull();
		expect(pageKey("not a url")).toBeNull();
	});
});
