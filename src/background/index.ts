// Keeps the most-recently-used tab stack and routes the switch shortcut to
// the page overlay (content/index.ts). On pages extensions can't touch, it
// jumps to the previous tab and continues there. Searching from those pages
// opens the switcher in the toolbar popup. Thumbnails and favicons are
// thumbnails.ts's.

// Working across profiles (profiles.ts) is Chrome only for now; the Firefox
// build leaves it out (FIREFOX_BUILD).

import { api, isFirefox, isMac } from "../shared/api";
import { ICONS as MARK_ICONS } from "../shared/icons";
import { inkOn } from "../shared/marks";
import type {
	ClosedItem,
	Elsewhere,
	Failed,
	Label,
	Mark,
	Message,
	MessageOf,
	MessageType,
	PageMessage,
	PortReply,
	Results,
	SearchTabs,
	StartMessage,
	TabItem,
	Timing,
} from "../shared/messages";
import { DEFAULTS, loadSettings, onSettingsChange, type Settings, watchLabel } from "../shared/settings";
import { createProfiles } from "./profiles";
import { parseShortcut } from "./shortcut";
import { committed, type Jump, order, overlayClosed, putFirst, toFront } from "./stack";
import { createThumbnails, type ThumbStore } from "./thumbnails";
import { overlayCanRun } from "./urls";

const profiles = FIREFOX_BUILD ? null : createProfiles(); // null in the Firefox build

const CYCLE_SENT = 5; // tabs a cycle can reach, matching the cards in ui/index.ts
const PRESS_GAP = 300; // ms between presses that count as one held cycle, between browser pages
const CLOSED_SENT = 10;

const ICONS = { 16: "icons/icon-16.png", 32: "icons/icon-32.png" };
const WARNING_ICONS = { 16: "icons/warning-16.png", 32: "icons/warning-32.png" };

// Pages that are a call by their address alone. A call is usually known by
// its page turning on the microphone or camera (content/media.ts), but not in a tab
// opened before tabstack was, or in Firefox.
const CALL_PAGES =
	/^https:\/\/(meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}\b|([\w-]+\.)?zoom\.us\/wc\/|app\.slack\.com\/huddle\/|meet\.jit\.si\/[^/?#]+)/;

// What a cycle sends the page.
type CycleMessage = Extract<PageMessage, { type: "cycle" }>;

// What's kept in storage.session.
interface SessionStore extends ThumbStore {
	stack?: number[];
	inCall?: Record<string, number[]>;
}

let stack: number[] = []; // tab ids, most recent first
const inCall = new Map<number, Set<number>>(); // tab id -> ids of its frames using the microphone or camera
const overlayOpen = new Set<number>(); // tab ids showing the switcher
let switcherPort: chrome.runtime.Port | null = null;
let blind: { tabs: TabItem[]; index: number; from: number; at: number } | null = null; // while quick presses step through browser pages
let pendingSwitcher: Promise<TabItem[]> | null = null; // the tabs the switcher that's opening starts with
let jump: Jump | null = null; // while a cycle continues on the tab we jumped to
let commandQueue = Promise.resolve();
let settings: Settings = DEFAULTS;
let label: Label | null = null; // this profile's { name, mark }, for the toolbar icon
let lastIconUpdate = 0;

const thumbnails = createThumbnails({ recent: () => stack, showing: (tabId) => overlayOpen.has(tabId) });
const ready = load();

async function load() {
	const [saved, tabs, loaded] = await Promise.all([
		api.storage.session.get<SessionStore>(null),
		api.tabs.query({}),
		loadSettings(),
	]);
	settings = loaded;
	const ids = new Set(tabs.map((t) => t.id));

	if (saved.stack) {
		stack = saved.stack.filter((id) => ids.has(id));
	} else {
		// first run this session: seed from the browser's own record
		stack = [...tabs].sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0)).map((t) => t.id!);
	}
	for (const [id, frames] of Object.entries(saved.inCall ?? {})) {
		if (ids.has(Number(id))) inCall.set(Number(id), new Set(frames));
	}
	await thumbnails.load(saved, tabs);
}

