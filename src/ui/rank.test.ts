import { describe, expect, test } from "bun:test";
import { type Rankable, rank } from "./rank";

const titles = (items: Rankable[], query: string) => rank(items, query).map((r) => r.item.title);

describe("rank", () => {
	const tabs: Rankable[] = [
		{ title: "Inbox (3)", url: "https://mail.example.com/" },
		{ title: "GitHub Pull Request #42", url: "https://github.com/acme/app/pull/42" },
		{ title: "Grape prices", url: "https://grapes.example.com/" },
	];

	test("lists everything, unmarked and in order, before anything's typed", () => {
		expect(rank(tabs, "  ")).toEqual(tabs.map((item) => ({ item, marks: null })));
	});

	test("finds an acronym by the words' first letters", () => {
		const [hit] = rank(tabs, "gpr");
		expect(hit?.item.title).toBe("GitHub Pull Request #42");
		expect(hit?.marks?.title).toEqual([
			[0, 1],
			[7, 8],
			[12, 13],
		]);
	});

	test("an exact substring wins over letters in order", () => {
		// "grape" also has g, p, r in order, but "pull" is only a substring of one
		expect(titles(tabs, "pull")).toEqual(["GitHub Pull Request #42"]);
	});

	test("forgives a typo", () => {
		expect(titles(tabs, "githb")).toEqual(["GitHub Pull Request #42"]);
	});

	test("a whole-word phrase beats a partial one", () => {
		const pages = [{ title: "Page 19" }, { title: "Page 1" }];
		expect(titles(pages, "page 1")).toEqual(["Page 1", "Page 19"]);
	});

	test("finds a tab on a call by what it's doing", () => {
		const live = [...tabs, { title: "Standup", url: "https://meet.example.com/abc", call: true }];
		expect(titles(live, "call")).toEqual(["Standup"]);
	});
});
