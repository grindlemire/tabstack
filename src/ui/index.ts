// The switcher UI, shared by the page overlay (content/index.ts) and the
// switcher window (pages/switcher). It builds DOM without innerHTML and draws
// images on canvas, so a page's Trusted Types or img-src CSP can't break it.

import { firstGlyph, lightness, markElement } from "../shared/marks";
import type {
	AnswerTo,
	ClosedItem,
	Elsewhere,
	Failed,
	Item,
	Label,
	Mark,
	MessageOf,
	ProfileSwitchItem,
	SearchTabs,
	SwitchTarget,
	TabItem,
} from "../shared/messages";
import { host, mergeRanges, type Range, type Ranked, searchResults } from "./rank";

const CARDS = 5;
const CARD_MAX = 172;
const CARD_MIN = 120; // narrower than this, show fewer cards instead
const CARD_GAP = 8;
const PAGE_MARGIN = 32; // kept clear around the panel, across both sides
const PANEL_PADDING = 12;
const PANEL_BORDER = 1;
const PANEL_INSET = PAGE_MARGIN + 2 * (PANEL_PADDING + PANEL_BORDER);
const AUTO_SWITCH_DELAY = 150;
const ROW_BATCH = 50; // search rows built at once; more as the selection or the scroll nears the end
const NEAR_END = 200; // px of rows left below the view when the next batch is built
// A mark's color marks the selection between these lightnesses (marks.ts):
// paler can't carry white text, and darker is lost on a dark panel.
const ACCENT_DARKEST = 0.08;
const ACCENT_PALEST = 0.6;

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
	border: ${PANEL_BORDER}px solid var(--line);
	border-radius: 16px;
	padding: ${PANEL_PADDING}px;
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
	max-width: calc(100vw - ${PAGE_MARGIN}px);
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
.panel.searching { width: 560px; max-width: calc(100vw - ${PAGE_MARGIN}px); }
/* the popup and the window are already the panel's size */
.panel.docked.searching { width: auto; max-width: none; }

.cards { position: relative; display: flex; gap: ${CARD_GAP}px; }
.card { position: relative; z-index: 1; box-sizing: border-box; width: var(--card-w, ${CARD_MAX}px); padding: 6px; border-radius: 10px; }
.ring {
	position: absolute;
	top: 0;
	bottom: 0;
	left: 0;
	width: var(--card-w, ${CARD_MAX}px);
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

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className?: string | null,
	text?: string | null,
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text != null) node.textContent = text;
	return node;
}

// Adds a stylesheet to a shadow root. Constructed sheets aren't subject to
// the page's style-src CSP; a <style> element covers browsers where adopting
// one fails. Either way, a later sheet cascades after an earlier one.
export function adoptStyle(root: ShadowRoot, css: string): void {
	try {
		const sheet = new CSSStyleSheet();
		sheet.replaceSync(css);
		root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
		if (root.adoptedStyleSheets.includes(sheet)) return;
	} catch {}
	root.append(el("style", null, css));
}

// Decoded images, by their data URL, which (unlike a tab's id) can't stand
// for an older image. Decoding by hand (instead of <img src>) keeps the
// page's CSP out of it.
const bitmaps = new Map<string, Promise<ImageBitmap | null>>();
function bitmapFor(dataUrl: string): Promise<ImageBitmap | null> {
	let bitmap = bitmaps.get(dataUrl);
	if (!bitmap) {
		const [head = "", base64 = ""] = dataUrl.split(",");
		const type = head.slice(5, head.indexOf(";"));
		const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
		bitmap = createImageBitmap(new Blob([bytes], { type })).catch(() => null);
		bitmaps.set(dataUrl, bitmap);
	}
	return bitmap;
}

// Lets go of the images none of items shows (all of them, for none). A
// canvas already waiting on one draws it first.
function keepBitmaps(items: Item[] = []): void {
	const keep = new Set(items.flatMap((item) => [item.icon, item.thumb]));
	for (const [url, bitmap] of bitmaps) {
		if (keep.has(url)) continue;
		bitmaps.delete(url);
		bitmap.then((b) => b?.close());
	}
}

function canvasFor(dataUrl: string, className: string): HTMLCanvasElement {
	const canvas = el("canvas", className);
	bitmapFor(dataUrl).then((bitmap) => {
		if (!bitmap) return;
		canvas.width = bitmap.width;
		canvas.height = bitmap.height;
		canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
	});
	return canvas;
}