onSettingsChange((s) => (settings = s));

function save() {
	api.storage.session.set({ stack });
}

function touch(tabId: number) {
	({ stack, jump } = toFront(stack, tabId, jump));
	save();
}

function forget(tabId: number) {
	stack = stack.filter((id) => id !== tabId);
	overlayOpen.delete(tabId);
	if (inCall.delete(tabId)) saveCalls();
	save();
}

// A frame's microphone or camera turned on or off (content/media.ts, by way of content/relay.ts).
// The page itself can post this signal (content/relay.ts), as often as it likes, so
// it's only written down when it changes something.
function onMedia(tabId: number, frameId: number, live: boolean) {
	const frames = inCall.get(tabId) ?? new Set();
	if (frames.has(frameId) === live) return;
	if (live) frames.add(frameId);
	else frames.delete(frameId);
	if (frames.size) inCall.set(tabId, frames);
	else inCall.delete(tabId);
	saveCalls();
}

function saveCalls() {
	api.storage.session.set({ inCall: Object.fromEntries([...inCall].map(([id, frames]) => [id, [...frames]])) });
}

const isCall = (tab: chrome.tabs.Tab) => inCall.has(tab.id!) || CALL_PAGES.test(tab.url ?? "");

// --- tab tracking ---

api.tabs.onActivated.addListener(async ({ tabId }) => {
	await ready;
	touch(tabId);
	// Chrome has no commands.onChanged, so a shortcut set or cleared at
	// chrome://extensions/shortcuts reaches the toolbar icon on a tab switch.
	if (Date.now() - lastIconUpdate > 10_000) updateToolbarIcon();
});

api.windows.onFocusChanged.addListener(async (windowId) => {
	if (windowId === api.windows.WINDOW_ID_NONE) return;
	await ready;
	const [tab] = await api.tabs.query({ active: true, windowId });
	if (tab) touch(tab.id!);
});

api.tabs.onRemoved.addListener(async (tabId) => {
	await ready;
	forget(tabId);
});

// Chrome swaps in prerendered pages under a new tab id. The new page takes
// the old one's place in the stack; its overlay and any call went with it.
api.tabs.onReplaced?.addListener(async (added, removed) => {
	await ready;
	stack = stack.map((id) => (id === removed ? added : id));
	overlayOpen.delete(removed);
	if (inCall.delete(removed)) saveCalls();
	save();
});

// A new document has no overlay, whether or not the old one said it closed.
// Its content script says so when it starts ("started"); a page with none
// can only be told by its loading. Not every load is a new document:
// history.pushState and hash changes load too, under the same overlay.
api.tabs.onUpdated.addListener((tabId, change, tab) => {
	if (change.status === "loading" && !overlayCanRun(tab.url)) overlayOpen.delete(tabId);
});

api.runtime.onInstalled.addListener(async ({ reason }) => {
	updateToolbarIcon();
	// Before 1.2, saved thumbnails were kept in storage.local, where content
	// scripts can read them. They're taken again as tabs are seen.
	api.storage.local.get(null).then((all) => {
		const old = Object.keys(all).filter((k) => k.startsWith("saved:") || k === "savedIndex");
		if (old.length) api.storage.local.remove(old);
	});
	// Chrome doesn't inject content scripts into tabs that were already open
	// when tabstack is installed or updated; Firefox does. After a browser
	// update the tabs load again, scripts and all.
	if (FIREFOX_BUILD || (reason !== "install" && reason !== "update")) return;
	const tabs = await api.tabs.query({ url: ["http://*/*", "https://*/*"] });
	for (const tab of tabs) {
		const inject = (allFrames: boolean, files: string[]) =>
			api.scripting.executeScript({ target: { tabId: tab.id!, allFrames }, files }).catch(() => {});
		inject(false, ["content.js"]);
		inject(true, ["relay.js"]);
	}
});

// --- snapshot sent to the switcher ---

