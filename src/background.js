// Keeps the most-recently-used tab stack, captures thumbnails and favicons, and
// routes the switch shortcut to the page overlay (content.js). On pages
// extensions can't touch, it jumps to the previous tab and continues there, or
// opens the switcher in the toolbar popup (or its own window, if that fails).

// Chrome runs this as a service worker; Firefox lists shared.js before it.
if (typeof importScripts === "function") importScripts("shared.js");

const { api, isMac, loadSettings, onSettingsChange } = TabstackShared;
const isFirefox = /Firefox\//.test(navigator.userAgent);

const THUMB_WIDTH = 400;
const THUMB_LIMIT = 50; // keep thumbnails for this many recent tabs
const CYCLE_SENT = 5; // tabs a cycle can reach, matching the cards in ui.js
const SAVED_LIMIT = 100; // thumbnails kept across restarts, by page URL
const CAPTURE_DELAY = 400; // let the page paint after activation
const CAPTURE_GAP = 600; // Chrome allows ~2 captures per second
const REFRESH_ALARM = "refresh-thumbnail";
const CLOSED_SENT = 10;

const ICONS = { 16: "icons/icon-16.png", 32: "icons/icon-32.png" };
const WARNING_ICONS = { 16: "icons/warning-16.png", 32: "icons/warning-32.png" };

// Pages where content scripts don't run, so the overlay can't be drawn.
const RESTRICTED =
	/^(chrome|chrome-extension|chrome-search|chrome-untrusted|devtools|edge|about|moz-extension|view-source|data|file):|^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore|addons\.mozilla\.org)\//;

let stack = []; // tab ids, most recent first
const thumbs = new Map(); // tab id -> data URL
const savedThumbs = new Map(); // page URL -> data URL, from earlier sessions
let savedIndex = []; // page URLs with a saved thumbnail, most recent first
const icons = new Map(); // icon key -> data URL, or "" when there's none
const iconsLoading = new Set();
const overlayOpen = new Set(); // tab ids showing the switcher
const captureTimers = new Map(); // window id -> timeout
let lastCaptureAt = 0;
const tabInfo = new Map(); // tab id -> { url, windowId }, so the shortcut can decide without waiting
let started = false; // load() has finished
let switcherPort = null;
let pendingSwitcher = null; // what the switcher that's opening shows: a value or a promise
let switcherStarted = Promise.resolve(); // the open switcher has been sent its tabs
let jump = null; // { from, via, to } while a cycle continues on the tab we jumped to
let commandQueue = Promise.resolve();
let settings = TabstackShared.DEFAULTS;

const ready = load();

async function load() {
	const [saved, tabs, loaded] = await Promise.all([
		api.storage.session.get(null),
		api.tabs.query({}),
		loadSettings(),
	]);
	settings = loaded;
	const ids = new Set(tabs.map((t) => t.id));
	for (const tab of tabs) noteTab(tab);

	if (saved.stack) {
		stack = saved.stack.filter((id) => ids.has(id));
	} else {
		// first run this session: seed from the browser's own record
		stack = [...tabs].sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0)).map((t) => t.id);
	}

	for (const [key, value] of Object.entries(saved)) {
		const id = Number(key.slice(6));
		if (key.startsWith("thumb:") && ids.has(id)) thumbs.set(id, value);
	}
	for (const [key, value] of Object.entries(saved.icons ?? {})) icons.set(key, value);

	// Chrome can only capture the tab on screen, so tabs restored at startup
	// show the picture from their last visit until they're seen again.
	({ savedIndex = [] } = await api.storage.local.get("savedIndex"));
	await loadSaved(tabs.filter((t) => !thumbs.has(t.id)).map((t) => t.url));
	if (api.tabs.captureTab) captureInBackground(tabs);
	for (const tab of tabs) iconFor(tab); // fetch any that are missing
	started = true;
}

onSettingsChange((s) => (settings = s));

function save() {
	api.storage.session.set({ stack });
}

function touch(tabId) {
	stack = [tabId, ...stack.filter((id) => id !== tabId)];
	if (jump?.to === tabId) {
		// cycled on past the tab we jumped through, so the page the cycle
		// started on is "previous", not the one we passed
		stack = [tabId, jump.from, ...stack.filter((id) => id !== tabId && id !== jump.from)];
		jump = null;
	}
	save();
}

function noteTab(tab) {
	tabInfo.set(tab.id, { url: tab.url ?? "", windowId: tab.windowId });
}