// A letter standing in for a missing icon or mark.
const initial = (text: string | undefined): string => firstGlyph(text ?? "").toUpperCase();

function favicon(item: Item): HTMLElement {
	if (item.icon) return canvasFor(item.icon, "favicon");
	return el("span", "favicon letter", initial(host(item.url) || item.title) || "?");
}

function glyph(className: string, d: string): SVGSVGElement {
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
function live(item: Item): SVGSVGElement[] {
	const icons: SVGSVGElement[] = [];
	if (item.call) icons.push(microphone());
	if (item.audible) icons.push(speaker());
	return icons;
}

// Text with the matched ranges wrapped in <mark>.
function marked(text: string, ranges: Range[] | undefined, className: string): HTMLDivElement {
	const node = el("div", className);
	let at = 0;
	for (const [start, end] of mergeRanges(ranges ?? [])) {
		node.append(text.slice(at, start), el("mark", null, text.slice(start, end)));
		at = end;
	}
	node.append(text.slice(at));
	return node;
}

// --- what the switcher asks of the background ---

export type CommitMessage = MessageOf<"activate"> | MessageOf<"restore"> | MessageOf<"switchProfile">;

// What choosing an item asks for. profile is set on another profile's items
// (background/profiles.ts).
export function commitMessage(item: Item): CommitMessage {
	if (item.profileSwitch) return { type: "switchProfile", profile: item.profile };
	if (item.closed) return { type: "restore", sessionId: item.sessionId, profile: item.profile };
	return { type: "activate", tabId: item.id, windowId: item.windowId, profile: item.profile };
}

// The background's answer, or null for a refusal ({ ok: false }) or none
// (the extension went away).
export const answered = <T extends object>(answer: T | Failed | undefined): T | null =>
	answer && !("ok" in answer && answer.ok === false) ? (answer as T) : null;

// Search's lists, however the page asks for them: this profile's tabs, then
// other profiles', so a slow profile doesn't hold up this one's. null when
// there are none to give.
export interface SearchSource {
	tabs: () => Promise<SearchTabs | null>;
	elsewhere: () => Promise<Elsewhere | null>;
}

// --- the switcher ---

export type Mode = "cycle" | "search";

export interface SwitcherOptions {
	// a popover over the page, rather than filling a popup or window
	popover?: boolean;
	onCommit: (message: CommitMessage) => void;
	// may answer with the tabs now on top, to fill the gap
	onCloseTab: (message: MessageOf<"closeTab">) => void | Promise<AnswerTo<MessageOf<"closeTab">> | undefined>;
	onClose?: () => void;
}

export class Switcher {
	onCommit: SwitcherOptions["onCommit"];
	onCloseTab: SwitcherOptions["onCloseTab"];
	onClose: SwitcherOptions["onClose"];
	autoSwitch: boolean;
	switchCode: string | null;
	isOpen: boolean;
	mode: Mode | null;
	tabs: TabItem[];
	closed: ClosedItem[];
	profiles: ProfileSwitchItem[];
	profileMarks: Record<string, Mark>;
	switchTo: SwitchTarget[];
	arriving: Set<Item> | null;
	results: Ranked<Item>[];
	selected: number;
	drawn: { tabs?: TabItem[]; width?: number; results?: Ranked<Item>[] } | null;
	rowNodes: HTMLDivElement[];
	removed: Set<number>;
	session: number;
	autoTimer: ReturnType<typeof setTimeout> | undefined;
	panel: HTMLDivElement;
	who: HTMLDivElement;
	input: HTMLInputElement;
	cards: HTMLDivElement;
	ring: HTMLDivElement;
	rows: HTMLDivElement;
	debug: HTMLDivElement;

	constructor(root: ShadowRoot, { popover = false, onCommit, onCloseTab, onClose }: SwitcherOptions) {
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
		this.session = 0; // counts opens, so an answer for an earlier one is dropped

		adoptStyle(root, STYLE);

		this.panel = el("div", popover ? "panel" : "panel docked");
		if (popover) this.panel.popover = "manual";
		this.who = el("div", "who");
		this.input = el("input", "search");
		this.input.placeholder = "Search tabs";
		this.input.spellcheck = false;
		this.input.autocomplete = "off";
		this.input.setAttribute("aria-label", "Search tabs");
		this.input.setAttribute("aria-controls", "rows");
		this.input.addEventListener("input", () => this.filter());
		this.cards = el("div", "cards");
		this.ring = el("div", "ring");
		this.rows = el("div", "rows");
		this.rows.id = "rows";
		this.rows.setAttribute("role", "listbox");
		this.rows.setAttribute("aria-label", "Tabs");
		this.rows.addEventListener("scroll", () => {
			const rows = this.rows;
			const nearEnd = rows.scrollTop + rows.clientHeight > rows.scrollHeight - NEAR_END;
			if (nearEnd && this.drawn?.results === this.results) this.appendRows(ROW_BATCH);
		});
		this.debug = el("div", "debug");
		this.panel.append(this.who, this.input, this.cards, this.rows, this.debug);
		root.append(this.panel);
	}

	// This profile's name over search, by its mark, or its initial when
	// it has none. Nothing shows until profiles are set up. A mark's color
	// tints the panel, and marks the selection when it's neither too pale
	// for white text nor too dark to see on a dark panel.
	setProfile(label: Label | null): void {
		const name = label?.name;
		const color = name && label?.mark?.color;
		this.switchTo = (name && label?.switchTo) || [];
		this.panel.classList.toggle("named", !!name);
		this.panel.classList.toggle("tinted", !!color);
		this.panel.style.removeProperty("--accent");
		if (color) {
			this.panel.style.setProperty("--mark", color);
			const light = lightness(color);
			if (light > ACCENT_DARKEST && light < ACCENT_PALEST) this.panel.style.setProperty("--accent", color);
		}
		if (!name) {
			this.who.replaceChildren();
			return;
		}
		const mark = label?.mark ? markElement(label.mark, label.mark.path) : el("span", "mark plain", initial(name));
		const switchTo = el("div", "switch-to");
		switchTo.append(...this.switchTo.map((p) => this.switchChip(p)));
		this.who.replaceChildren(mark, el("span", "name", name), switchTo);
	}

	// Another profile, by its number and mark; clicking it switches too.
	switchChip(p: SwitchTarget): HTMLSpanElement {
		const chip = el("span", `to${p.windows ? "" : " closed"}`, String(p.n));
		chip.title = `${p.windows ? "Switch to" : "Open a window in"} ${p.name}`;
		chip.append(p.mark ? markElement(p.mark, p.mark.path) : el("span", "mark plain", initial(p.name)));
		chip.addEventListener("click", () => this.switchProfile(p));
		return chip;
	}

	switchProfile(p: SwitchTarget): void {
		this.onCommit(commitMessage({ profileSwitch: true, profile: p.profile }));
		this.close();
	}

	open(mode: Mode, tabs: TabItem[], closed: ClosedItem[] = []): void {
		this.isOpen = true;
		this.session++;
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

	setTabs(tabs: TabItem[], closed: ClosedItem[] = this.closed): void {
		this.tabs = tabs;
		this.closed = closed;
		keepBitmaps([...tabs, ...closed]);
		for (const tab of tabs) if (tab.thumb) bitmapFor(tab.thumb);
		if (this.mode === "search") this.filter();
		else this.select(Math.min(1, tabs.length - 1));
	}

	// Other profiles' tabs, and the profiles themselves, which arrive
	// after this one's tabs, with each profile's mark. The selection stays
	// put, and a lone match doesn't switch on its own, since the list just
	// changed under the person typing. They fade in, the once.
	addResults(
		tabs: TabItem[],
		closed: ClosedItem[],
		profiles: ProfileSwitchItem[] = [],
		marks: Record<string, Mark> = {},
	): void {
		if (!this.isOpen || this.mode !== "search") return;
		this.tabs = [...this.tabs, ...tabs];
		this.closed = [...this.closed, ...closed];
		this.profiles = profiles;
		this.profileMarks = marks;
		this.arriving = new Set([...tabs, ...closed, ...profiles]);
		this.filter({ keepSelection: true });
		this.arriving = null;
	}

	// Turns to search, from a cycle or as it opens, or just puts the cursor
	// back in the box when it's already searching.
	search(): void {
		if (this.mode !== "search") {
			this.mode = "search";
			this.filter();
		}
		this.input.focus();
	}

	// Fills search from source, this profile's tabs and then other
	// profiles'. What arrives after the switcher closed, or opened again,
	// is for a session that's gone, so it's dropped.
	async load(source: SearchSource): Promise<void> {
		const session = this.session;
		const current = () => this.isOpen && this.session === session;
		const lists = await source.tabs();
		if (!current() || !lists) return;
		this.setTabs(lists.tabs, lists.closed);
		const elsewhere = await source.elsewhere();
		if (!current() || !elsewhere) return;
		if (elsewhere.tabs.length || elsewhere.closed.length || elsewhere.profiles.length) {
			this.addResults(elsewhere.tabs, elsewhere.closed, elsewhere.profiles, elsewhere.marks);
		}
	}

	// Cycling covers only the cards on screen, and wraps; older tabs are
	// for search.
	items(): Item[] {
		if (this.mode === "cycle") return this.tabs.slice(0, this.cardLayout().count);
		return this.results.map((r) => r.item);
	}

	// Moving the selection over what's already drawn only moves the ring or
	// the highlight, instead of rebuilding the panel.
	select(index: number): void {
		const prev = this.selected;
		this.selected = index;
		const drawn = this.drawn;
		if (this.mode === "cycle" && drawn?.tabs === this.tabs && drawn.width === this.cardLayout().width) {
			this.ring.style.transform = `translateX(${index * (drawn.width + CARD_GAP)}px)`;
		} else if (this.mode === "search" && drawn?.results === this.results) {
			if (index >= this.rowNodes.length) this.appendRows(index - this.rowNodes.length + ROW_BATCH);
			this.rowNodes[prev]?.classList.remove("selected");
			this.rowNodes[prev]?.setAttribute("aria-selected", "false");
			this.markSelected();
		} else {
			this.render();
		}
	}

	move(delta: number): void {
		const count = this.items().length;
		if (count) this.select((this.selected + delta + count) % count);
	}

	// keepSelection keeps the same row selected, wherever it moves to (another
	// profile's call can arrive above it), or failing that, the same place.
	filter({ keepSelection = false }: { keepSelection?: boolean } = {}): void {
		const query = this.input.value.trim();
		this.panel.classList.toggle("typed", !!this.input.value);
		const kept = keepSelection ? this.results[this.selected]?.item : null;
		this.results = searchResults<Item>(this.tabs, this.closed, this.profiles, query);
		clearTimeout(this.autoTimer);
		const only = this.results.length === 1 && this.results[0]?.item;
		if (this.autoSwitch && query && only && !only.closed && !keepSelection) {
			this.autoTimer = setTimeout(() => this.commit(), AUTO_SWITCH_DELAY);
		}
		const at = kept ? this.results.findIndex((r) => r.item === kept) : -1;
		this.select(at >= 0 ? at : keepSelection ? Math.min(this.selected, this.results.length - 1) : 0);
	}

	commit(): void {
		const item = this.items()[this.selected];
		if (item) this.onCommit(commitMessage(item));
		this.close();
	}

	closeSelected(): void {
		const item = this.items()[this.selected];
		// another profile's tab can share an id with one here, so compare
		// the items themselves
		if (!item || item.closed || item.profileSwitch || item === this.tabs[0]) return;
		this.removed.add(item.id);
		// the background answers with the tabs now on top, to fill the gap
		Promise.resolve(this.onCloseTab({ type: "closeTab", tabId: item.id, profile: item.profile })).then(
			(reply) => reply && "tabs" in reply && this.addTabs(reply.tabs),
		);
		this.tabs = this.tabs.filter((t) => t !== item);
		if (this.mode === "search") this.filter({ keepSelection: true });
		else this.select(Math.min(this.selected, this.items().length - 1));
	}

	// Cycling only gets the few most recent tabs, so closing one leaves a
	// gap; the next tab down moves into it.
	addTabs(tabs: TabItem[]): void {
		if (!this.isOpen || this.mode !== "cycle") return;
		const have = new Set(this.tabs.map((t) => t.id));
		const extra = tabs.filter((t) => !have.has(t.id) && !this.removed.has(t.id));
		if (!extra.length) return;
		for (const tab of extra) if (tab.thumb) bitmapFor(tab.thumb);
		this.tabs = [...this.tabs, ...extra];
		this.select(this.selected);
	}

	close(): void {
		if (!this.isOpen) return;
		this.isOpen = false;
		clearTimeout(this.autoTimer);
		keepBitmaps();
		this.onClose?.();
	}

	// Returns true when the key belonged to the switcher.
	handleKey(e: KeyboardEvent): boolean {
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
			!cycling &&
			!this.input.value &&
			!e.metaKey &&
			!e.ctrlKey &&
			!e.altKey &&
			this.switchTo.find((p) => String(p.n) === k);
		if (to) this.switchProfile(to);
		else if (k === "Escape") this.close();
		else if (k === "Enter") this.commit();
		else if (closeTab) this.closeSelected();
		else if (back || prev || (cycling && k === "ArrowLeft")) this.move(-1);
		else if (next || (cycling && k === "ArrowRight")) this.move(1);
		else return false;
		return true;
	}

	setDebug(text: string): void {
		this.debug.textContent = text;
	}

	render(): void {
		this.panel.classList.toggle("searching", this.mode === "search");
		if (this.mode === "cycle") this.renderCards();
		else this.renderRows();
	}

	// Cards shrink to fit narrow windows, and below a minimum width fewer
	// of them show, so the panel never needs a scrollbar.
	cardLayout(): { count: number; width: number } {
		const room = innerWidth - PANEL_INSET;
		const count = Math.max(1, Math.min(CARDS, Math.floor((room + CARD_GAP) / (CARD_MIN + CARD_GAP))));
		const width = Math.min(CARD_MAX, Math.floor((room - CARD_GAP * (count - 1)) / count));
		return { count, width };
	}

	renderCards(): void {
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

	thumb(tab: TabItem): HTMLElement {
		if (tab.thumb) return canvasFor(tab.thumb, "thumb");
		const empty = el("div", "thumb");
		empty.append(favicon(tab));
		return empty;
	}

	renderRows(): void {
		this.rowNodes = [];
		this.drawn = { results: this.results };
		this.input.removeAttribute("aria-activedescendant");
		if (!this.results.length) {
			const query = this.input.value.trim();
			const note = el("div", "note", this.tabs.length || query ? "No matching tabs" : "Loading tabs…");
			note.setAttribute("role", "presentation"); // in a listbox, but not an option
			this.rows.replaceChildren(note);
			return;
		}
		this.rows.replaceChildren();
		this.appendRows(this.selected + ROW_BATCH);
		this.markSelected();
	}

	// Builds up to count more rows, below those already built.
	appendRows(count: number): void {
		const nodes: HTMLDivElement[] = [];
		const from = this.rowNodes.length;
		this.results.slice(from, from + count).forEach(({ item, marks }, n) => {
			const i = from + n;
			if (item.closed && !this.results[i - 1]?.item.closed) {
				const divider = el("div", "divider", "Recently closed");
				divider.setAttribute("role", "presentation");
				nodes.push(divider);
			}
			const row = el("div", `row${item.closed ? " closed" : ""}`);
			row.id = `row-${i}`;
			row.setAttribute("role", "option");
			row.setAttribute("aria-selected", "false");
			if (this.arriving?.has(item)) row.classList.add("arriving");
			const text = el("div", "text");
			text.append(
				marked(item.title || host(item.url), marks?.title, "title"),
				item.subtitle ? el("div", "url", item.subtitle) : marked(host(item.url), marks?.site, "url"),
			);
			// a profile to switch to shows as its mark; another profile's
			// tab carries its mark by its name
			const profileMark = item.profile ? this.profileMarks[item.profile] : undefined;
			const mark = (m: Mark, className?: string) => markElement(m, m.path, className);
			row.append(item.profileSwitch && profileMark ? mark(profileMark, "favicon") : favicon(item), text);
			row.append(...live(item));
			if (item.profileName) {
				const pill = el("span", "profile");
				if (profileMark) pill.append(mark(profileMark));
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
		this.rows.append(...nodes);
	}

	// Highlights the selected row, for the eye and for screen readers.
	markSelected(): void {
		const row = this.rowNodes[this.selected];
		if (!row) return;
		row.classList.add("selected");
		row.setAttribute("aria-selected", "true");
		this.input.setAttribute("aria-activedescendant", row.id);
		row.scrollIntoView({ block: "nearest" });
	}
}