// A cycle gets the few tabs it can reach, with thumbnails. Search gets every
// tab in every window, without thumbnails, since its rows don't show them.
// Another profile's search leaves out incognito tabs (profiles.ts).
async function snapshot(
	currentId: number | null | undefined,
	{ forSearch = false, incognito = true } = {},
): Promise<TabItem[]> {
	await ready;
	let tabs = await api.tabs.query({});
	if (!incognito) tabs = tabs.filter((t) => !t.incognito);
	const byId = new Map<number | null | undefined, chrome.tabs.Tab>(tabs.map((t) => [t.id, t]));
	const current = byId.get(currentId);
	if (settings.thisWindowOnly && !forSearch && current) {
		tabs = tabs.filter((t) => t.windowId === current.windowId);
	}
	// the tab the switcher opened on always comes first
	const ids = order(
		stack,
		tabs.map((t) => t.id!),
		currentId,
		forSearch ? undefined : CYCLE_SENT,
	);
	return ids.map((id) => {
		const t = byId.get(id)!;
		return {
			id: t.id!,
			windowId: t.windowId,
			title: t.title,
			url: t.url,
			icon: thumbnails.iconFor(t),
			audible: !!t.audible && !t.mutedInfo?.muted,
			call: isCall(t),
			thumb: forSearch ? null : thumbnails.thumbFor(t),
		};
	});
}

async function recentlyClosed(): Promise<ClosedItem[]> {
	if (!api.sessions || !settings.includeClosed) return [];
	const sessions = await api.sessions.getRecentlyClosed({ maxResults: CLOSED_SENT });
	return sessions
		.filter((s): s is chrome.sessions.Session & { tab: chrome.tabs.Tab } => !!s.tab?.url)
		.map(
			({ tab }): ClosedItem => ({
				closed: true,
				sessionId: tab.sessionId,
				title: tab.title,
				url: tab.url,
				icon: thumbnails.iconFor(tab),
			}),
		);
}

// Closes a tab from the switcher, and returns the tabs it can now cycle
// through, so the one below the closed tab can take its place.
async function closeTab(tabId: number, currentId: number | undefined) {
	await api.tabs.remove(tabId).catch(() => {});
	return currentId == null ? [] : snapshot(currentId);
}

async function activate(tabId: number, windowId: number) {
	await Promise.all([api.tabs.update(tabId, { active: true }), api.windows.update(windowId, { focused: true })]);
}

// --- other profiles (profiles.ts) ---

profiles?.init({ snapshot, recentlyClosed });

// Search's rows can come from another profile, which then does what was asked.
function activateItem({ tabId, windowId, profile }: MessageOf<"activate">) {
	return profile ? profiles?.activateIn(profile, tabId, windowId) : activate(tabId, windowId);
}

function restoreItem({ sessionId, profile }: MessageOf<"restore">) {
	return profile ? profiles?.restoreIn(profile, sessionId) : api.sessions.restore(sessionId);
}

async function searchOthers(): Promise<Elsewhere> {
	return (await profiles?.searchOthers()) ?? { tabs: [], closed: [], profiles: [], marks: {} };
}

// --- the switch command ---

api.commands.onCommand.addListener((command, tab) => {
	if (command === "search") {
		searchCommand(tab);
		return;
	}
	if (command !== "switch") return;
	const timing: Timing = { commandAt: Date.now(), swAgeMs: Math.round(performance.now()) };

	// Capture the tab being left while it's still on screen: the freshest
	// picture of it there will be.
	if (tab && !overlayOpen.has(tab.id!)) thumbnails.captureNow(tab);
	commandQueue = commandQueue.then(() => cycle(tab, timing)).catch((e) => console.error("[tabstack]", e));
});

// Search opens in the page's overlay, or in the toolbar popup on pages the
// overlay can't run on. Firefox only opens the popup while the shortcut is
// still being handled, before anything is awaited.
function searchCommand(tab: chrome.tabs.Tab | undefined) {
	if (!tab || switcherPort) return;
	const inPopup = () => openSwitcher(tab, snapshot(tab.id));
	if (!overlayCanRun(tab.url)) inPopup();
	else api.tabs.sendMessage(tab.id!, { type: "search" } satisfies PageMessage, { frameId: 0 }).catch(inPopup);
}