function forget(tabId) {
	stack = stack.filter((id) => id !== tabId);
	tabInfo.delete(tabId);
	thumbs.delete(tabId);
	overlayOpen.delete(tabId);
	api.storage.session.remove(`thumb:${tabId}`);
	save();
}

// --- tab tracking ---

api.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
	await ready;
	touch(tabId);
	scheduleCapture(windowId, tabId);
	if (Date.now() - lastShortcutCheck > 10_000) checkShortcut();
});

api.windows.onFocusChanged.addListener(async (windowId) => {
	if (windowId === api.windows.WINDOW_ID_NONE) return;
	await ready;
	const [tab] = await api.tabs.query({ active: true, windowId });
	if (tab) touch(tab.id);
});

api.tabs.onRemoved.addListener(async (tabId) => {
	await ready;
	forget(tabId);
});

// Chrome swaps in prerendered pages under a new tab id.
api.tabs.onReplaced?.addListener(async (added, removed) => {
	await ready;
	stack = stack.map((id) => (id === removed ? added : id));
	thumbs.delete(removed);
	save();
});

api.tabs.onCreated.addListener(noteTab);
api.tabs.onAttached.addListener((tabId, { newWindowId }) => {
	const info = tabInfo.get(tabId);
	if (info) info.windowId = newWindowId;
});

api.tabs.onUpdated.addListener(async (tabId, change, tab) => {
	if (change.url) noteTab(tab);
	if (!change.status && !change.favIconUrl && !change.url) return;
	// a new favicon URL gets a new key, so iconFor() fetches it
	await ready;
	if (change.url) loadSaved([change.url]);
	if (change.status === "complete" && tab.active) scheduleCapture(tab.windowId, tabId);
	iconFor(tab);
});

api.runtime.onInstalled.addListener(async () => {
	checkShortcut();
	// Chrome doesn't inject content scripts into tabs that were already open.
	const tabs = await api.tabs.query({ url: ["http://*/*", "https://*/*"] });
	for (const tab of tabs) {
		const inject = (allFrames, files) =>
			api.scripting.executeScript({ target: { tabId: tab.id, allFrames }, files }).catch(() => {});
		inject(false, ["shared.js", "ui.js", "content.js"]);
		inject(true, ["relay.js"]);
	}
});

// --- thumbnails ---

function scheduleCapture(windowId, tabId, delay = CAPTURE_DELAY) {
	clearTimeout(captureTimers.get(windowId));
	captureTimers.set(
		windowId,
		setTimeout(() => capture(windowId, tabId), delay),
	);
}

async function capture(windowId, tabId) {
	captureTimers.delete(windowId);

	const wait = lastCaptureAt + CAPTURE_GAP - Date.now();
	if (wait > 0) return scheduleCapture(windowId, tabId, wait);

	let tab;
	try {
		tab = await api.tabs.get(tabId);
	} catch {
		return;
	}
	// a loading tab gets captured again by onUpdated when it completes
	if (!tab.active || tab.windowId !== windowId || tab.status !== "complete") return;
	captureNow(tab);
}

// Starts the capture before awaiting anything, so a switch that follows right
// behind (a quick tap of the shortcut) can't land in the picture.
async function captureNow(tab) {
	if (overlayOpen.has(tab.id) || RESTRICTED.test(tab.url ?? "")) return;
	lastCaptureAt = Date.now();
	try {
		const shot = await api.tabs.captureVisibleTab(tab.windowId, captureOptions(tab));
		await keepThumb(tab, await shrink(shot));
	} catch (e) {
		// minimized window, or the tab moved on; hitting the rate limit is routine
		if (!/MAX_CAPTURE/.test(e.message)) console.warn("[tabstack] capture failed:", tab.url, e.message ?? e);
	}
}

// Firefox can capture at a given scale, which saves encoding a full Retina
// screenshot only to shrink it; Chrome always captures at full size.
function captureOptions(tab) {
	const options = { format: "jpeg", quality: 70 };
	if (isFirefox && tab.width) options.scale = Math.min(1, THUMB_WIDTH / tab.width);
	return options;
}

async function shrink(dataUrl) {
	const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
	const height = Math.round((bitmap.height * THUMB_WIDTH) / bitmap.width);
	const canvas = new OffscreenCanvas(THUMB_WIDTH, height);
	canvas.getContext("2d").drawImage(bitmap, 0, 0, THUMB_WIDTH, height);
	bitmap.close();
	return blobToDataUrl(await canvas.convertToBlob({ type: "image/webp", quality: 0.75 }));
}

