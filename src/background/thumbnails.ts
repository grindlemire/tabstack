// Thumbnails and favicons for the switcher's cards and rows. Each tab's
// thumbnail is captured when it's shown, refreshed while you look at it, and
// kept by the page's address across restarts.

import { api, isFirefox } from "../shared/api";
import { overlayCanRun } from "./urls";

const THUMB_WIDTH = 400;
const THUMB_LIMIT = 50; // keep thumbnails for this many recent tabs
const SAVED_LIMIT = 100; // thumbnails kept across restarts, by page URL
const CAPTURE_DELAY = 400; // let the page paint after activation
const CAPTURE_GAP = 600; // Chrome allows ~2 captures per second
const REFRESH_ALARM = "refresh-thumbnail";

// What's kept of these in storage.session.
export interface ThumbStore {
	icons?: Record<string, string>;
	[thumb: `thumb:${number}`]: string;
}

// What the background lends this: the tab stack, which says whose
// thumbnails to keep, and whether a tab is showing the overlay, which
// mustn't land in its picture.
interface Hooks {
	recent: () => readonly number[];
	showing: (tabId: number) => boolean;
}

export function createThumbnails({ recent, showing }: Hooks) {
	const thumbs = new Map<number, string>(); // tab id -> data URL
	const savedThumbs = new Map<string, string>(); // page address (savedKey) -> data URL, from earlier sessions
	let savedIndex: string[] = []; // page addresses with a saved thumbnail, most recent first
	const icons = new Map<string, string>(); // icon key -> data URL, or "" when there's none
	const iconsLoading = new Set<string>();
	const captureTimers = new Map<number, ReturnType<typeof setTimeout>>(); // window id -> timeout
	let lastCaptureAt = 0;

	// Captures wait for load: for the stack they're trimmed by, and the saved
	// index they're added to.
	let loaded!: () => void;
	const ready = new Promise<void>((resolve) => (loaded = resolve));

	// Called once the background has its tab stack.
	async function load(saved: ThumbStore, tabs: chrome.tabs.Tab[]) {
		const ids = new Set(tabs.map((t) => t.id));
		for (const [key, value] of Object.entries(saved)) {
			const id = Number(key.slice(6));
			if (key.startsWith("thumb:") && ids.has(id)) thumbs.set(id, value as string);
		}
		for (const [key, value] of Object.entries(saved.icons ?? {})) icons.set(key, value);

		// Chrome can only capture the tab on screen, so tabs restored at startup
		// show the picture from their last visit until they're seen again.
		savedIndex = (await savedStore("readonly", (store) => store.get(SAVED_INDEX)).catch(() => null))?.result ?? [];
		await loadSaved(tabs.filter((t) => !thumbs.has(t.id!)).map((t) => t.url));
		loaded();
		if (api.tabs.captureTab) captureInBackground(tabs);
		for (const tab of tabs) iconFor(tab); // fetch any that are missing
	}

	const thumbFor = (tab: chrome.tabs.Tab) => thumbs.get(tab.id!) ?? savedThumbs.get(savedKey(tab.url) ?? "") ?? null;

	function forget(tabId: number) {
		thumbs.delete(tabId);
		api.storage.session.remove(`thumb:${tabId}`);
	}

	api.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
		await ready;
		scheduleCapture(windowId, tabId);
	});

	api.tabs.onRemoved.addListener(async (tabId) => {
		await ready;
		forget(tabId);
	});

	// Chrome swaps in prerendered pages under a new tab id. The page it
	// replaced is the best picture there is until it's captured.
	api.tabs.onReplaced?.addListener(async (added, removed) => {
		await ready;
		const thumb = thumbs.get(removed);
		forget(removed);
		if (!thumb) return;
		thumbs.set(added, thumb);
		api.storage.session.set({ [`thumb:${added}`]: thumb });
	});

	api.tabs.onUpdated.addListener(async (tabId, change, tab) => {
		if (!change.status && !change.favIconUrl && !change.url) return;
		// a new favicon URL gets a new key, so iconFor() fetches it
		await ready;
		if (change.url) loadSaved([change.url]);
		if (change.status === "complete" && tab.active) scheduleCapture(tab.windowId, tabId);
		iconFor(tab);
	});

	// --- capturing ---

	function scheduleCapture(windowId: number, tabId: number, delay = CAPTURE_DELAY) {
		clearTimeout(captureTimers.get(windowId));
		captureTimers.set(
			windowId,
			setTimeout(() => capture(windowId, tabId), delay),
		);
	}

	async function capture(windowId: number, tabId: number) {
		captureTimers.delete(windowId);

		const wait = lastCaptureAt + CAPTURE_GAP - Date.now();
		if (wait > 0) return scheduleCapture(windowId, tabId, wait);

		let tab: chrome.tabs.Tab;
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
	async function captureNow(tab: chrome.tabs.Tab) {
		if (showing(tab.id!) || !overlayCanRun(tab.url)) return;
		lastCaptureAt = Date.now();
		try {
			const shot = await api.tabs.captureVisibleTab(tab.windowId, captureOptions(tab));
			await keepThumb(tab, await shrink(shot));
		} catch (e) {
			// minimized window, or the tab moved on; hitting the rate limit is routine
			if (!/MAX_CAPTURE/.test((e as Error).message))
				console.warn("[tabstack] capture failed:", tab.url, (e as Error).message ?? e);
		}
	}

	// Firefox can capture at a given scale, which saves encoding a full Retina
	// screenshot only to shrink it; Chrome always captures at full size.
	function captureOptions(tab: chrome.tabs.Tab) {
		const options: chrome.extensionTypes.ImageDetails = { format: "jpeg", quality: 70 };
		if (isFirefox && tab.width) options.scale = Math.min(1, THUMB_WIDTH / tab.width);
		return options;
	}

	async function shrink(dataUrl: string) {
		const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
		const height = Math.round((bitmap.height * THUMB_WIDTH) / bitmap.width);
		const canvas = new OffscreenCanvas(THUMB_WIDTH, height);
		canvas.getContext("2d")!.drawImage(bitmap, 0, 0, THUMB_WIDTH, height);
		bitmap.close();
		return blobToDataUrl(await canvas.convertToBlob({ type: "image/webp", quality: 0.75 }));
	}

	async function keepThumb(tab: chrome.tabs.Tab, thumb: string) {
		await ready;
		thumbs.set(tab.id!, thumb);
		api.storage.session.set({ [`thumb:${tab.id}`]: thumb });
		trimThumbs();
		if (!tab.incognito) saveByUrl(tab.url, thumb);
	}

	// Firefox can capture tabs that aren't on screen, as long as they're loaded,
	// so at startup it fills in what the saved thumbnails don't cover.
	async function captureInBackground(tabs: chrome.tabs.Tab[]) {
		const missing = tabs.filter((t) => !t.active && !t.discarded && t.status === "complete" && overlayCanRun(t.url));
		for (const tab of missing.filter((t) => !thumbs.has(t.id!)).slice(0, THUMB_LIMIT)) {
			try {
				await keepThumb(tab, await shrink(await api.tabs.captureTab!(tab.id, captureOptions(tab))));
			} catch {}
		}
	}

	function trimThumbs() {
		const keep = new Set(recent().slice(0, THUMB_LIMIT));
		for (const id of thumbs.keys()) if (!keep.has(id)) forget(id);
	}

	// --- kept across restarts ---

	async function loadSaved(urls: (string | undefined)[]) {
		const keys = urls.map(savedKey).filter((k): k is string => !!k && !savedThumbs.has(k) && savedIndex.includes(k));
		if (!keys.length) return;
		const found = await savedStore("readonly", (store) => keys.map((k) => [k, store.get(k)] as const)).catch(() => []);
		for (const [key, req] of found) if (req.result) savedThumbs.set(key, req.result);
	}

	function saveByUrl(url: string | undefined, thumb: string) {
		const key = savedKey(url);
		if (!key) return;
		savedThumbs.set(key, thumb);
		savedIndex = [key, ...savedIndex.filter((k) => k !== key)];
		const dropped = savedIndex.splice(SAVED_LIMIT);
		savedStore("readwrite", (store) => {
			store.put(thumb, key);
			store.put(savedIndex, SAVED_INDEX);
			for (const k of dropped) store.delete(k);
		}).catch(() => {});
		for (const k of dropped) savedThumbs.delete(k);
	}

	// --- refreshing ---

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
		if (tab) capture(win.id!, tab.id!);
	});

	// --- favicons ---
	//
	// Sent as 32px PNG data URLs and drawn on canvas, so the page's CSP can't
	// block them. The page's own icon is fetched and redrawn (many are ICO or SVG).
	// Chrome's _favicon service covers chrome:// pages, and whatever a service
	// worker can't decode (SVG), but lags behind a page that just loaded.

	function iconKey(tab: chrome.tabs.Tab) {
		if (fetchable(tab.favIconUrl)) return tab.favIconUrl;
		return isFirefox ? null : tab.url || null;
	}

	function iconFor(tab: chrome.tabs.Tab) {
		const key = iconKey(tab);
		if (!key) return null;
		if (!icons.has(key)) loadIcon(key, tab);
		return icons.get(key) || null;
	}

	async function loadIcon(key: string, tab: chrome.tabs.Tab) {
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

	async function fetchIcon(tab: chrome.tabs.Tab) {
		if (fetchable(tab.favIconUrl)) {
			try {
				return await redraw(await (await fetch(tab.favIconUrl)).blob());
			} catch {
				if (isFirefox) return "";
			}
		}
		if (!tab.url) return "";
		const url = `${api.runtime.getURL("/_favicon/")}?pageUrl=${encodeURIComponent(tab.url)}&size=32`;
		return redraw(await (await fetch(url)).blob());
	}

	let iconSaveTimer: ReturnType<typeof setTimeout> | 0 = 0;
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

	return { load, captureNow, thumbFor, iconFor };
}