async function cycle(tab: chrome.tabs.Tab | undefined, timing: Timing) {
	tab ??= (await api.tabs.query({ active: true, lastFocusedWindow: true }))[0];
	if (!tab) return;

	if (
		blind &&
		!overlayOpen.has(tab.id!) &&
		Date.now() - blind.at < PRESS_GAP &&
		blind.tabs[blind.index]?.id === tab.id
	) {
		await stepBlind(blind.index + 1);
		return;
	}
	blind = null;

	if (overlayCanRun(tab.url)) {
		const message: CycleMessage = { type: "cycle", timing };
		if (!overlayOpen.has(tab.id!)) {
			const start = performance.now();
			const [tabs, shortcut] = await Promise.all([snapshot(tab.id), switchShortcut()]);
			Object.assign(message, { tabs, modifier: shortcut.modifier, switchCode: shortcut.code });
			timing.snapshotMs = Math.round(performance.now() - start);
		}
		try {
			await api.tabs.sendMessage(tab.id!, message, { frameId: 0 });
			return;
		} catch {
			// no content script yet (page still loading, or opened before install)
		}
	}
	await cycleWithoutOverlay(tab, timing);
}

// This page can't show the overlay. Switch to the previous tab straight away
// and let its overlay carry on the cycle: it sees the modifier come up like
// any page does. When that tab can't show it either, switch anyway, and let
// presses that follow quickly step further back.
//
// Nothing outside a web page hears the modifier come up reliably: a popup or
// window that opens while it's held misses the release (Firefox), or misses
// it after the shortcut is pressed again (Chrome). So between these pages a
// held cycle is told from separate taps by time.
async function cycleWithoutOverlay(tab: chrome.tabs.Tab, timing: Timing) {
	const [tabs, shortcut] = await Promise.all([snapshot(tab.id), switchShortcut()]);
	const target = tabs[1];
	if (!target) return;

	if (!overlayCanRun(target.url)) {
		blind = { tabs, index: 0, from: tab.id!, at: 0 };
		await stepBlind(1);
		return;
	}
	jump = { from: tab.id!, via: target.id };
	timing.jumped = true;
	await activate(target.id, target.windowId);
	const message: CycleMessage = {
		type: "cycle",
		tabs,
		modifier: shortcut.modifier,
		switchCode: shortcut.code,
		jumped: true,
		timing,
	};
	try {
		await api.tabs.sendMessage(target.id, message, { frameId: 0 });
	} catch {
		// the swap happened; there's just no overlay to keep cycling in
		jump = null;
	}
}

// One press of a cycle with no overlay: switch to the next tab along, and keep
// the tab the cycle started on second in the stack, as releasing would. A web
// page takes the cycle over, with its overlay.
async function stepBlind(index: number) {
	const { tabs, from } = blind!;
	blind!.index = index % tabs.length;
	blind!.at = Date.now();
	const target = tabs[blind!.index]!;
	jump = null;
	await activate(target.id, target.windowId);
	if (target.id !== from) {
		stack = putFirst(stack, target.id, from);
		save();
	}
	if (target.id === from || !overlayCanRun(target.url)) return;

	blind = null;
	jump = { from, via: target.id };
	const shortcut = await switchShortcut();
	const message: CycleMessage = {
		type: "cycle",
		tabs,
		selected: tabs.indexOf(target),
		modifier: shortcut.modifier,
		switchCode: shortcut.code,
		jumped: true,
		timing: { commandAt: Date.now(), jumped: true },
	};
	try {
		await api.tabs.sendMessage(target.id, message, { frameId: 0 });
	} catch {
		jump = null;
	}
}