async function blobToDataUrl(blob) {
	const bytes = new Uint8Array(await blob.arrayBuffer());
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return `data:${blob.type};base64,${btoa(binary)}`;
}

async function keepThumb(tab, thumb) {
	await ready;
	thumbs.set(tab.id, thumb);
	api.storage.session.set({ [`thumb:${tab.id}`]: thumb });
	trimThumbs();
	if (!tab.incognito) saveByUrl(tab.url, thumb);
}

// Firefox can capture tabs that aren't on screen, as long as they're loaded,
// so at startup it fills in what the saved thumbnails don't cover.
async function captureInBackground(tabs) {
	const missing = tabs.filter((t) => !t.active && !t.discarded && t.status === "complete" && !RESTRICTED.test(t.url));
	for (const tab of missing.filter((t) => !thumbs.has(t.id)).slice(0, THUMB_LIMIT)) {
		try {
			await keepThumb(tab, await shrink(await api.tabs.captureTab(tab.id, captureOptions(tab))));
		} catch {}
	}
}

async function loadSaved(urls) {
	const keys = urls.filter((u) => u && !savedThumbs.has(u) && savedIndex.includes(u)).map((u) => `saved:${u}`);
	if (!keys.length) return;
	for (const [key, value] of Object.entries(await api.storage.local.get(keys))) savedThumbs.set(key.slice(6), value);
}

function saveByUrl(url, thumb) {
	savedThumbs.set(url, thumb);
	savedIndex = [url, ...savedIndex.filter((u) => u !== url)];
	const dropped = savedIndex.splice(SAVED_LIMIT);
	api.storage.local.set({ [`saved:${url}`]: thumb, savedIndex });
	if (dropped.length) api.storage.local.remove(dropped.map((u) => `saved:${u}`));
	for (const u of dropped) savedThumbs.delete(u);
}

function trimThumbs() {
	const keep = new Set(stack.slice(0, THUMB_LIMIT));
	for (const id of thumbs.keys()) {
		if (!keep.has(id)) {
			thumbs.delete(id);
			api.storage.session.remove(`thumb:${id}`);
		}
	}
}

// Refresh the thumbnail of the tab you're looking at, so pages that change
// (chat, mail, dashboards) don't show how they looked when you arrived. The
// timer only runs while you're at the computer, so an idle browser isn't
// woken every 30 seconds.
api.idle.setDetectionInterval(60);
api.idle.onStateChanged.addListener((state) => {
	if (state === "active") api.alarms.create(REFRESH_ALARM, { periodInMinutes: 0.5 });
	else api.alarms.clear(REFRESH_ALARM);
});
api.alarms.get(REFRESH_ALARM).then((alarm) => {
	if (!alarm) api.alarms.create(REFRESH_ALARM, { periodInMinutes: 0.5 });
});

api.alarms.onAlarm.addListener(async ({ name }) => {
	if (name !== REFRESH_ALARM) return;
	if ((await api.idle.queryState(60)) !== "active") {
		api.alarms.clear(REFRESH_ALARM); // in case the idle event was missed
		return;
	}
	const win = await api.windows.getLastFocused();
	if (!win.focused) return;
	const [tab] = await api.tabs.query({ active: true, windowId: win.id });
	if (tab) capture(win.id, tab.id);
});

// --- favicons ---
//
// Sent as 32px PNG data URLs and drawn on canvas, so the page's CSP can't
// block them. The page's own icon is fetched and redrawn (many are ICO or SVG).
// Chrome's _favicon service covers chrome:// pages, and whatever a service
// worker can't decode (SVG), but lags behind a page that just loaded.

const fetchable = (url) => /^(https?|data):/.test(url ?? "");

function iconKey(tab) {
	if (fetchable(tab.favIconUrl)) return tab.favIconUrl;
	return isFirefox ? null : tab.url || null;
}

function iconFor(tab) {
	const key = iconKey(tab);
	if (!key) return null;
	if (!icons.has(key)) loadIcon(key, tab);
	return icons.get(key) || null;
}

async function loadIcon(key, tab) {
	if (iconsLoading.has(key)) return;
	iconsLoading.add(key);
	try {
		icons.set(key, await fetchIcon(tab));
	} catch {
		icons.set(key, "");
	} finally {
		iconsLoading.delete(key);
		saveIcons();
	}
}

