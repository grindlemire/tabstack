// Page side of tabstack, top frame only. Draws the switcher over the page, and
// watches the modifier key, because the commands API reports the shortcut
// being pressed but never the modifier being released. Iframes get the much
// smaller relay.ts, which forwards their key events here.

import { api, isFirefox, isMac } from "../shared/api";
import { markElement } from "../shared/marks";
import type { Label, Message, Modifier, PageMessage, Timing } from "../shared/messages";
import { sendMessage } from "../shared/messages";
import { DEFAULTS, loadSettings, onSettingsChange, type Settings, watchLabel } from "../shared/settings";
import { matches } from "../shared/shortcuts";
import { adoptStyle, answered, Switcher } from "../ui";

declare global {
	// The live copy's teardown, which the next copy calls (below).
	var tabstackTakeover: (() => void) | undefined;
}

type CycleMessage = Extract<PageMessage, { type: "cycle" }>;
type ToastMessage = Extract<PageMessage, { type: "toast" }>;
type Events = WindowEventMap & DocumentEventMap;

const MODIFIERS: Record<Modifier, "metaKey" | "ctrlKey" | "altKey" | "shiftKey"> = {
	Meta: "metaKey",
	Control: "ctrlKey",
	Alt: "altKey",
	Shift: "shiftKey",
};
const SHOW_DELAY = 120; // a quick tap switches without flashing the UI
const COLD_WORKER = 1000; // ms: a service worker younger than this was just started for the shortcut
const PRESS_RECENT = 3000; // ms: a modifier press older than this wasn't for this switch

// A newer copy of this script (extension reload, or injection into a tab
// that was already open) tells older copies to stand down. Copies share
// this isolated world's global, which the page can't reach, as it could a
// DOM event; a copy orphaned into another world stops itself (alive()).
globalThis.tabstackTakeover?.();
globalThis.tabstackTakeover = teardown;
const controller = new AbortController();
// Only the browser's own input counts: the page can dispatch keys and
// pointer events too, and use them to switch or close any tab.
const listen = <K extends keyof Events>(target: EventTarget, type: K, fn: (e: Events[K]) => void, capture = true) =>
	target.addEventListener(type, (e) => e.isTrusted && fn(e as Events[K]), { capture, signal: controller.signal });
let dead = false;
let switcher: Switcher | null = null;
let hostEl: HTMLElement | null = null;

function teardown() {
	dead = true;
	controller.abort();
	switcher?.close();
	hostEl?.remove();
	hideToast();
	try {
		api.runtime.onMessage.removeListener(onMessage);
	} catch {}
}

function alive() {
	if (!dead && !api.runtime?.id) teardown(); // orphaned by an extension reload
	return !dead;
}

function send<M extends Message>(message: M) {
	try {
		return sendMessage(message).catch((): undefined => {});
	} catch {
		teardown();
	}
}

let settings: Settings = DEFAULTS;
loadSettings().then((s) => (settings = s));
onSettingsChange((s) => (settings = s));
let label: Label | null = null; // this profile's name, over search
watchLabel((l) => {
	label = l;
	switcher?.setProfile(l);
});

// --- modifier tracking ---

// The modifier of the switch shortcut; the background sends the real one
// with each cycle, since it can be rebound.
let modifier: Modifier = isMac ? "Meta" : "Control";
const down = new Set<string>();
const held = () => down.has(modifier);
const modDownAt: Record<string, number> = {};
const modUpAt: Record<string, number> = {};

// After a jump from a page tabstack can't run on, Firefox doesn't tell this
// page the modifier came up, since it went down over there. The switcher
// waits, hidden, for the page's first input, which carries the modifier's
// state: the modifier pressed again, or any input without it, means it was
// let go.
let unheard = false;