// The toolbar popup opens much faster than a window. It's pointed at the
// switcher only until the switcher connects; clicking the icon shows settings.
function openSwitcher(tab: chrome.tabs.Tab, start: Promise<TabItem[]>) {
	pendingSwitcher = start;
	const action = api.action ?? api.browserAction;
	if (!action.openPopup) {
		openSwitcherWindow(tab);
		return;
	}
	action.setPopup({ popup: "switcher.html?popup" });
	action.openPopup().catch(() => {
		action.setPopup({ popup: "settings.html" });
		openSwitcherWindow(tab);
	});
}

async function openSwitcherWindow(tab: chrome.tabs.Tab) {
	// the window it was opened from may have closed since
	const win: Partial<chrome.windows.Window> = await api.windows.get(tab.windowId).catch(() => ({}));
	// room for the search box and about ten rows
	const width = 560;
	const height = 480;
	await api.windows.create({
		url: "switcher.html",
		type: "popup",
		focused: true,
		width,
		height,
		// centered on the window, or wherever the browser puts it when that's unknown
		...(win.left != null && win.width != null && { left: Math.round(win.left + (win.width - width) / 2) }),
		...(win.top != null && win.height != null && { top: Math.round(win.top + (win.height - height) / 3) }),
	});
}

// --- the switch shortcut ---

// The shortcut as the browser shows it, its key (Shift with it goes back a
// tab), and its modifier, which is the key whose release ends a cycle.
async function switchShortcut() {
	const commands = await api.commands.getAll();
	const shortcut = commands.find((c) => c.name === "switch")?.shortcut ?? "";
	return { shortcut, ...parseShortcut(shortcut, { isMac, isFirefox }) };
}

// --- the toolbar icon ---

// Red until the switch shortcut is set: Chrome silently skips a suggested
// shortcut that's already taken, and a red icon beats doing nothing on
// Cmd+J. Otherwise a profile with a mark (profiles.ts) shows it there, so you
// can tell which profile a window belongs to.
async function updateToolbarIcon() {
	lastIconUpdate = Date.now();
	const { shortcut } = await switchShortcut();
	const action = api.action ?? api.browserAction; // Firefox's build is Manifest V2
	if (!shortcut) {
		action.setIcon({ path: WARNING_ICONS });
		action.setTitle({ title: "tabstack: no shortcut set. Click to choose one." });
		return;
	}
	const mark = label?.mark;
	action.setIcon(mark ? { imageData: { 16: drawMark(mark, 16), 32: drawMark(mark, 32) } } : { path: ICONS });
	action.setTitle({ title: label?.name ? `tabstack: ${label.name}` : "tabstack" });
}