async function fetchIcon(tab) {
	if (fetchable(tab.favIconUrl)) {
		try {
			return await redraw(await (await fetch(tab.favIconUrl)).blob());
		} catch {
			if (isFirefox) return "";
		}
	}
	const url = `${api.runtime.getURL("/_favicon/")}?pageUrl=${encodeURIComponent(tab.url)}&size=32`;
	return redraw(await (await fetch(url)).blob());
}

async function redraw(blob) {
	let image;
	if (typeof Image === "function") {
		// Firefox's background page has a DOM, which also decodes SVG
		image = new Image();
		image.src = URL.createObjectURL(blob);
		await image.decode().finally(() => URL.revokeObjectURL(image.src));
	} else {
		image = await createImageBitmap(blob);
	}
	const canvas = new OffscreenCanvas(32, 32);
	canvas.getContext("2d").drawImage(image, 0, 0, 32, 32);
	return blobToDataUrl(await canvas.convertToBlob({ type: "image/png" }));
}

let iconSaveTimer = 0;
function saveIcons() {
	clearTimeout(iconSaveTimer);
	iconSaveTimer = setTimeout(async () => {
		// keep only icons for tabs that are still open
		const tabs = await api.tabs.query({});
		const keep = new Set(tabs.map(iconKey));
		for (const key of icons.keys()) if (!keep.has(key)) icons.delete(key);
		api.storage.session.set({ icons: Object.fromEntries(icons) });
	}, 1000);
}

// --- snapshot sent to the switcher ---

// A cycle gets the few tabs it can reach, with thumbnails. Search gets every
// tab in every window, without thumbnails, since its rows don't show them.
async function snapshot(currentId, { forSearch = false } = {}) {
	await ready;
	let tabs = await api.tabs.query({});
	const byId = new Map(tabs.map((t) => [t.id, t]));
	const current = byId.get(currentId);
	if (settings.thisWindowOnly && !forSearch && current) {
		tabs = tabs.filter((t) => t.windowId === current.windowId);
	}
	const inView = new Set(tabs.map((t) => t.id));
	const known = new Set(stack);
	const ids = [...stack, ...tabs.filter((t) => !known.has(t.id)).map((t) => t.id)].filter((id) => inView.has(id));

	// the tab the switcher opened on always comes first
	if (current) ids.unshift(...ids.splice(ids.indexOf(currentId), 1));
	if (!forSearch) ids.length = Math.min(ids.length, CYCLE_SENT);

	return ids.map((id) => {
		const t = byId.get(id);
		return {
			id: t.id,
			windowId: t.windowId,
			title: t.title,
			url: t.url,
			icon: iconFor(t),
			audible: !!t.audible && !t.mutedInfo?.muted,
			thumb: forSearch ? null : (thumbs.get(t.id) ?? savedThumbs.get(t.url) ?? null),
		};
	});
}

async function recentlyClosed() {
	if (!api.sessions || !settings.includeClosed) return [];
	const sessions = await api.sessions.getRecentlyClosed({ maxResults: CLOSED_SENT });
	return sessions
		.filter((s) => s.tab?.url)
		.map(({ tab }) => ({
			closed: true,
			sessionId: tab.sessionId,
			title: tab.title,
			url: tab.url,
			icon: iconFor(tab),
		}));
}

async function activate(tabId, windowId) {
	await Promise.all([api.tabs.update(tabId, { active: true }), api.windows.update(windowId, { focused: true })]);
}

// --- the switch command ---

api.commands.onCommand.addListener((command, tab) => {
	if (command !== "switch") return;
	const timing = { commandAt: Date.now(), swAgeMs: Math.round(performance.now()) };

	if (switcherPort) {
		switcherStarted.then(() => switcherPort?.postMessage({ type: "cycle" })).catch(() => {});
		return;
	}
	// This page can't show the overlay, so the switcher opens in the toolbar
	// popup. Firefox only opens it while the shortcut is still being handled,
	// before anything is awaited, so decide from what's already known.
	if (tab && started && RESTRICTED.test(tab.url ?? "") && previousTab(tab)) {
		openSwitcher(tab, switcherStart(tab.id), () => {
			commandQueue = commandQueue
				.then(() => cycleWithoutOverlay(tab, timing, { popupFailed: true }))
				.catch((e) => console.error("[tabstack]", e));
		});
		return;
	}
	// Capture the tab being left while it's still on screen: the freshest
	// picture of it there will be.
	if (tab && !overlayOpen.has(tab.id)) captureNow(tab);
	commandQueue = commandQueue.then(() => cycle(tab, timing)).catch((e) => console.error("[tabstack]", e));
});