function hear(e: KeyboardEvent | PointerEvent) {
	if (!unheard) return;
	unheard = false;
	if (!switcher?.isOpen || switcher.mode !== "cycle") return;
	const pressedAgain = e.type === "keydown" && (e as KeyboardEvent).key === modifier;
	if (pressedAgain || !e[MODIFIERS[modifier]]) switcher.commit();
	else show();
}

function syncModifiers(e: KeyboardEvent) {
	for (const [name, prop] of Object.entries(MODIFIERS)) {
		if (e[prop]) down.add(name);
		else down.delete(name);
	}
}

listen(window, "keydown", (e) => {
	if (!alive()) return;
	// the page closed or removed the dialog the overlay went into
	// (overlayParent): an open switcher no one can see mustn't take keys
	if (switcher?.isOpen && !hostEl!.checkVisibility()) switcher.close();
	hear(e);
	syncModifiers(e);
	if (e.key in MODIFIERS) modDownAt[e.key] = Date.now();

	// off once it's cleared in Settings: no search key on pages
	const { searchShortcut: search, searchOnPage: on } = settings;
	const searchKey =
		matches(e, search, on) ||
		// while cycling, the search key works with the switch modifier still held
		(on && switcher?.isOpen && switcher.mode === "cycle" && e.code === search.code);
	if (searchKey) {
		e.preventDefault();
		e.stopImmediatePropagation();
		openSearch();
		return;
	}

	if (switcher?.isOpen) {
		if (switcher.handleKey(e)) e.preventDefault();
		// keep page shortcuts from firing; typing still reaches the input
		e.stopImmediatePropagation();
	}
});

listen(window, "keyup", (e) => {
	if (!alive()) return;
	hear(e);
	syncModifiers(e);
	if (e.key in MODIFIERS) released(e.key);
	if (switcher?.isOpen) e.stopImmediatePropagation();
});

// The page sees typing in the switcher as keys pressed on its own element,
// since the search box is in a closed shadow root, so a site with
// single-key shortcuts (Gmail's c, to compose) takes them, and cancels the
// letter. Like keydown and keyup, they stop here while the switcher's open.
// (Not input: the search box listens for that itself, so it stops at the
// shadow root, in ensureSwitcher.)
for (const type of ["keypress", "beforeinput"] as const) {
	listen(window, type, (e) => {
		if (switcher?.isOpen) e.stopImmediatePropagation();
	});
}

// --- overlay ---

let showTimer: ReturnType<typeof setTimeout> | 0 = 0;
// pageAt is set wherever timing is
let timing: (Timing & { pageAt: number }) | null = null;
let prevFocus: HTMLElement | null = null;

function ensureSwitcher() {
	if (!switcher) {
		hostEl = document.createElement("tabstack-overlay");
		hostEl.tabIndex = -1;
		hostEl.style.outline = "none";
		const root = hostEl.attachShadow({ mode: "closed" });
		// What's typed in search mustn't reach the page. Input and
		// composition events cross the shadow root, carrying the text, so
		// they stop at it, once the search box's own listener has run. A
		// page listening in the capture phase hears them first; nothing
		// here can stop that.
		for (const type of ["input", "compositionstart", "compositionupdate", "compositionend"]) {
			root.addEventListener(type, (e) => e.stopPropagation());
		}
		switcher = new Switcher(root, { popover: true, onCommit: send, onCloseTab: send, onClose: hide });
		switcher.setProfile(label);
	}
	switcher.autoSwitch = settings.autoSwitch;
	// moving a popover that's showing would hide it
	// (hostEl is made with the switcher)
	if (!switcher.isOpen) placeIn(overlayParent(), hostEl!);
	return switcher;
}

// A modal <dialog> makes everything outside it inert, which would leave the
// search box unable to take focus, so the overlay goes inside the dialog
// while one's open, and back to the body once none is.
function overlayParent(): Element {
	return document.querySelector("dialog:modal") ?? document.body ?? document.documentElement;
}

function placeIn(parent: Element, node: HTMLElement) {
	if (node.parentNode !== parent) parent.append(node);
}