const fetchable = (url: string | undefined): url is string => /^(https?|data):/.test(url ?? "");

async function redraw(blob: Blob) {
	let image: HTMLImageElement | ImageBitmap;
	if (typeof Image === "function") {
		// Firefox's background page has a DOM, which also decodes SVG
		image = new Image();
		image.src = URL.createObjectURL(blob);
		await image.decode().finally(() => URL.revokeObjectURL((image as HTMLImageElement).src));
	} else {
		image = await createImageBitmap(blob);
	}
	const canvas = new OffscreenCanvas(32, 32);
	canvas.getContext("2d")!.drawImage(image, 0, 0, 32, 32);
	return blobToDataUrl(await canvas.convertToBlob({ type: "image/png" }));
}

async function blobToDataUrl(blob: Blob) {
	const bytes = new Uint8Array(await blob.arrayBuffer());
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return `data:${blob.type};base64,${btoa(binary)}`;
}

// Thumbnails kept across restarts are pictures of where you've been, so they
// go in the background's own IndexedDB, which content scripts can't reach, as
// they can storage.local. They're kept by the page's address without its
// query or fragment, which can carry search terms and tokens.
const SAVED_INDEX = 0; // savedIndex's key: a number, so no address can be it
const savedKey = (url: string | undefined) => url?.split(/[?#]/, 1)[0] || null;

let savedDb: Promise<IDBDatabase> | null = null;
function savedStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => T): Promise<T> {
	savedDb ??= new Promise<IDBDatabase>((resolve, reject) => {
		const req = indexedDB.open("tabstack", 1);
		req.onupgradeneeded = () => req.result.createObjectStore("saved");
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	}).catch((e) => {
		savedDb = null; // try again next time
		throw e;
	});
	// settles once the transaction is done, with what fn returned (its requests)
	return savedDb.then(
		(db) =>
			new Promise<T>((resolve, reject) => {
				const tx = db.transaction("saved", mode);
				const out = fn(tx.objectStore("saved"));
				tx.oncomplete = () => resolve(out);
				tx.onerror = tx.onabort = () => reject(tx.error);
			}),
	);
}