async function cycle(tab, timing) {
	tab ??= (await api.tabs.query({ active: true, lastFocusedWindow: true }))[0];
	if (!tab) return;

	if (!RESTRICTED.test(tab.url ?? "")) {
		const message = { type: "cycle", timing };
		if (!overlayOpen.has(tab.id)) {
			const start = performance.now();
			const [tabs, shortcut] = await Promise.all([snapshot(tab.id), switchShortcut()]);
			Object.assign(message, { tabs, modifier: shortcut.modifier, switchCode: shortcut.code });
			timing.snapshotMs = Math.round(performance.now() - start);
		}
		try {
			await api.tabs.sendMessage(tab.id, message, { frameId: 0 });
			return;
		} catch {
			// no content script yet (page still loading, or opened before install)
		}
	}
	await cycleWithoutOverlay(tab, timing);
}

// This page can't show the overlay, and the popup didn't open (or the
// background was still starting up). Switch to the previous tab straight away
// and let its overlay carry on the cycle: it sees the modifier come up like
// any page does. When that tab can't show it either, the switcher opens in the
// popup, or in its own window.
async function cycleWithoutOverlay(tab, timing, { popupFailed = false } = {}) {
	const [tabs, shortcut] = await Promise.all([snapshot(tab.id), switchShortcut()]);
	const target = tabs[1];
	if (!target) return;

	if (RESTRICTED.test(target.url ?? "")) {
		const start = { tabs, modifier: shortcut.modifier, switchCode: shortcut.code };
		if (popupFailed) {
			pendingSwitcher = start;
			openSwitcherWindow(tab);
		} else {
			openSwitcher(tab, start);
		}
		return;
	}
	jump = { from: tab.id, via: target.id };
	timing.jumped = true;
	await activate(target.id, target.windowId);
	const message = { type: "cycle", tabs, modifier: shortcut.modifier, switchCode: shortcut.code, jumped: true, timing };
	try {
		await api.tabs.sendMessage(target.id, message, { frameId: 0 });
	} catch {
		// the swap happened; there's just no overlay to keep cycling in
		jump = null;
	}
}

// The tab a cycle from this one goes to first, as far as the stack knows.
function previousTab(tab) {
	const id = stack.find(
		(id) => id !== tab.id && tabInfo.has(id) && (!settings.thisWindowOnly || tabInfo.get(id).windowId === tab.windowId),
	);
	return tabInfo.get(id);
}

async function switcherStart(currentId) {
	const [tabs, shortcut] = await Promise.all([snapshot(currentId), switchShortcut()]);
	return { tabs, modifier: shortcut.modifier, switchCode: shortcut.code };
}

// The toolbar popup opens much faster than a window. It's pointed at the
// switcher only until the switcher connects; clicking the icon shows settings.
function openSwitcher(tab, start, fallback = () => openSwitcherWindow(tab)) {
	pendingSwitcher = start;
	const action = api.action ?? api.browserAction;
	if (!action.openPopup) {
		fallback();
		return;
	}
	action.setPopup({ popup: "switcher.html?popup" });
	action.openPopup().catch(() => {
		action.setPopup({ popup: "settings.html" });
		fallback();
	});
}

async function openSwitcherWindow(tab) {
	const win = await api.windows.get(tab.windowId);
	const width = 920;
	const height = 240;
	await api.windows.create({
		url: "switcher.html",
		type: "popup",
		focused: true,
		width,
		height,
		left: Math.round(win.left + (win.width - width) / 2),
		top: Math.round(win.top + (win.height - height) / 3),
	});
}

// --- the switch shortcut ---

// Chrome reports "⌥⌘J" on macOS and "Ctrl+J" elsewhere; Firefox uses
// "Command" and "MacCtrl", and its "Ctrl" means Command on macOS.
const SHORTCUT_KEYS = {
	",": "Comma", Comma: "Comma", ".": "Period", Period: "Period", Space: "Space",
	Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown", Insert: "Insert", Delete: "Delete",
	"↑": "ArrowUp", Up: "ArrowUp", "↓": "ArrowDown", Down: "ArrowDown",
	"←": "ArrowLeft", Left: "ArrowLeft", "→": "ArrowRight", Right: "ArrowRight",
};