// Keys typed while focus sits inside an iframe never reach this frame, so
// pull focus up here while the switcher is open.
function takeFocusFromIframe() {
	if (document.activeElement?.tagName !== "IFRAME") return;
	prevFocus = document.activeElement as HTMLElement;
	hostEl!.focus({ preventScroll: true });
}

function show() {
	clearTimeout(showTimer);
	if (!switcher!.isOpen) return;
	// The page closed or removed the dialog the overlay went into since it
	// was placed; a popover there is hidden, or would throw on showing, so
	// it goes where it can be seen (moving it hides it, if it's showing).
	if (!hostEl!.checkVisibility()) placeIn(overlayParent(), hostEl!);
	if (switcher!.panel.matches(":popover-open")) return;
	const shownAt = Date.now();
	try {
		switcher!.panel.showPopover();
	} catch {
		switcher!.close();
		return;
	}
	requestAnimationFrame(() => report({ paintMs: Date.now() - shownAt }));
}

function hide() {
	clearTimeout(showTimer);
	unheard = false;
	try {
		switcher!.panel.hidePopover();
	} catch {}
	send({ type: "close" });
	if (prevFocus?.isConnected) prevFocus.focus({ preventScroll: true });
	prevFocus = null;
}

// Presses since a cycle started waiting for its tabs. Those that come while
// it waits are counted, not sent for tabs of their own, and move it on once
// it opens, as they would have had it been open.
let presses = 0;

async function onCycle(msg: CycleMessage) {
	const s = ensureSwitcher();
	if (s.isOpen) {
		// pressed again while held: go further back, and show the UI now
		s.move(1);
		show();
		return;
	}
	if (presses) {
		presses++;
		return;
	}

	if (msg.modifier) modifier = msg.modifier;
	s.switchCode = msg.switchCode ?? s.switchCode;
	timing = { ...msg.timing, pageAt: Date.now() };
	presses = 1;
	const tabs = msg.tabs ?? answered(await send({ type: "tabs" })) ?? [];
	const again = presses - 1;
	presses = 0;
	// hidden, or orphaned by an extension reload, while it waited, or
	// search opened meanwhile
	if (!alive() || document.hidden || s.isOpen) return;
	s.open("cycle", tabs);
	if (msg.selected != null) s.select(msg.selected);
	if (again) s.move(again);
	send({ type: "open" });

	// This frame never saw the modifier go down when we were switched to
	// mid-shortcut from a page tabstack can't run on, or when focus is in
	// an iframe, whose keys go to its own document (relay.ts passes on
	// only the release). Count it as held unless it has already come up.
	// (either side missing compares false: still held)
	const inIframe = document.activeElement?.tagName === "IFRAME";
	const unseen = msg.jumped || inIframe;
	const stillHeld = unseen ? !((modUpAt[modifier] as number) >= (msg.timing.commandAt as number)) : held();
	if (!stillHeld) {
		// the modifier came up before this message arrived (or the page
		// never saw it go down): it was a quick tap, so just switch
		report({ releasedBeforeMessage: true });
		s.commit();
		return;
	}
	if (msg.jumped) down.add(modifier);
	takeFocusFromIframe();
	if (msg.jumped && isFirefox) {
		// stay hidden: it was most likely a tap
		unheard = true;
		return;
	}
	// An iframe relay.ts can't reach (data: and blob: ones, or one that
	// loaded before it) never passes the release on, and it may have come
	// before focus moved up here; the page's next input carries the
	// modifier's state.
	if (inIframe) unheard = true;
	if (again) show();
	else showTimer = setTimeout(show, SHOW_DELAY);
}

// The modifier came up, here or (relayed) in an iframe.
function released(key: string) {
	modUpAt[key] = Date.now();
	if (key === modifier && switcher?.isOpen && switcher.mode === "cycle") switcher.commit();
}

