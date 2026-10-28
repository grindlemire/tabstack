// The switcher UI, shared by the page overlay (content.js) and the switcher
// window (switcher.js). It builds DOM without innerHTML and draws images on
// canvas, so a page's Trusted Types or img-src CSP can't break it.

globalThis.TabstackUI = (() => {
	const CARDS = 5;
	const CARD_MAX = 172;
	const CARD_MIN = 120; // narrower than this, show fewer cards instead
	const CARD_GAP = 8; // .cards gap
	const PANEL_INSET = 32 + 26; // page margin, plus the panel's padding and border
	const AUTO_SWITCH_DELAY = 150;
	const ROW_BATCH = 50; // search rows built at once; more as the selection nears the end

	const STYLE = `
:host { all: initial; }
.panel {
	--bg: rgba(250, 250, 252, 0.88);
	--fg: #1d1d1f;
	--muted: #6e6e73;
	--card: rgba(0, 0, 0, 0.05);
	--line: rgba(0, 0, 0, 0.1);
	--accent: #3b6cf6;
	--scroll: rgba(0, 0, 0, 0.22);
	box-sizing: border-box;
	font: 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
	color: var(--fg);
	background: var(--bg);
	-webkit-backdrop-filter: blur(24px) saturate(1.6);
	backdrop-filter: blur(24px) saturate(1.6);
	border: 1px solid var(--line);
	border-radius: 16px;
	padding: 12px;
	box-shadow: 0 24px 64px rgba(0, 0, 0, 0.35);
	outline: none;
}
@media (prefers-color-scheme: dark) {
	.panel {
		--bg: rgba(30, 30, 32, 0.88);
		--fg: #f5f5f7;
		--muted: #98989d;
		--card: rgba(255, 255, 255, 0.07);
		--line: rgba(255, 255, 255, 0.12);
		--scroll: rgba(255, 255, 255, 0.22);
	}
}
.panel[popover] {
	position: fixed;
	inset: 0;
	margin: auto;
	width: max-content;
	height: max-content;
	max-width: calc(100vw - 32px);
	overflow: hidden;
	transition: opacity 110ms ease-out, transform 140ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
@starting-style {
	.panel[popover]:popover-open { opacity: 0; transform: scale(0.96); }
}
.panel.docked { border: 0; border-radius: 0; box-shadow: none; background: none; -webkit-backdrop-filter: none; backdrop-filter: none; }
.panel:not(.searching) .search,
.panel:not(.searching) .rows,
.panel.searching .cards { display: none; }
.panel.searching { width: 560px; max-width: calc(100vw - 32px); }
/* the popup and the window are already the panel's size */
.panel.docked.searching { width: auto; max-width: none; }

.cards { position: relative; display: flex; gap: 8px; }
.card { position: relative; z-index: 1; box-sizing: border-box; width: var(--card-w, 172px); padding: 6px; border-radius: 10px; }
.ring {
	position: absolute;
	top: 0;
	bottom: 0;
	left: 0;
	width: var(--card-w, 172px);
	border-radius: 10px;
	background: var(--card);
	box-shadow: 0 0 0 2px var(--accent);
	transition: transform 130ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
.ring.instant { transition: none; }
.thumb {
	display: grid;
	place-items: center;
	width: 100%;
	aspect-ratio: 16 / 10;
	border-radius: 6px;
	background: var(--card);
	object-fit: cover;
	object-position: top;
}
.thumb .favicon { width: 28px; height: 28px; font-size: 14px; border-radius: 6px; }
.label { display: flex; align-items: center; gap: 6px; margin-top: 6px; min-width: 0; }

/* this profile, over search: its mark, or its initial, and its name, with
   its color washing down from the top of the panel */
.who { display: none; align-items: center; gap: 10px; min-width: 0; padding: 2px 2px 12px; }
.panel.searching.named .who { display: flex; }
.panel.named .rows { max-height: min(380px, calc(100vh - 186px)); }
.panel.searching.tinted { background-image: linear-gradient(color-mix(in srgb, var(--mark) 20%, transparent), transparent 110px); }
.panel.tinted .search { border-color: color-mix(in srgb, var(--mark) 40%, var(--line)); }
.who .mark {
	flex: none;
	display: grid;
	place-items: center;
	width: 28px;
	height: 28px;
	font-size: 15px;
	font-weight: 700;
	line-height: 1;
	border-radius: 8px;
}
.who .mark svg { width: 18px; height: 18px; }
.who .mark.solid { color: var(--ink); background: var(--mark); box-shadow: inset 0 0 0 0.5px rgba(0, 0, 0, 0.12), 0 1px 3px rgba(0, 0, 0, 0.16); }
.who .mark.clear { font-size: 22px; color: var(--mark); }
.who .mark.clear svg { width: 26px; height: 26px; }
.who .mark.plain { color: var(--muted); background: var(--card); box-shadow: inset 0 0 0 1px var(--line); }
.who .name { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 15px; font-weight: 650; letter-spacing: -0.01em; }
/* the other profiles, by their numbers, which switch to them until something's typed */
.switch-to { flex: none; display: flex; gap: 4px; transition: opacity 0.15s ease; }
.panel.typed .switch-to { opacity: 0.35; }
.to { display: inline-flex; align-items: center; gap: 5px; padding: 3px 5px 3px 7px; font-size: 11.5px; font-weight: 600; color: var(--muted); background: var(--card); border-radius: 7px; font-variant-numeric: tabular-nums; }
.to:hover { color: var(--fg); }
.who .to .mark { width: 18px; height: 18px; font-size: 10px; border-radius: 5px; }
.who .to .mark svg { width: 12px; height: 12px; }
.who .to .mark.clear { font-size: 15px; }
.who .to .mark.clear svg { width: 17px; height: 17px; }
/* no window open: switching opens one */
.to.closed .mark { opacity: 0.5; }

.search {
	box-sizing: border-box;
	width: 100%;
	padding: 9px 12px;
	font: inherit;
	font-size: 16px;
	color: var(--fg);
	background: var(--card);
	border: 1px solid var(--line);
	border-radius: 10px;
	outline: none;
}
.rows {
	margin-top: 8px;
	max-height: min(380px, calc(100vh - 140px));
	overflow-y: auto;
	/* a thin thumb in the panel's colors, with no track */
	scrollbar-width: thin;
	scrollbar-color: var(--scroll) transparent;
}
.row { display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: 8px; cursor: default; }
.row:hover:not(.selected) { background: var(--card); }
.row.selected { background: var(--accent); color: #fff; }
.row.selected .url { color: rgba(255, 255, 255, 0.8); }
.row.closed:not(.selected) .title { color: var(--muted); }
.text { flex: 1; min-width: 0; }
.url { color: var(--muted); font-size: 11.5px; }
.title, .url { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
mark { background: none; color: var(--accent); font-weight: 600; }
.row.selected mark { color: inherit; text-decoration: underline; text-underline-offset: 2px; }
.divider { padding: 10px 10px 4px; font-size: 11px; font-weight: 600; color: var(--muted); letter-spacing: 0.02em; }
.note { padding: 10px; color: var(--muted); }

.favicon { flex: none; width: 16px; height: 16px; border-radius: 3px; }
.letter {
	display: inline-grid;
	place-items: center;
	font-size: 10px;
	font-weight: 600;
	color: #fff;
	background: var(--accent);
	text-transform: uppercase;
}
.audible { flex: none; width: 13px; height: 13px; color: var(--muted); }
/* on a call: red, like a recording light */
.call { flex: none; width: 13px; height: 13px; color: #e5484d; }
.row.selected .audible, .row.selected .call { color: inherit; }
.profile {
	flex: none;
	display: inline-flex;
	align-items: center;
	gap: 5px;
	max-width: 120px;
	padding: 1px 7px;
	white-space: nowrap;
	font-size: 11px;
	color: var(--muted);
	background: var(--card);
	border-radius: 9px;
}
.profile-name { overflow: hidden; text-overflow: ellipsis; }
.row.selected .profile { color: #fff; background: rgba(255, 255, 255, 0.2); }

/* another profile's mark: by its tabs' names, and as the profile to switch to */
.row .mark { flex: none; display: inline-grid; place-items: center; font-weight: 700; line-height: 1; }
.row .mark.solid { color: var(--ink); background: var(--mark); }
.row .mark.clear { color: var(--mark); }
.row.selected .mark.clear { color: inherit; }
.row .mark.favicon { font-size: 10px; border-radius: 4px; }
.row .mark.favicon svg { width: 11px; height: 11px; }
.row .mark.favicon.clear svg { width: 16px; height: 16px; }
.profile .mark { width: 12px; height: 12px; margin-left: -3px; font-size: 8px; border-radius: 3px; }
.profile .mark svg { width: 8px; height: 8px; }
.profile .mark.clear svg { width: 12px; height: 12px; }

/* other profiles' rows, arriving a moment after this one's */
.row.arriving { animation: arriving 0.3s ease-out both; }
@keyframes arriving { from { opacity: 0; transform: translateY(-3px); } }
.debug { margin-top: 8px; font: 11px/1.4 ui-monospace, Menlo, monospace; color: var(--muted); white-space: pre-wrap; }
.debug:empty { display: none; }

@media (prefers-reduced-motion: reduce) {
	.panel[popover], .ring { transition: none; }
	.row.arriving { animation: none; }
}
`;

	function el(tag, className, text) {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (text != null) node.textContent = text;
		return node;
	}

	function host(url) {
		try {
			return new URL(url).hostname.replace(/^www\./, "");
		} catch {
			return url ?? "";
		}
	}

	// Decoding data URLs by hand (instead of <img src>) keeps the page's CSP
	// out of it.
	const bitmaps = new Map();
	function bitmapFor(key, dataUrl) {
		if (!bitmaps.has(key)) {
			const [head, base64] = dataUrl.split(",");
			const type = head.slice(5, head.indexOf(";"));
			const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
			bitmaps.set(key, createImageBitmap(new Blob([bytes], { type })).catch(() => null));
		}
		return bitmaps.get(key);
	}

	function canvasFor(key, dataUrl, className) {
		const canvas = el("canvas", className);
		bitmapFor(key, dataUrl).then((bitmap) => {
			if (!bitmap) return;
			canvas.width = bitmap.width;
			canvas.height = bitmap.height;
			canvas.getContext("2d").drawImage(bitmap, 0, 0);
		});
		return canvas;
	}

	function favicon(item) {
		if (item.icon) return canvasFor(item.icon, item.icon, "favicon");
		return el("span", "favicon letter", (host(item.url) || item.title || "?")[0]);
	}

	function glyph(className, d) {
		const ns = "http://www.w3.org/2000/svg";
		const svg = document.createElementNS(ns, "svg");
		svg.setAttribute("viewBox", "0 0 16 16");
		svg.setAttribute("class", className);
		const path = document.createElementNS(ns, "path");
		path.setAttribute("fill", "currentColor");
		path.setAttribute("d", d);
		svg.append(path);
		return svg;
	}

	const speaker = () =>
		glyph(
			"audible",
			"M2 6h2.5L8 3v10L4.5 10H2zM10.5 5.2a4 4 0 0 1 0 5.6l-.9-.9a2.7 2.7 0 0 0 0-3.8zM12.3 3.4a6.5 6.5 0 0 1 0 9.2l-.9-.9a5.2 5.2 0 0 0 0-7.4z",
		);

	// a microphone, for a tab on a call
	const microphone = () =>
		glyph(
			"call",
			"M8 1a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0v-4A2.5 2.5 0 0 0 8 1zM3.75 6.75a.75.75 0 0 1 .75.75 3.5 3.5 0 0 0 7 0 .75.75 0 0 1 1.5 0 5 5 0 0 1-4.25 4.94V14h1.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1 0-1.5h1.5v-1.56A5 5 0 0 1 3 7.5a.75.75 0 0 1 .75-.75z",
		);

	// What a tab's doing, by its title: on a call, or playing sound.
	function live(item) {
		const icons = [];
		if (item.call) icons.push(microphone());
		if (item.audible) icons.push(speaker());
		return icons;
	}

	// Text with the matched ranges wrapped in <mark>.
	function marked(text, ranges, className) {
		const node = el("div", className);
		const merged = [...(ranges ?? [])]
			.sort((a, b) => a[0] - b[0])
			.reduce((out, r) => {
				const last = out.at(-1);
				if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
				else out.push([...r]);
				return out;
			}, []);
		let at = 0;
		for (const [start, end] of merged) {
			node.append(text.slice(at, start), el("mark", null, text.slice(start, end)));
			at = end;
		}
		node.append(text.slice(at));
		return node;
	}

	// --- search ---
	//
	// Three tiers, and the first one with any hits wins, so a precise query
	// isn't buried under loose matches: exact substrings, then letters in
	// order ("gpr" finds "GitHub Pull Request"), then near misses ("githb",
	// "reqeust").

	const BOUNDARY = /[^a-z0-9]/;

	function substringMatch(field, word) {
		const at = field.indexOf(word);
		if (at < 0) return null;
		const bonus = at === 0 ? 3 : BOUNDARY.test(field[at - 1]) ? 2 : 0;
		return { score: 10 + bonus, ranges: [[at, at + word.length]] };
	}

	function subsequenceMatch(field, word) {
		if (word.length < 2) return null;
		const ranges = [];
		let score = 6;
		let pos = 0;
		let last = -2;
		let atWordStarts = true; // every run of letters begins a word, like an acronym
		for (const ch of word) {
			const at = field.indexOf(ch, pos);
			if (at < 0) return null;
			if (at === last + 1) {
				score += 1;
				ranges.at(-1)[1] = at + 1;
			} else {
				if (at > 0 && !BOUNDARY.test(field[at - 1])) {
					score -= 1;
					atWordStarts = false;
				}
				ranges.push([at, at + 1]);
			}
			last = at;
			pos = at + 1;
		}
		// letters strewn across a long title mean nothing, unless they start words
		if (!atWordStarts && last - ranges[0][0] + 1 > word.length * 4) return null;
		return { score: Math.max(1, score + (atWordStarts ? 2 : 0)), ranges };
	}

	// Optimal string alignment distance: edits, with swapped neighbours as one.
	function distance(a, b) {
		const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
		for (let j = 1; j <= b.length; j++) d[0][j] = j;
		for (let i = 1; i <= a.length; i++) {
			for (let j = 1; j <= b.length; j++) {
				const cost = a[i - 1] === b[j - 1] ? 0 : 1;
				d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
				if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
					d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
				}
			}
		}
		return d[a.length][b.length];
	}

	function typoMatch(field, word) {
		if (word.length < 4) return null;
		const max = word.length >= 7 ? 2 : 1;
		let best = null;
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

	const TIERS = [[substringMatch], [substringMatch, subsequenceMatch], [substringMatch, subsequenceMatch, typoMatch]];

	function scoreItem(item, words, matchers) {
		const fields = [
			{ name: "title", text: (item.title ?? "").toLowerCase(), weight: 1 },
			{ name: "site", text: host(item.url).toLowerCase(), weight: 0.9 },
			{ name: null, text: (item.url ?? "").toLowerCase(), weight: 0.5, noTypos: true },
			// what it's doing, so "call" or "sound" finds it
			{ name: null, text: `${item.call ? "call meeting " : ""}${item.audible ? "sound playing audio" : ""}`, weight: 0.95, noTypos: true },
		];
		const marks = { title: [], site: [] };
		let total = 0;
		for (const word of words) {
			let best = null;
			for (const match of matchers) {
				for (const field of fields) {
					if (match === typoMatch && field.noTypos) continue;
					const m = match(field.text, word);
					const score = m && m.score * field.weight;
					if (m && (!best || score > best.score)) best = { score, field: field.name, ranges: m.ranges };
				}
			}
			if (!best) return null;
			total += best.score;
			if (best.field) marks[best.field].push(...best.ranges);
		}
		// the words together, in order, beat the same words scattered, and a
		// whole-word phrase ("page 1") beats a partial one ("page 19")
		const phrase = words.join(" ");
		const at = words.length > 1 ? fields[0].text.indexOf(phrase) : -1;
		if (at >= 0) total += BOUNDARY.test(fields[0].text[at + phrase.length] ?? " ") ? 20 : 15;
		return { score: total, marks };
	}

	function rank(items, query) {
		const words = query.toLowerCase().split(/\s+/).filter(Boolean);
		if (!words.length) return items.map((item) => ({ item, marks: null }));
		for (const matchers of TIERS) {
			const hits = [];
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

	// --- the switcher ---

	class Switcher {
		constructor(root, { popover = false, onCommit, onCloseTab, onClose }) {
			this.onCommit = onCommit;
			this.onCloseTab = onCloseTab;
			this.onClose = onClose;
			this.autoSwitch = true;
			this.switchCode = null; // the switch shortcut's key; with Shift it goes back
			this.isOpen = false;
			this.mode = null;
			this.tabs = [];
			this.closed = [];
			this.profiles = []; // other profiles, to switch to by name
			this.profileMarks = {}; // profile -> its mark, to show by its rows
			this.switchTo = []; // other profiles, to switch to by number: { n, profile, name, mark, windows }
			this.arriving = null; // rows just added, which fade in
			this.results = [];
			this.selected = 0;
			this.drawn = null; // what render() last drew, so select() can patch it
			this.rowNodes = [];
			this.removed = new Set(); // tabs closed from the switcher, which a refill mustn't bring back

			// Constructed sheets aren't subject to the page's style-src CSP;
			// the <style> element covers browsers where adopting one fails.
			try {
				const sheet = new CSSStyleSheet();
				sheet.replaceSync(STYLE);
				root.adoptedStyleSheets.push(sheet);
			} catch {}
			root.append(el("style", null, STYLE));

			this.panel = el("div", popover ? "panel" : "panel docked");
			if (popover) this.panel.popover = "manual";
			this.who = el("div", "who");
			this.input = el("input", "search");
			this.input.placeholder = "Search tabs";
			this.input.spellcheck = false;
			this.input.autocomplete = "off";
			this.input.addEventListener("input", () => this.filter());
			this.cards = el("div", "cards");
			this.ring = el("div", "ring");
			this.rows = el("div", "rows");
			this.debug = el("div", "debug");
			this.panel.append(this.who, this.input, this.cards, this.rows, this.debug);
			root.append(this.panel);
		}

		// This profile's name over search, by its mark, or its initial when
		// it has none. Nothing shows until profiles are set up. A mark's color
		// tints the panel, and marks the selection when it's neither too pale
		// for white text nor too dark to see on a dark panel.
		setProfile(label) {
			const name = label?.name;
			const color = name && label.mark?.color;
			this.switchTo = (name && label.switchTo) || [];
			this.panel.classList.toggle("named", !!name);
			this.panel.classList.toggle("tinted", !!color);
			this.panel.style.removeProperty("--accent");
			if (color) {
				this.panel.style.setProperty("--mark", color);
				const light = TabstackShared.lightness(color);
				if (light > 0.08 && light < 0.6) this.panel.style.setProperty("--accent", color);
			}
			if (!name) {
				this.who.replaceChildren();
				return;
			}
			const mark = label.mark
				? TabstackShared.markElement(label.mark, label.mark.path)
				: el("span", "mark plain", [...name][0].toUpperCase());
			const switchTo = el("div", "switch-to");
			switchTo.append(...this.switchTo.map((p) => this.switchChip(p)));
			this.who.replaceChildren(mark, el("span", "name", name), switchTo);
		}

		// Another profile, by its number and mark; clicking it switches too.
		switchChip(p) {
			const chip = el("span", `to${p.windows ? "" : " closed"}`, String(p.n));
			chip.title = `${p.windows ? "Switch to" : "Open a window in"} ${p.name}`;
			chip.append(p.mark ? TabstackShared.markElement(p.mark, p.mark.path) : el("span", "mark plain", [...p.name][0].toUpperCase()));
			chip.addEventListener("click", () => this.switchProfile(p));
			return chip;
		}

		switchProfile(p) {
			this.onCommit({ profileSwitch: true, profile: p.profile });
			this.close();
		}

		open(mode, tabs, closed = []) {
			this.isOpen = true;
			this.mode = mode;
			this.input.value = "";
			this.debug.textContent = "";
			this.removed.clear();
			this.profiles = [];
			this.profileMarks = {};
			// the ring shouldn't slide over from where the last session left it
			this.ring.classList.add("instant");
			requestAnimationFrame(() => this.ring.classList.remove("instant"));
			this.setTabs(tabs, closed);
		}

		setTabs(tabs, closed = this.closed) {
			this.tabs = tabs;
			this.closed = closed;
			for (const tab of tabs) if (tab.thumb) bitmapFor(`${tab.id}:${tab.thumb.length}`, tab.thumb);
			if (this.mode === "search") this.filter();
			else this.select(Math.min(1, tabs.length - 1));
		}

		// Other profiles' tabs, and the profiles themselves, which arrive
		// after this one's tabs, with each profile's mark. The selection stays
		// put, and a lone match doesn't switch on its own, since the list just
		// changed under the person typing. They fade in, the once.
		addResults(tabs, closed, profiles = [], marks = {}) {
			if (!this.isOpen || this.mode !== "search") return;
			this.tabs = [...this.tabs, ...tabs];
			this.closed = [...this.closed, ...closed];
			this.profiles = profiles;
			this.profileMarks = marks;
			this.arriving = new Set([...tabs, ...closed, ...profiles]);
			this.filter({ keepSelection: true });
			this.arriving = null;
		}

		search() {
			this.mode = "search";
			this.filter();
			this.input.focus();
		}

		focusInput() {
			this.input.focus();
		}

		// Cycling covers only the cards on screen, and wraps; older tabs are
		// for search.
		items() {
			if (this.mode === "cycle") return this.tabs.slice(0, this.cardLayout().count);
			return this.results.map((r) => r.item);
		}

		// Moving the selection over what's already drawn only moves the ring or
		// the highlight, instead of rebuilding the panel.
		select(index) {
			const prev = this.selected;
			this.selected = index;
			const drawn = this.drawn;
			if (this.mode === "cycle" && drawn?.tabs === this.tabs && drawn.width === this.cardLayout().width) {
				this.ring.style.transform = `translateX(${index * (drawn.width + CARD_GAP)}px)`;
			} else if (this.mode === "search" && drawn?.results === this.results && index < this.rowNodes.length) {
				this.rowNodes[prev]?.classList.remove("selected");
				this.rowNodes[index]?.classList.add("selected");
				this.rowNodes[index]?.scrollIntoView({ block: "nearest" });
			} else {
				this.render();
			}
		}

		move(delta) {
			const count = this.items().length;
			if (count) this.select((this.selected + delta + count) % count);
		}

		// keepSelection keeps the same row selected, wherever it moves to (another
		// profile's call can arrive above it), or failing that, the same place.
		filter({ keepSelection = false } = {}) {
			const query = this.input.value.trim();
			this.panel.classList.toggle("typed", !!this.input.value);
			const kept = keepSelection ? this.results[this.selected]?.item : null;
			// the tab you're on is never a result; closed tabs and profiles show
			// once you type, and a profile whose name matches comes first
			const candidates = [...this.tabs.slice(1), ...(query ? [...this.closed, ...this.profiles] : [])];
			let ranked = rank(candidates, query);
			// before anything's typed, a call comes first, then what's playing
			if (!query) {
				const order = (r) => (r.item.call ? 0 : r.item.audible ? 1 : 2);
				ranked = ranked.map((r, i) => [r, i]).sort((a, b) => order(a[0]) - order(b[0]) || a[1] - b[1]).map(([r]) => r);
			}
			this.results = [...ranked.filter((r) => r.item.profileSwitch), ...ranked.filter((r) => !r.item.profileSwitch)];
			clearTimeout(this.autoTimer);
			const only = this.results.length === 1 && this.results[0].item;
			if (this.autoSwitch && query && only && !only.closed && !keepSelection) {
				this.autoTimer = setTimeout(() => this.commit(), AUTO_SWITCH_DELAY);
			}
			const at = kept ? this.results.findIndex((r) => r.item === kept) : -1;
			this.select(at >= 0 ? at : keepSelection ? Math.min(this.selected, this.results.length - 1) : 0);
		}

		commit() {
			const item = this.items()[this.selected];
			if (item) this.onCommit(item);
			this.close();
		}

		closeSelected() {
			const item = this.items()[this.selected];
			// another profile's tab can share an id with one here, so compare
			// the items themselves
			if (!item || item.closed || item.profileSwitch || item === this.tabs[0]) return;
			this.removed.add(item.id);
			// the background answers with the tabs now on top, to fill the gap
			Promise.resolve(this.onCloseTab(item)).then((reply) => reply?.tabs && this.addTabs(reply.tabs));
			this.tabs = this.tabs.filter((t) => t !== item);
			if (this.mode === "search") this.filter({ keepSelection: true });
			else this.select(Math.min(this.selected, this.items().length - 1));
		}

		// Cycling only gets the few most recent tabs, so closing one leaves a
		// gap; the next tab down moves into it.
		addTabs(tabs) {
			if (!this.isOpen || this.mode !== "cycle") return;
			const have = new Set(this.tabs.map((t) => t.id));
			const extra = tabs.filter((t) => !have.has(t.id) && !this.removed.has(t.id));
			if (!extra.length) return;
			for (const tab of extra) if (tab.thumb) bitmapFor(`${tab.id}:${tab.thumb.length}`, tab.thumb);
			this.tabs = [...this.tabs, ...extra];
			this.select(this.selected);
		}

		close() {
			if (!this.isOpen) return;
			this.isOpen = false;
			clearTimeout(this.autoTimer);
			this.onClose?.();
		}

		// Returns true when the key belonged to the switcher.
		handleKey(e) {
			const k = e.key;
			const cycling = this.mode === "cycle";
			const back = e.shiftKey && e.code === this.switchCode;
			const next = k === "ArrowDown" || (k === "Tab" && !e.shiftKey) || (e.ctrlKey && k === "n");
			const prev = k === "ArrowUp" || (k === "Tab" && e.shiftKey) || (e.ctrlKey && k === "p");
			// while searching, plain Backspace edits the query
			const closeTab = cycling
				? k === "Backspace" || k === "Delete" || e.code === "KeyX"
				: (e.metaKey || e.ctrlKey) && (k === "Backspace" || k === "Delete");
			// before anything's typed, another profile's number switches to it
			const to =
				!cycling && !this.input.value && !e.metaKey && !e.ctrlKey && !e.altKey && this.switchTo.find((p) => String(p.n) === k);
			if (to) this.switchProfile(to);
			else if (k === "Escape") this.close();
			else if (k === "Enter") this.commit();
			else if (closeTab) this.closeSelected();
			else if (back || prev || (cycling && k === "ArrowLeft")) this.move(-1);
			else if (next || (cycling && k === "ArrowRight")) this.move(1);
			else return false;
			return true;
		}

		setDebug(text) {
			this.debug.textContent = text;
		}

		render() {
			this.panel.classList.toggle("searching", this.mode === "search");
			if (this.mode === "cycle") this.renderCards();
			else this.renderRows();
		}

		// Cards shrink to fit narrow windows, and below a minimum width fewer
		// of them show, so the panel never needs a scrollbar.
		cardLayout() {
			const room = innerWidth - PANEL_INSET;
			const count = Math.max(1, Math.min(CARDS, Math.floor((room + CARD_GAP) / (CARD_MIN + CARD_GAP))));
			const width = Math.min(CARD_MAX, Math.floor((room - CARD_GAP * (count - 1)) / count));
			return { count, width };
		}

		renderCards() {
			const { count, width } = this.cardLayout();
			this.panel.style.setProperty("--card-w", `${width}px`);
			const cards = this.tabs.slice(0, count).map((tab, i) => {
				const card = el("div", "card");
				card.addEventListener("click", () => {
					this.selected = i;
					this.commit();
				});
				const label = el("div", "label");
				label.append(favicon(tab), el("span", "title", tab.title || host(tab.url)));
				label.append(...live(tab));
				card.append(this.thumb(tab), label);
				return card;
			});
			this.ring.hidden = !cards.length;
			this.ring.style.transform = `translateX(${this.selected * (width + CARD_GAP)}px)`;
			this.cards.replaceChildren(this.ring, ...cards);
			this.drawn = { tabs: this.tabs, width };
		}

		thumb(tab) {
			if (tab.thumb) return canvasFor(`${tab.id}:${tab.thumb.length}`, tab.thumb, "thumb");
			const empty = el("div", "thumb");
			empty.append(favicon(tab));
			return empty;
		}

		renderRows() {
			this.rowNodes = [];
			this.drawn = { results: this.results };
			if (!this.results.length) {
				const query = this.input.value.trim();
				this.rows.replaceChildren(el("div", "note", this.tabs.length || query ? "No matching tabs" : "Loading tabs…"));
				return;
			}
			const nodes = [];
			const count = Math.max(ROW_BATCH, this.selected + ROW_BATCH);
			this.results.slice(0, count).forEach(({ item, marks }, i) => {
				if (item.closed && !this.results[i - 1]?.item.closed) nodes.push(el("div", "divider", "Recently closed"));
				const row = el("div", `row${item.closed ? " closed" : ""}${i === this.selected ? " selected" : ""}`);
				if (this.arriving?.has(item)) row.classList.add("arriving");
				const text = el("div", "text");
				text.append(
					marked(item.title || host(item.url), marks?.title, "title"),
					item.subtitle ? el("div", "url", item.subtitle) : marked(host(item.url), marks?.site, "url"),
				);
				// a profile to switch to shows as its mark; another profile's
				// tab carries its mark by its name
				const profileMark = item.profile && this.profileMarks[item.profile];
				const mark = (className) => TabstackShared.markElement(profileMark, profileMark.path, className);
				row.append(item.profileSwitch && profileMark ? mark("favicon") : favicon(item), text);
				row.append(...live(item));
				if (item.profileName) {
					const pill = el("span", "profile");
					if (profileMark) pill.append(mark());
					pill.append(el("span", "profile-name", item.profileName));
					row.append(pill);
				}
				row.addEventListener("click", () => {
					this.selected = i;
					this.commit();
				});
				nodes.push(row);
				this.rowNodes.push(row);
			});
			this.rows.replaceChildren(...nodes);
			this.rows.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
		}
	}

	return { Switcher, rank };
})();