// The shortcut, its key (Shift with it goes back a tab), and its modifier,
// which is the key whose release ends a cycle.
async function switchShortcut() {
	const commands = await api.commands.getAll();
	const shortcut = commands.find((c) => c.name === "switch")?.shortcut ?? "";
	const key = shortcut.includes("+") ? shortcut.split("+").pop() : shortcut.replace(/[⌃⌥⇧⌘]/g, "");

	let code = SHORTCUT_KEYS[key] ?? null;
	if (/^[a-z]$/i.test(key)) code = `Key${key.toUpperCase()}`;
	else if (/^\d$/.test(key)) code = `Digit${key}`;
	else if (/^F\d+$/.test(key)) code = key;

	let modifier = isMac ? "Meta" : "Control";
	if (/⌘|Command/.test(shortcut)) modifier = "Meta";
	else if (/⌃|MacCtrl/.test(shortcut)) modifier = "Control";
	else if (/Ctrl/.test(shortcut)) modifier = isMac && isFirefox ? "Meta" : "Control";
	else if (/⌥|Alt/.test(shortcut)) modifier = "Alt";

	return { shortcut, code, modifier };
}

// Chrome silently skips a suggested shortcut that's already taken. Turn the
// toolbar icon red until one is set, rather than doing nothing on Cmd+J.
let lastShortcutCheck = 0;
async function checkShortcut() {
	lastShortcutCheck = Date.now();
	const { shortcut } = await switchShortcut();
	const action = api.action ?? api.browserAction; // Firefox's build is Manifest V2
	action.setIcon({ path: shortcut ? ICONS : WARNING_ICONS });
	action.setTitle({ title: shortcut ? "tabstack" : "tabstack: no shortcut set. Click to choose one." });
}

checkShortcut();
api.commands.onChanged?.addListener(checkShortcut);

// --- messages from content scripts and the settings page ---

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
	const tabId = sender.tab?.id;
	switch (msg.type) {
		case "tabs":
			if (msg.search) {
				Promise.all([snapshot(tabId, { forSearch: true }), recentlyClosed()]).then(([tabs, closed]) =>
					sendResponse({ tabs, closed }),
				);
			} else {
				snapshot(tabId).then(sendResponse);
			}
			return true;
		case "activate":
			if (jump?.via === tabId && msg.tabId !== jump.via && msg.tabId !== jump.from) jump.to = msg.tabId;
			activate(msg.tabId, msg.windowId);
			break;
		case "restore":
			api.sessions.restore(msg.sessionId);
			break;
		case "closeTab":
			api.tabs.remove(msg.tabId).catch(() => {});
			break;
		case "open":
			overlayOpen.add(tabId);
			break;
		case "close":
			overlayOpen.delete(tabId);
			if (jump?.via === tabId && jump.to == null) jump = null;
			break;
		case "relay":
			// from an iframe to the top frame, which owns the overlay
			api.tabs.sendMessage(tabId, msg.message, { frameId: 0 }).catch(() => {});
			break;
		case "checkShortcut":
			checkShortcut();
			break;
	}
	sendResponse({ ok: true });
});

// --- the switcher popup or window ---

api.runtime.onConnect.addListener((port) => {
	if (port.name !== "switcher") return;
	switcherPort = port;
	(api.action ?? api.browserAction).setPopup({ popup: "settings.html" });
	const start = pendingSwitcher;
	pendingSwitcher = null;
	switcherStarted = Promise.resolve(start)
		.then((s) => port.postMessage({ type: "start", ...s }))
		.catch(() => {}); // closed before it started

	port.onDisconnect.addListener(() => {
		if (switcherPort === port) switcherPort = null;
	});
	port.onMessage.addListener(async (msg) => {
		if (msg.type === "activate" || msg.type === "restore") {
			if (msg.type === "activate") await activate(msg.tabId, msg.windowId);
			else await api.sessions.restore(msg.sessionId);
			try {
				port.postMessage({ type: "done" });
			} catch {
				// the window already closed itself
			}
		} else if (msg.type === "closeTab") {
			api.tabs.remove(msg.tabId).catch(() => {});
		} else if (msg.type === "search") {
			const [tabs, closed] = await Promise.all([snapshot(msg.currentId, { forSearch: true }), recentlyClosed()]);
			port.postMessage({ type: "tabs", tabs, closed });
		}
	});
});
