import { describe, expect, test } from "bun:test";
import { type Listed, mergeRanges, type Rankable, rank, searchResults } from "./rank";

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

	test("an acronym beats the same letters inside words", () => {
		expect(titles(tabs, "gpr")).toEqual(["GitHub Pull Request #42", "Grape prices"]);
	});

	test("an exact substring wins over letters in order", () => {
		// "grape" also has g, p, r in order, but "pull" is only a substring of one
		expect(titles(tabs, "pull")).toEqual(["GitHub Pull Request #42"]);
		// "pilot sort" has p, o, r, t in order, but "report" has "port"
		expect(titles([{ title: "Pilot sort" }, { title: "Monthly report" }], "port")).toEqual(["Monthly report"]);
	});

	test("letters in order win over a typo", () => {
		const items = [{ title: "Chmr labs" }, { title: "Chrome" }];
		expect(titles(items, "chrm")).toEqual(["Chrome"]);
		// with nothing better, the swapped letters still find it
		expect(titles(items.slice(0, 1), "chrm")).toEqual(["Chmr labs"]);
	});

	test("forgives a typo", () => {
		expect(titles(tabs, "githb")).toEqual(["GitHub Pull Request #42"]);
		expect(titles([{ title: "Requiem" }, { title: "Request log" }], "reqeust")).toEqual(["Request log"]);
	});

	test("letters strewn across a title mean nothing, unless they start words", () => {
		expect(titles([{ title: "Organic produce" }], "gpu")).toEqual(["Organic produce"]);
		expect(titles([{ title: "Organic gardening, plus updates" }], "gpu")).toEqual([]);
		expect(titles([{ title: "Great pictures of a long trip, uploaded" }], "gpu")).toEqual([
			"Great pictures of a long trip, uploaded",
		]);
	});

	test("allows more typos in longer words", () => {
		const doc = [{ title: "My tabs and a document" }];
		// under four letters: none
		expect(titles(doc, "tbz")).toEqual([]);
		// four to six: one
		expect(titles(doc, "tabz")).toEqual(doc.map((d) => d.title));
		expect(titles(doc, "xabz")).toEqual([]);
		expect(titles(doc, "dacum")).toEqual(doc.map((d) => d.title));
		expect(titles(doc, "dacom")).toEqual([]);
		// seven or more: two
		expect(titles(doc, "dacumnt")).toEqual(doc.map((d) => d.title));
	});

	test("a match at the start, then at a word boundary, beats one inside a word", () => {
		const items = [{ title: "Airport map" }, { title: "Ship-port" }, { title: "Port of Seattle" }];
		expect(titles(items, "port")).toEqual(["Port of Seattle", "Ship-port", "Airport map"]);
	});

	test("the words together, in order, beat the same words scattered", () => {
		expect(titles([{ title: "Request to pull" }, { title: "Pull request" }], "pull request")).toEqual([
			"Pull request",
			"Request to pull",
		]);
	});

	test("a whole-word phrase beats a partial one", () => {
		const pages = [{ title: "Page 19" }, { title: "Page 1" }];
		expect(titles(pages, "page 1")).toEqual(["Page 1", "Page 19"]);
	});

	test("finds a tab on a call, or playing sound, by what it's doing", () => {
		const live = [
			...tabs,
			{ title: "Standup", url: "https://meet.example.com/abc", call: true },
			{ title: "Lo-fi beats", audible: true },
		];
		expect(titles(live, "call")).toEqual(["Standup"]);
		expect(titles(live, "meeting")).toEqual(["Standup"]);
		expect(titles(live, "sound")).toEqual(["Lo-fi beats"]);
		expect(titles(live, "playing")).toEqual(["Lo-fi beats"]);
		// what it's doing isn't text to forgive typos in
		expect(titles(live, "plyaing")).toEqual([]);
	});

	test("ties keep their recency order", () => {
		expect(titles([{ title: "Docs A" }, { title: "Docs B" }], "docs")).toEqual(["Docs A", "Docs B"]);
		expect(titles([{ title: "Docs B" }, { title: "Docs A" }], "docs")).toEqual(["Docs B", "Docs A"]);
	});

	test("marks nothing in a title whose lowercase is longer", () => {
		// "İ" lowercases to two characters, which would shift the marks
		const [dotted, plain] = rank([{ title: "İstanbul trip" }, { title: "Istanbul trip" }], "trip");
		expect(dotted?.marks?.title).toEqual([]);
		expect(plain?.marks?.title).toEqual([[9, 13]]);
	});
});

describe("searchResults", () => {
	const current: Listed = { title: "Here" };
	const tab = (title: string, extra: Partial<Listed> = {}): Listed => ({ title, ...extra });
	const names = (results: { item: Listed }[]) => results.map((r) => r.item.title);

	test("never lists the tab you're on", () => {
		expect(names(searchResults([current, tab("Here too")], [], [], ""))).toEqual(["Here too"]);
		expect(names(searchResults([current, tab("Here too")], [], [], "here"))).toEqual(["Here too"]);
	});

	test("before anything's typed: a call, then what's playing, then the rest in order", () => {
		const tabs = [current, tab("A"), tab("Music", { audible: true }), tab("B"), tab("Standup", { call: true })];
		expect(names(searchResults(tabs, [], [], ""))).toEqual(["Standup", "Music", "A", "B"]);
	});

	test("closed tabs and profiles only once something's typed", () => {
		const closed = [tab("Work notes")];
		const profiles = [tab("Work", { profileSwitch: true })];
		expect(names(searchResults([current, tab("Workout")], closed, profiles, " "))).toEqual(["Workout"]);
		expect(names(searchResults([current, tab("Workout")], closed, profiles, "work"))).toEqual([
			"Work",
			"Workout",
			"Work notes",
		]);
	});

	test("a matching profile goes above every tab, however they rank", () => {
		const profiles = [tab("Personal mail", { profileSwitch: true })];
		const results = searchResults([current, tab("Mail")], [], profiles, "mail");
		expect(names(results)).toEqual(["Personal mail", "Mail"]);
	});
});

describe("mergeRanges", () => {
	test("joins overlapping and touching ranges, in order", () => {
		const ranges: [number, number][] = [
			[5, 7],
			[0, 2],
			[1, 3],
			[3, 4],
		];
		expect(mergeRanges(ranges)).toEqual([
			[0, 4],
			[5, 7],
		]);
	});

	test("leaves the ranges it's given alone", () => {
		const ranges: [number, number][] = [
			[2, 4],
			[0, 3],
		];
		mergeRanges(ranges);
		expect(ranges).toEqual([
			[2, 4],
			[0, 3],
		]);
	});
});