async function openSearch() {
	const s = ensureSwitcher();
	if (s.isOpen && s.mode === "search") {
		// already searching: keep what's listed, and put the cursor back
		show();
		s.search();
		return;
	}
	const fromCycle = s.isOpen;
	if (!fromCycle) {
		timing = { pageAt: Date.now() };
		s.open("search", []);
		send({ type: "open" });
	}
	// where Escape puts focus back; from a cycle, takeFocusFromIframe may
	// have set it already
	if (!prevFocus && document.activeElement !== hostEl) prevFocus = document.activeElement as HTMLElement | null;
	show(); // first: the input can't take focus while the panel is hidden
	s.search();
	// search covers every window and recently closed tabs, which a cycle's
	// list may not have, and then other profiles' tabs, when the profile
	// helper is set up
	const t = timing;
	await s.load({
		tabs: async () => {
			const lists = answered(await send({ type: "tabs", search: true }));
			if (!fromCycle && timing === t) report({ searchTabsMs: Date.now() - t!.pageAt });
			return lists;
		},
		elsewhere: async () => answered(await send({ type: "tabsElsewhere" })),
	});
}

// --- notices from background/profiles.ts: a link moved here, or a page open elsewhere ---

const TOAST_FOR = 8000;
const TOAST_STYLE = `
:host { all: initial; }
.toast {
	--bg: rgba(250, 250, 252, 0.92);
	--fg: #1d1d1f;
	--line: rgba(0, 0, 0, 0.1);
	--accent: #3b6cf6;
	position: fixed;
	inset: auto 16px 16px auto;
	margin: 0;
	display: flex;
	align-items: center;
	gap: 10px;
	max-width: min(420px, calc(100vw - 32px));
	padding: 8px 8px 8px 14px;
	font: 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
	color: var(--fg);
	background: var(--bg);
	-webkit-backdrop-filter: blur(24px) saturate(1.6);
	backdrop-filter: blur(24px) saturate(1.6);
	border: 1px solid var(--line);
	border-radius: 12px;
	box-shadow: 0 12px 32px rgba(0, 0, 0, 0.25);
	transition: opacity 140ms ease-out, transform 160ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
@starting-style {
	.toast:popover-open { opacity: 0; transform: translateY(6px); }
}
@media (prefers-color-scheme: dark) {
	.toast { --bg: rgba(30, 30, 32, 0.92); --fg: #f5f5f7; --line: rgba(255, 255, 255, 0.12); --accent: #5b85ff; }
}
.text { flex: 1; min-width: 0; }
/* the other profile's mark */
.mark { flex: none; display: grid; place-items: center; width: 22px; height: 22px; margin-left: -4px; font-size: 12px; font-weight: 700; line-height: 1; border-radius: 6px; }
.mark svg { width: 14px; height: 14px; }
.mark.solid { color: var(--ink); background: var(--mark); }
.mark.clear { color: var(--mark); }
.mark.clear svg { width: 22px; height: 22px; }
button {
	flex: none;
	padding: 5px 10px;
	font: inherit;
	font-weight: 500;
	color: #fff;
	background: var(--accent);
	border: 0;
	border-radius: 8px;
	cursor: pointer;
}
button.dismiss { padding: 5px 8px; color: inherit; background: none; opacity: 0.6; }
button.dismiss:hover { opacity: 1; }
@media (prefers-reduced-motion: reduce) {
	.toast { transition: none; }
}
`;
let toastEl: HTMLElement | null = null;
let toastTimer: ReturnType<typeof setTimeout> | 0 = 0;

function hideToast() {
	clearTimeout(toastTimer);
	toastEl?.remove();
	toastEl = null;
}

