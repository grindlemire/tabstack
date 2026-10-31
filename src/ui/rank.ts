// --- search ---
//
// Three tiers, and the first one with any hits wins, so a precise query
// isn't buried under loose matches: exact substrings, then letters in
// order ("gpr" finds "GitHub Pull Request"), then near misses ("githb",
// "reqeust").

// What search reads of an item.
export interface Rankable {
	title?: string;
	url?: string;
	call?: boolean;
	audible?: boolean;
}

// What search lists, and where: a profile to switch to goes first.
export interface Listed extends Rankable {
	profileSwitch?: boolean;
}

// [start, end) of a match, in the lowercased text, which is only kept when
// it lines up with the text shown
export type Range = [number, number];

// Where the query matched an item's title and site, to highlight.
export interface Marks {
	title: Range[];
	site: Range[];
}

export interface Ranked<T> {
	item: T;
	marks: Marks | null;
	order?: number;
	score?: number;
}

interface Match {
	score: number;
	ranges: Range[];
}

type Matcher = (field: string, word: string) => Match | null;

export function host(url: string | undefined): string {
	try {
		return new URL(url ?? "").hostname.replace(/^www\./, "");
	} catch {
		return url ?? "";
	}
}

const BOUNDARY = /[^a-z0-9]/;

function substringMatch(field: string, word: string): Match | null {
	const at = field.indexOf(word);
	if (at < 0) return null;
	const bonus = at === 0 ? 3 : BOUNDARY.test(field[at - 1] ?? "") ? 2 : 0;
	return { score: 10 + bonus, ranges: [[at, at + word.length]] };
}

function subsequenceMatch(field: string, word: string): Match | null {
	if (word.length < 2) return null;
	const ranges: Range[] = [];
	let score = 6;
	let pos = 0;
	let last = -2;
	let atWordStarts = true; // every run of letters begins a word, like an acronym
	for (const ch of word) {
		const at = field.indexOf(ch, pos);
		if (at < 0) return null;
		if (at === last + 1) {
			score += 1;
			ranges.at(-1)![1] = at + 1;
		} else {
			if (at > 0 && !BOUNDARY.test(field[at - 1] ?? "")) {
				score -= 1;
				atWordStarts = false;
			}
			ranges.push([at, at + 1]);
		}
		last = at;
		pos = at + 1;
	}
	// letters strewn across a long title mean nothing, unless they start words
	if (!atWordStarts && last - ranges[0]![0] + 1 > word.length * 4) return null;
	return { score: Math.max(1, score + (atWordStarts ? 2 : 0)), ranges };
}

// Optimal string alignment distance: edits, with swapped neighbours as one.
function distance(a: string, b: string): number {
	const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i]);
	const at = (i: number, j: number) => d[i]?.[j] ?? 0;
	const set = (i: number, j: number, value: number) => (d[i]![j] = value);
	for (let j = 1; j <= b.length; j++) set(0, j, j);
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			set(i, j, Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + cost));
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
				set(i, j, Math.min(at(i, j), at(i - 2, j - 2) + 1));
			}
		}
	}
	return at(a.length, b.length);
}

function typoMatch(field: string, word: string): Match | null {
	if (word.length < 4) return null;
	const max = word.length >= 7 ? 2 : 1;
	let best: { d: number; range: Range } | null = null;
	for (const m of field.matchAll(/[a-z0-9]+/g)) {
		const token = m[0];
		// also compare with the token's start, for a half-typed word
		const d = Math.min(
			distance(word, token),
			token.length > word.length ? distance(word, token.slice(0, word.length)) : Infinity,
		);
		if (d <= max && (!best || d < best.d)) best = { d, range: [m.index, m.index + token.length] };
	}
	return best && { score: 4 - best.d, ranges: [best.range] };
}

const TIERS: Matcher[][] = [
	[substringMatch],
	[substringMatch, subsequenceMatch],
	[substringMatch, subsequenceMatch, typoMatch],
];

function scoreItem(item: Rankable, words: string[], matchers: Matcher[]): { score: number; marks: Marks } | null {
	const fields: { name: keyof Marks | null; text: string; weight: number; noTypos?: boolean }[] = [
		{ name: "title", text: (item.title ?? "").toLowerCase(), weight: 1 },
		{ name: "site", text: host(item.url).toLowerCase(), weight: 0.9 },
		{ name: null, text: (item.url ?? "").toLowerCase(), weight: 0.5, noTypos: true },
		// what it's doing, so "call" or "sound" finds it
		{
			name: null,
			text: `${item.call ? "call meeting " : ""}${item.audible ? "sound playing audio" : ""}`,
			weight: 0.95,
			noTypos: true,
		},
	];
	const marks: Marks = { title: [], site: [] };
	let total = 0;
	for (const word of words) {
		let best: { score: number; field: keyof Marks | null; ranges: Range[] } | null = null;
		for (const match of matchers) {
			for (const field of fields) {
				if (match === typoMatch && field.noTypos) continue;
				const m = match(field.text, word);
				if (!m) continue;
				const score = m.score * field.weight;
				if (!best || score > best.score) best = { score, field: field.name, ranges: m.ranges };
			}
		}
		if (!best) return null;
		total += best.score;
		if (best.field) marks[best.field].push(...best.ranges);
	}
	// the words together, in order, beat the same words scattered, and a
	// whole-word phrase ("page 1") beats a partial one ("page 19")
	const title = fields[0]?.text ?? "";
	// a letter whose lowercase is longer ("İ") would shift every mark after it
	if (title.length !== (item.title ?? "").length) marks.title = [];
	const phrase = words.join(" ");
	const at = words.length > 1 ? title.indexOf(phrase) : -1;
	if (at >= 0) total += BOUNDARY.test(title[at + phrase.length] ?? " ") ? 20 : 15;
	return { score: total, marks };
}

// Items matching the query, best first, with where each matched; every item,
// unmarked, for an empty query.
export function rank<T extends Rankable>(items: T[], query: string): Ranked<T>[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return items.map((item) => ({ item, marks: null }));
	for (const matchers of TIERS) {
		const hits: (Ranked<T> & { order: number; score: number })[] = [];
		items.forEach((item, order) => {
			const hit = scoreItem(item, words, matchers);
			if (hit) hits.push({ item, order, ...hit });
		});
		if (hits.length) {
			return hits.sort((a, b) => b.score - a.score || a.order - b.order);
		}
	}
	return [];
}

// What search lists for a query: the tab you're on (tabs[0]) never; closed
// tabs and other profiles once something's typed. Before anything's typed, a
// call comes first, then what's playing. A profile whose name matches goes
// above every tab.
export function searchResults<T extends Listed>(tabs: T[], closed: T[], profiles: T[], query: string): Ranked<T>[] {
	const q = query.trim();
	const ranked = rank([...tabs.slice(1), ...(q ? [...closed, ...profiles] : [])], q);
	// (sort is stable, so the rest keep their recency order)
	const order = (r: Ranked<T>) => (r.item.call ? 0 : r.item.audible ? 1 : 2);
	if (!q) ranked.sort((a, b) => order(a) - order(b));
	return [...ranked.filter((r) => r.item.profileSwitch), ...ranked.filter((r) => !r.item.profileSwitch)];
}

// Ranges in order, with overlapping and touching ones joined, so each run of
// matched letters is wrapped once.
export function mergeRanges(ranges: Range[]): Range[] {
	return [...ranges]
		.sort((a, b) => a[0] - b[0])
		.reduce<Range[]>((out, r) => {
			const last = out.at(-1);
			if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
			else out.push([r[0], r[1]]);
			return out;
		}, []);
}