// The mark's icon or letter: on a rounded square of its color when it's
// solid, or in its color, as large as the icon can be, when it's clear.
function drawMark({ icon, glyph, color, style }: Mark, size: number) {
	const ctx = new OffscreenCanvas(size, size).getContext("2d")!;
	const solid = style !== "clear";
	if (solid) {
		const inset = size / 16;
		ctx.fillStyle = color;
		ctx.beginPath();
		ctx.roundRect(inset, inset, size - inset * 2, size - inset * 2, size * 0.25);
		ctx.fill();
	}
	ctx.fillStyle = solid ? inkOn(color) : color;

	const path = icon && !FIREFOX_BUILD ? MARK_ICONS[icon] : undefined;
	if (path) {
		// the icons leave a tenth of their grid blank on each side
		const box = size * (solid ? 0.78 : 1.1);
		ctx.translate((size - box) / 2, (size - box) / 2);
		ctx.scale(box / 256, box / 256);
		ctx.fill(new Path2D(path));
		return ctx.getImageData(0, 0, size, size);
	}
	// an icon picked from an earlier list, since renamed: just the color
	if (!glyph) return ctx.getImageData(0, 0, size, size);

	// scaled by the letter's own outline, so a wide one and a tall one sit
	// centered and fill the space about as much
	const fit = size * (solid ? 0.56 : 0.84);
	const font = (px: number) => `700 ${px}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
	ctx.font = font(size);
	let m = ctx.measureText(glyph);
	const scale =
		fit /
		Math.max(
			m.actualBoundingBoxLeft + m.actualBoundingBoxRight,
			m.actualBoundingBoxAscent + m.actualBoundingBoxDescent,
			1,
		);
	ctx.font = font(size * scale);
	m = ctx.measureText(glyph);
	ctx.fillText(
		glyph,
		(size - m.actualBoundingBoxRight + m.actualBoundingBoxLeft) / 2,
		(size + m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2,
	);
	return ctx.getImageData(0, 0, size, size);
}

watchLabel((l) => {
	label = l;
	updateToolbarIcon();
});
api.commands.onChanged?.addListener(updateToolbarIcon);

// --- messages from content scripts and tabstack's own pages ---
//
// Every message, and who may send it: "page" ones come from the content
// scripts (or tabstack's own pages), "extension" ones only from tabstack's
// own pages (settings, setup, the switcher). A content script shares its
// process with the page, so a page that takes that process over can send
// whatever the content script can. Each is answered with what run returns;
// the switcher page sends over a port, the rest one message at a time.
type Ctx = { tabId?: number; frameId?: number; reply: (answer: PortReply) => void };
type Handler<K extends MessageType> = {
	from: "page" | "extension";
	run: (msg: MessageOf<K>, ctx: Ctx) => Results[K] | Promise<Results[K]>;
};
// Any one of them, once handle has found it by the message's type.
type AnyHandler = { from: "page" | "extension"; run: (msg: Message, ctx: Ctx) => unknown };

const MESSAGES: { [K in MessageType]: Handler<K> } = {
	tabs: {
		from: "page",
		run: (msg, { tabId }) => (msg.search ? searchTabs(tabId) : snapshot(tabId)),
	},
	tabsElsewhere: { from: "page", run: () => searchOthers() },
	// these three are commits (COMMITS): the switcher page closes when they're done
	activate: {
		from: "page",
		run: async (msg, { tabId }) => {
			if (tabId != null) jump = committed(jump, tabId, msg.tabId);
			await activateItem(msg);
			return { type: "done" };
		},
	},
	restore: {
		from: "page",
		run: async (msg) => {
			await restoreItem(msg);
			return { type: "done" };
		},
	},
	switchProfile: {
		from: "page",
		run: async (msg) => {
			await profiles?.switchTo(msg.profile);
			return { type: "done" };
		},
	},
	// the overlay fills the gap with the tabs that are now on top
	closeTab: {
		from: "page",
		run: async (msg, { tabId }) => {
			if (msg.profile) return profiles?.closeIn(msg.profile, msg.tabId);
			return { tabs: await closeTab(msg.tabId, tabId) };
		},
	},
	toastAction: { from: "page", run: (msg) => profiles?.onToastAction(msg.id) },
	media: {
		from: "page",
		run: async (msg, { tabId, frameId }) => {
			await ready;
			if (tabId != null) onMedia(tabId, frameId ?? 0, !!msg.live);
		},
	},
	// a new document's content script: no overlay is open there yet
	started: {
		from: "page",
		run: (_msg, { tabId }) => {
			if (tabId != null) overlayOpen.delete(tabId);
		},
	},
	open: {
		from: "page",
		run: (_msg, { tabId }) => {
			if (tabId != null) overlayOpen.add(tabId);
		},
	},
	close: {
		from: "page",
		run: (_msg, { tabId }) => {
			if (tabId == null) return;
			overlayOpen.delete(tabId);
			jump = overlayClosed(jump, tabId);
		},
	},
	// from an iframe to the top frame, which owns the overlay: only what
	// content/relay.ts sends, rebuilt, so nothing else rides along
	relay: {
		from: "page",
		run: ({ message: m }, { tabId }) => {
			let message: PageMessage | null = null;
			if (m?.type === "search") message = { type: "search" };
			else if (m?.type === "modUp" && RELAYED_KEYS.includes(m.key)) message = { type: "modUp", key: m.key };
			if (message && tabId != null) api.tabs.sendMessage(tabId, message, { frameId: 0 }).catch(() => {});
		},
	},
	// the switcher page's search: this profile's tabs, then other profiles',
	// so a slow one doesn't hold up these
	search: {
		from: "extension",
		run: async (msg, { reply }) => {
			reply({ type: "tabs", ...(await searchTabs(msg.currentId)) });
			const elsewhere = await searchOthers();
			if (elsewhere.tabs.length || elsewhere.closed.length || elsewhere.profiles.length)
				return { type: "moreTabs", ...elsewhere };
		},
	},
	profiles: { from: "extension", run: () => profiles?.status() },
	profilesShared: { from: "extension", run: (msg) => profiles?.setShared(msg.values) },
	profilesConnect: { from: "extension", run: () => profiles?.reconnect() },
	// from settings, which may follow a change to the shortcut
	checkShortcut: { from: "extension", run: () => updateToolbarIcon() },
};

const RELAYED_KEYS = ["Meta", "Control", "Alt", "Shift"]; // content/relay.ts's MODIFIERS
const COMMITS: unknown[] = ["activate", "restore", "switchProfile"] satisfies MessageType[];

// Tabstack's own pages, by where they're from: those open in a tab (setup,
// the switcher's window) have sender.tab as a content script does. Firefox
// gives no sender.origin, but does give the page's URL.
const OWN_URL = api.runtime.getURL("");
const fromExtension = (sender: chrome.runtime.MessageSender) =>
	sender.origin ? `${sender.origin}/` === OWN_URL : !!sender.url?.startsWith(OWN_URL);

// Runs a message, if its sender may send it, and settles with its answer.
// reply passes on an answer that comes ahead of the last.
async function handle(input: unknown, sender: chrome.runtime.MessageSender, reply: Ctx["reply"]): Promise<unknown> {
	// whatever was sent: only a Message once MESSAGES has its type
	const msg = input as Message;
	const handler: AnyHandler | null = Object.hasOwn(MESSAGES, msg?.type) ? (MESSAGES[msg.type] as AnyHandler) : null;
	if (!handler || (handler.from === "extension" && !fromExtension(sender))) return { ok: false } satisfies Failed;
	try {
		return await handler.run(msg, { tabId: sender.tab?.id, frameId: sender.frameId, reply });
	} catch (e) {
		console.warn("[tabstack]", msg.type, e);
		return { ok: false } satisfies Failed;
	}
}

async function searchTabs(currentId: number | null | undefined): Promise<SearchTabs> {
	const [tabs, closed] = await Promise.all([snapshot(currentId, { forSearch: true }), recentlyClosed()]);
	return { tabs, closed };
}

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
	handle(msg, sender, sendResponse).then((answer) => sendResponse(answer ?? { ok: true }));
	return true;
});

// --- the switcher popup or window ---

api.runtime.onConnect.addListener((port) => {
	if (port.name !== "switcher" || !fromExtension(port.sender!)) return;
	switcherPort = port;
	(api.action ?? api.browserAction).setPopup({ popup: "settings.html" });
	const start = pendingSwitcher;
	pendingSwitcher = null;
	Promise.resolve(start)
		.then((tabs) => port.postMessage({ type: "start", ...(tabs && { tabs }) } satisfies StartMessage))
		.catch(() => {}); // closed before it started

	port.onDisconnect.addListener(() => {
		if (switcherPort === port) switcherPort = null;
	});
	const post = (message: PortReply) => {
		try {
			port.postMessage(message);
		} catch {
			// the window already closed itself
		}
	};
	// The switcher page isn't a tab being switched from, so no tabId: the
	// tabs it can still reach after a close aren't asked for.
	port.onMessage.addListener(async (msg) => {
		// an answer with a type is one of the replies the switcher page knows
		const answer = (await handle(msg, { ...port.sender, tab: undefined }, post)) as Partial<PortReply> | undefined;
		if (answer?.type) post(answer as PortReply);
		// a commit that failed is over too, and the page closes either way
		else if (COMMITS.includes(msg?.type)) post({ type: "done" });
	});
});