// mark is the other profile's, when it has one
function showToast({ id, text, action, mark }: ToastMessage) {
	hideToast();
	toastEl = document.createElement("tabstack-toast");
	const root = toastEl.attachShadow({ mode: "closed" });
	adoptStyle(root, TOAST_STYLE);
	const box = document.createElement("div");
	box.className = "toast";
	box.popover = "manual";
	const label = Object.assign(document.createElement("span"), { className: "text", textContent: text });
	const go = Object.assign(document.createElement("button"), { textContent: action });
	go.addEventListener("click", () => {
		send({ type: "toastAction", id });
		hideToast();
	});
	const dismiss = Object.assign(document.createElement("button"), { className: "dismiss", textContent: "✕" });
	dismiss.setAttribute("aria-label", "Dismiss");
	dismiss.addEventListener("click", hideToast);
	if (mark) box.append(markElement(mark, mark.path));
	box.append(label, go, dismiss);
	root.append(box);
	placeIn(overlayParent(), toastEl);
	try {
		box.showPopover();
	} catch {
		hideToast();
		return;
	}
	// it stays while the pointer's on it
	const wait = () => {
		toastTimer = setTimeout(hideToast, TOAST_FOR);
	};
	box.addEventListener("pointerenter", () => clearTimeout(toastTimer));
	box.addEventListener("pointerleave", wait);
	wait();
}

function onMessage(
	msg: PageMessage,
	_sender: chrome.runtime.MessageSender,
	sendResponse: (response?: unknown) => void,
) {
	if (!alive()) return;
	if (msg.type === "cycle") onCycle(msg);
	else if (msg.type === "modUp") released(msg.key);
	else if (msg.type === "search") openSearch();
	else if (msg.type === "toast") showToast(msg);
	sendResponse({ ok: true });
}
api.runtime.onMessage.addListener(onMessage);

// A new document has no switcher open, whatever the background last heard
// from this tab. A prerendered one isn't this tab's page until it's shown.
// (TypeScript's DOM types don't have prerendering yet.)
if ((document as Document & { prerendering?: boolean }).prerendering)
	document.addEventListener("prerenderingchange", () => send({ type: "started" }), { once: true });
else send({ type: "started" });

// Recover from a missed keyup: pointer events carry the modifier state.
listen(window, "pointermove", (e) => {
	hear(e);
	if (switcher?.isOpen && switcher.mode === "cycle" && !e[MODIFIERS[modifier]]) switcher.commit();
});
listen(window, "pointerdown", (e) => {
	// hostEl is made with the switcher
	if (switcher?.isOpen && !e.composedPath().includes(hostEl!)) switcher.close();
});
listen(window, "blur", () => {
	// focus moving into an iframe also blurs the window, so check after
	setTimeout(() => {
		if (switcher?.isOpen && !document.hasFocus()) switcher.close();
	});
});
listen(document, "visibilitychange", () => {
	if (document.hidden) switcher?.close();
});

// --- timings (Settings → Show timings) ---

function report(extra: Timing) {
	if (!timing) return;
	Object.assign(timing, extra);
	if (!settings.showTimings) return;
	const t = timing;
	const parts = [];
	if (t.swAgeMs != null) parts.push(`worker ${t.swAgeMs < COLD_WORKER ? "COLD" : "warm"} (age ${t.swAgeMs}ms)`);
	if (t.snapshotMs != null) parts.push(`snapshot ${t.snapshotMs}ms`);
	if (t.commandAt) parts.push(`worker→page ${t.pageAt - t.commandAt}ms`);
	const pressedAt = modDownAt[modifier];
	if (pressedAt && t.pageAt - pressedAt < PRESS_RECENT) parts.push(`modifier down→page ${t.pageAt - pressedAt}ms`);
	if (t.paintMs != null) parts.push(`paint ${t.paintMs}ms`);
	if (t.searchTabsMs != null) parts.push(`tabs loaded ${t.searchTabsMs}ms`);
	if (t.jumped) parts.push("jumped from restricted page");
	if (t.releasedBeforeMessage) parts.push("released before message");
	switcher?.setDebug(parts.join(" · "));
	console.log("[tabstack]", { ...t });
}
