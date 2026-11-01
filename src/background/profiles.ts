// Everything tabstack does across this browser's profiles: switching between
// them, searching their tabs, moving links to the profile they belong to, and
// keeping their windows stacked.
//
// Each profile runs its own copy of tabstack, and extensions can't reach
// across profiles, so every copy connects to a native helper (cmd/tabstack/) that
// passes messages between them. Few people install it, so none of this shows
// until they do: the permission it needs is optional, asked for from the
// setup page (setup.html). Without it, or without the helper running, its
// listeners still wake the worker, since Manifest V3 wants them registered at
// load, but each returns on its first line.
// Chrome only; the Firefox build leaves it out.

import { api } from "../shared/api";
import { ICONS } from "../shared/icons";
import type {
	ClosedItem,
	Elsewhere,
	Label,
	Mark,
	PageMessage,
	ProfileSwitchItem,
	ProfilesStatus,
	SearchTabs,
	SharedSettings,
	TabItem,
} from "../shared/messages";
import { covers, pageKey } from "./covers";

// What the background lends this module (snapshot and recentlyClosed).
interface Hooks {
	snapshot: (
		currentId: number | null | undefined,
		options?: { forSearch?: boolean; incognito?: boolean },
	) => Promise<TabItem[]>;
	recentlyClosed: () => Promise<ClosedItem[]>;
}

// The shared settings, and when they were last changed.
interface SharedState {
	values: SharedSettings;
	at: number;
}

// Where a window is, so another profile's can take its place.
interface Frame {
	state?: `${chrome.windows.WindowState}`;
	left?: number;
	top?: number;
	width?: number;
	height?: number;
}

// What a profile tells the others of itself (sendState's info).
interface PeerInfo {
	name?: string;
	mark?: Mark | null;
	claims?: string[];
	where?: string;
	done?: string;
	shared?: { values: Partial<SharedSettings>; at: number };
}

// A connected profile, as the helper lists it.
interface Peer {
	profile: string;
	windows: number;
	info?: PeerInfo;
}

// What another profile answers an ask with.
interface Reply {
	kind: "reply";
	rid: string;
	from: string;
	tabs?: TabItem[];
	closed?: ClosedItem[];
	tab?: { id: number; windowId: number } | null;
}

// What one profile sends another, by way of the helper.
type PeerBody =
	| Omit<Reply, "from">
	| { kind: "tabs"; rid: string }
	| { kind: "find"; rid: string; url?: string }
	| { kind: "focus"; frame?: Frame | null }
	| { kind: "activate"; tabId: number; windowId: number; frame?: Frame | null }
	| { kind: "restore"; sessionId?: string; frame?: Frame | null }
	| { kind: "close"; tabId: number }
	| { kind: "open"; url: string; toast?: boolean; frame?: Frame | null }
	| { kind: "bounds"; frame?: Frame | null };

// What the tabstack command sends (from starts with "cli").
type CliBody =
	| { kind: "tabs"; rid: string }
	| { kind: "focus"; rid: string; tabId?: number }
	| { kind: "open"; rid: string; url: string }
	| { kind: "forget" }
	| { kind: "rename"; name?: string }
	| { kind: "links"; links?: string[] }
	| { kind: "reset"; name?: string };

// From the helper over the native port.
type FromHelper =
	| { type: "peers"; peers: Peer[] }
	| { type: "msg"; from: string; body?: PeerBody }
	| { type: "reconnect" };

// What one profile sends another, or the command line, as post passes it on.
type Sent = { kind: string; [field: string]: unknown };

// A notice on the page, and what its button does.
interface Toast {
	text: string;
	action: string;
	run: () => void;
	mark?: Mark | null;
}

export function createProfiles() {
	const HOST = "dev.alethi.tabstack";
	const ASK_TIMEOUT = 300; // ms to wait for other profiles to answer
	const MAX_REPLY = 900_000; // bytes; the helper drops messages over 1 MB
	const EXEMPT_FOR = 10_000; // ms a tab opened from another profile isn't moved again
	const FRESH_FOR = 3000; // ms; a tab this new when it navigates was opened for that link
	const DUPE_CHECK_FOR = 10_000; // ms after opening that a tab is checked against other profiles
	const TOAST_ACTION_FOR = 30_000;
	const BOUNDS_DELAY = 250; // let a drag or resize settle before the others follow
	const RESTART_GAP = 60_000; // ms; restarting to connect is tried once, not in a loop
	// ms before connecting again to a helper that stopped, doubling each time
	// it stops without answering. A worker that sleeps in between connects
	// when it wakes instead (start).
	const RETRY_FIRST = 1000;
	const RETRY_MAX = 60_000;

	// Settings every profile shares. Each keeps a copy, and the newest wins.
	const SHARED_DEFAULTS: SharedSettings = {
		searchAll: true,
		searchProfiles: true,
		stack: true,
		dupes: true,
		route: true,
	};

	let hooks: Hooks | null = null; // { snapshot, recentlyClosed } from background/index.ts
	let port: chrome.runtime.Port | null = null;
	let enabled = false; // the helper's permission is granted
	let connected = false; // the helper answered
	let lastError = "";
	let profile: string | null = null; // this profile's ID; profiles are listed in the order of their IDs
	let peers: Peer[] = []; // every connected profile, this one included: { profile, windows, info }
	// this profile's name, its mark ({ glyph, color }), the links that belong
	// to it, and, from tabstack install, where it is and which install
	// run's setup page was finished
	let local: { name: string; mark: Mark | null; claims: string[]; where: string; done: string } = {
		name: "",
		mark: null,
		claims: [],
		where: "",
		done: "",
	};
	let shared: SharedState = { values: SHARED_DEFAULTS, at: 0 };
	let started: Promise<void> | null = null;
	let retryIn = RETRY_FIRST;
	let retryTimer: ReturnType<typeof setTimeout> | 0 = 0;

	const pending = new Map<string, { replies: Reply[]; expected: number; done: () => void }>(); // request id -> { replies, expected, done }
	const exempt = new Map<number, number>(); // tab id -> time until which it isn't moved
	const arriving = new Map<string, number>(); // URL being opened from another profile -> until when
	const tabUrls = new Map<number, string | undefined>(); // tab id -> the URL it was last at
	const createdAt = new Map<number, number>(); // tab id -> when it opened
	const toastActions = new Map<string, () => void>(); // toast id -> what its button does

	const granted = () => api.permissions.contains({ permissions: ["nativeMessaging"] });
	const others = () => peers.filter((p) => p.profile !== profile);
	// Incognito tabs stay in this profile: no other profile, nor the command
	// line, is told of them.
	const shareableTabs = async () => (await api.tabs.query({})).filter((t) => !t.incognito);

	// What a profile's called: the name it was given, or its place in the list.
	function nameOf(id: string | null) {
		const i = peers.findIndex((p) => p.profile === id);
		return peers[i]?.info?.name || (i >= 0 ? `Profile ${i + 1}` : "another profile");
	}

	// A profile's mark, with its icon's path filled in from this copy's
	// icons, so it's drawn the same here as there. Profiles share only the
	// mark itself, since what they share goes to every profile on any change.
	function markOf(id: string): Mark | null {
		const mark = peers.find((p) => p.profile === id)?.info?.mark;
		if (!mark) return null;
		const path = mark.icon && Object.hasOwn(ICONS, mark.icon) && ICONS[mark.icon];
		return { ...mark, ...(path && { path }) };
	}

	// --- connecting ---

	function init(h: Hooks) {
		hooks = h;
		start();
	}

	function start() {
		started ??= (async () => {
			enabled = await granted();
			if (!enabled) {
				publishLabel();
				return;
			}
			const [{ profileId, profileShared, profileWhere, setupDone, reopenSetup }, sync, tabs] = await Promise.all([
				api.storage.local.get<{
					profileId?: string;
					profileShared?: SharedState;
					profileWhere?: string;
					setupDone?: string;
					reopenSetup?: string | boolean;
				}>(["profileId", "profileShared", "profileWhere", "setupDone", "reopenSetup"]),
				api.storage.sync.get<{ profileName?: string; profileMark?: Mark | null; profileClaims?: string[] }>([
					"profileName",
					"profileMark",
					"profileClaims",
				]),
				api.tabs.query({}),
			]);
			// made from the time, so profiles are listed in the order they were set up
			profile = profileId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			if (!profileId) api.storage.local.set({ profileId: profile });
			if (profileShared) shared = { ...profileShared, values: { ...SHARED_DEFAULTS, ...profileShared.values } };
			local = {
				name: sync.profileName ?? "",
				mark: sync.profileMark ?? null,
				claims: strings(sync.profileClaims),
				where: profileWhere ?? "",
				done: setupDone ?? "",
			};
			publishLabel();
			for (const tab of tabs) tabUrls.set(tab.id!, tab.url);
			if (reopenSetup) {
				api.storage.local.remove("reopenSetup");
				api.tabs.create({ url: typeof reopenSetup === "string" ? reopenSetup : "setup.html" });
			}
			if (typeof api.runtime.connectNative !== "function") await restart();
			else connect();
		})().finally(() => (started = null));
		return started;
	}

	// Chrome only gives connectNative to a worker started after the permission
	// was granted, not the one running when it was. So the first time, tabstack
	// restarts itself, and brings back the setup page it was connected from.
	async function restart() {
		const { restartedAt = 0 } = await api.storage.local.get<{ restartedAt?: number }>("restartedAt");
		if (Date.now() - restartedAt < RESTART_GAP) {
			lastError = "Chrome hasn't let tabstack reach the helper yet. Reload tabstack on chrome://extensions";
			return;
		}
		// the setup page left its own address, with what install told it
		const { setupUrl } = await api.storage.local.get<{ setupUrl?: string }>("setupUrl");
		await api.storage.local.set({ restartedAt: Date.now(), reopenSetup: setupUrl ?? true });
		api.runtime.reload();
	}

	// An open connection also keeps the service worker running, so this
	// profile can be asked for its tabs, or handed the turn, at any time.
	function connect() {
		if (port || !profile || typeof api.runtime.connectNative !== "function") return;
		const p = api.runtime.connectNative(HOST);
		port = p;
		p.onMessage.addListener(onMessage);
		p.onDisconnect.addListener(() => {
			const error = api.runtime.lastError?.message ?? "the helper stopped";
			if (port !== p) return;
			port = null; // already closed
			teardown(error);
			// a helper that isn't installed, or doesn't list this extension,
			// won't be there on a retry either
			if (enabled && !/not found|forbidden/i.test(error)) retryLater();
		});
		sendState();
	}

	// Closes the connection, if it's open, and takes the other profiles out
	// of the menus and the label.
	function teardown(error = "") {
		clearTimeout(retryTimer);
		retryTimer = 0;
		const p = port;
		port = null;
		p?.disconnect();
		connected = false;
		peers = [];
		lastError = error;
		// what's kept by tab is only kept while connected (start fills tabUrls again)
		for (const map of [exempt, tabUrls, createdAt]) map.clear();
		dupeChecked.clear();
		arriving.clear();
		updateMenus();
		publishLabel();
	}

	function retryLater() {
		retryTimer = setTimeout(() => {
			retryTimer = 0;
			if (enabled && !port) start();
		}, retryIn);
		retryIn = Math.min(retryIn * 2, RETRY_MAX);
	}

	// What this profile shows of itself: its name over search (ui/index.ts), and
	// its mark as the toolbar icon (background/index.ts). It's kept in storage, so
	// search has it the moment it opens. A profile with no name yet goes by
	// its place in the list, once the helper has sent the list. A mark's icon
	// goes with it, so pages needn't load every icon to show one.
	//
	// The other profiles go with it, numbered as the popup's Switch tab
	// numbers them, so search can switch to one by its number the moment
	// it opens, without waiting on their tabs.
	let label: Label | null | undefined;
	function publishLabel() {
		const name = local.name || (connected ? nameOf(profile) : "");
		const path = local.mark?.icon && ICONS[local.mark.icon];
		const mark = local.mark && { ...local.mark, ...(path && { path }) };
		const switchTo =
			connected && shared.values.searchProfiles
				? peers.flatMap((p, i) =>
						p.profile === profile || i >= 9
							? []
							: [
									{
										n: i + 1,
										profile: p.profile,
										name: nameOf(p.profile),
										mark: markOf(p.profile),
										windows: p.windows,
									},
								],
					)
				: [];
		const next: Label | null = enabled && (name || mark) ? { name, mark, ...(switchTo.length && { switchTo }) } : null;
		if (JSON.stringify(next) === JSON.stringify(label)) return;
		label = next;
		if (next) api.storage.local.set({ profileLabel: next });
		else api.storage.local.remove("profileLabel");
	}

	async function sendState() {
		if (!port) return;
		// incognito windows aren't counted: they're not for other profiles to switch to
		const windows = (await api.windows.getAll({ windowTypes: ["normal"] })).filter((w) => !w.incognito);
		port?.postMessage({
			type: "state",
			profile,
			windows: windows.length,
			// where tells tabstack install which of the browser's profiles this is
			info: { name: local.name, mark: local.mark, claims: local.claims, where: local.where, done: local.done, shared },
		});
	}

	function onMessage(msg: FromHelper) {
		if (msg.type === "peers") {
			connected = true;
			lastError = "";
			retryIn = RETRY_FIRST;
			peers = msg.peers.map((p) => ({ ...p, info: cleanInfo(p.info) }));
			for (const p of peers) {
				const theirs = p.info?.shared;
				if (theirs && theirs.at > shared.at) {
					shared = { ...theirs, values: { ...SHARED_DEFAULTS, ...theirs.values } };
					api.storage.local.set({ profileShared: shared });
				}
			}
			updateMenus();
			publishLabel();
		} else if (msg.type === "msg") {
			onBody(msg.from, msg.body ?? ({} as PeerBody)).catch((e) => console.warn("[tabstack]", e));
		} else if (msg.type === "reconnect") {
			// a new helper is installed; connecting again starts it
			reconnect();
		}
	}

	// --- talking to other profiles ---

	function post(to: string, body: Sent) {
		port?.postMessage({ type: "send", to, body });
	}

	// Asks every other profile, and settles with the answers that come back in time.
	function ask(body: Sent): Promise<Reply[]> {
		const expected = others().length;
		if (!connected || !expected) return Promise.resolve([]);
		const rid = crypto.randomUUID();
		return new Promise((resolve) => {
			const entry = {
				replies: [] as Reply[],
				expected,
				done() {
					clearTimeout(timer);
					pending.delete(rid);
					resolve(entry.replies);
				},
			};
			const timer = setTimeout(entry.done, ASK_TIMEOUT);
			pending.set(rid, entry);
			post("*", { ...body, rid });
		});
	}

	function reply(to: string, rid: string, body: object) {
		post(to, { ...body, kind: "reply", rid });
	}

	async function onBody(from: string, body: PeerBody) {
		if (from.startsWith("cli")) return fromCommandLine(from, body as CliBody);
		switch (body.kind) {
			case "reply": {
				const entry = pending.get(body.rid);
				if (!entry) return;
				entry.replies.push({ ...body, from });
				if (entry.replies.length >= entry.expected) entry.done();
				return;
			}
			case "tabs":
				reply(from, body.rid, await tabsForSearch());
				return;
			case "find":
				reply(from, body.rid, { tab: await findTab(body.url) });
				return;
			case "focus": {
				// picked in the popup with no window left open: it opens one
				const win = (await lastWindow()) ?? (await api.windows.create({ focused: true }));
				await present(win, body.frame);
				return;
			}
			// Chrome throws at once, past any catch, on an ID that isn't a number
			case "activate":
				if (typeof body.tabId !== "number" || typeof body.windowId !== "number") return;
				await api.tabs.update(body.tabId, { active: true }).catch(() => {});
				await present(await api.windows.get(body.windowId).catch(() => null), body.frame);
				return;
			case "restore": {
				const session = await api.sessions.restore(body.sessionId).catch(() => null);
				const windowId = session?.tab?.windowId ?? session?.window?.id;
				if (windowId != null) await present(await api.windows.get(windowId).catch(() => null), body.frame);
				return;
			}
			case "close":
				if (typeof body.tabId === "number") api.tabs.remove(body.tabId).catch(() => {});
				return;
			case "open":
				await openHere(from, body);
				return;
			case "bounds":
				await follow(body.frame);
				return;
		}
	}

	// the tabstack command's (cmd/tabstack/manage.go and tabs.go). Some it
	// sees take effect in the list of profiles; the rest are answered.
	async function fromCommandLine(from: string, body: CliBody) {
		switch (body.kind) {
			case "tabs": {
				// every tab, most recently used first, without icons
				const tabs = await shareableTabs();
				tabs.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
				reply(from, body.rid, {
					tabs: tabs.map((t) => ({
						id: t.id,
						windowId: t.windowId,
						title: t.title,
						url: t.url,
						lastAccessed: t.lastAccessed,
					})),
				});
				return;
			}
			case "focus": {
				let win = await lastWindow();
				if (body.tabId != null) {
					// an incognito tab isn't listed, so it isn't here either
					const tab = typeof body.tabId === "number" ? await api.tabs.get(body.tabId).catch(() => null) : null;
					if (!tab || tab.incognito) return reply(from, body.rid, { error: `there's no tab ${body.tabId} here` });
					await api.tabs.update(tab.id!, { active: true }).catch(() => {});
					win = await api.windows.get(tab.windowId).catch(() => null);
				}
				if (!win) return reply(from, body.rid, { error: "it has no window open" });
				await present(win);
				reply(from, body.rid, { ok: true });
				return;
			}
			case "open":
				await openHere(from, { url: body.url });
				reply(from, body.rid, { ok: true });
				return;
			case "forget":
				// like "Turn off profile features" in the popup, which offers
				// to turn them back on
				await api.storage.sync.set({ profilesAdHidden: false });
				await api.permissions.remove({ permissions: ["nativeMessaging", "contextMenus"] }).catch(() => {});
				// at once, without waiting on the permission's removal to be reported
				enabled = false;
				teardown();
				return;
			case "rename":
				await api.storage.sync.set({ profileName: typeof body.name === "string" ? body.name : "" });
				return;
			case "links":
				await api.storage.sync.set({ profileClaims: strings(body.links) });
				return;
			case "reset":
				await api.storage.sync.set({ profileName: typeof body.name === "string" ? body.name : "", profileClaims: [] });
				await reconnect();
				return;
		}
	}

	// --- windows ---

	// This profile's most recent window: the one that comes forward. Never an
	// incognito one: links from other profiles don't open there, switching
	// profiles doesn't bring it forward, and its place isn't passed on. When
	// the last focused window is incognito, it's the window of the tab used
	// most recently.
	async function lastWindow(): Promise<chrome.windows.Window | null> {
		const win = await api.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
		if (!win?.incognito) return win;
		const tabs = (await api.tabs.query({ windowType: "normal" })).filter((t) => !t.incognito);
		const last = tabs.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
		return last ? api.windows.get(last.windowId).catch(() => null) : null;
	}

	// Where the window being left is, so the next one can take its place.
	async function currentFrame(): Promise<Frame | null> {
		const win = await lastWindow();
		if (!win) return null;
		const { state, left, top, width, height } = win;
		return { state, left, top, width, height };
	}

	// Brings a window forward, in the place of the one being left when the
	// windows are kept stacked.
	async function present(win: chrome.windows.Window | null | undefined, frame?: Frame | null) {
		if (!win) return;
		if (frame && shared.values.stack) {
			if (frame.state === "normal") {
				// a minimized or maximized window won't take a size
				if (win.state !== "normal") await api.windows.update(win.id!, { state: "normal" });
				const { left, top, width, height } = frame;
				await api.windows.update(win.id!, { left, top, width, height, focused: true });
				return;
			}
			if (frame.state === "maximized" || frame.state === "fullscreen") {
				await api.windows.update(win.id!, { state: frame.state, focused: true });
				return;
			}
		}
		if (win.state === "minimized") await api.windows.update(win.id!, { state: "normal" });
		await api.windows.update(win.id!, { focused: true });
	}

	// Another profile's window moved or resized: move this profile's to match,
	// without bringing it forward.
	async function follow(frame: Frame | null | undefined) {
		if (!shared.values.stack || frame?.state !== "normal") return;
		const win = await lastWindow();
		if (win?.state !== "normal") return;
		const { left, top, width, height } = frame;
		await api.windows.update(win.id!, { left, top, width, height }).catch(() => {});
	}

	let boundsTimer: ReturnType<typeof setTimeout> | 0 = 0;
	api.windows.onBoundsChanged?.addListener((win) => {
		if (!port) return;
		// only the window in front leads; the others moving to match don't,
		// nor does an incognito one
		if (!win.focused || win.incognito || !connected || !shared.values.stack) return;
		clearTimeout(boundsTimer);
		boundsTimer = setTimeout(async () => post("*", { kind: "bounds", frame: await currentFrame() }), BOUNDS_DELAY);
	});

	api.windows.onCreated.addListener(() => {
		if (!port) return;
		sendState();
	});
	api.windows.onRemoved.addListener(() => {
		if (!port) return;
		sendState();
	});

	// Hands the turn to the next profile with a window open, or the previous
	// one, in the order profiles are listed.
	async function cycle(dir: number) {
		const ring = peers.filter((p) => p.windows > 0 || p.profile === profile);
		const i = ring.findIndex((p) => p.profile === profile);
		if (i < 0 || ring.length < 2) return;
		const to = ring[(i + dir + ring.length) % ring.length]!;
		post(to.profile, { kind: "focus", frame: await currentFrame() });
	}

	api.commands.onCommand.addListener((command) => {
		if (!port) return;
		if (command === "profile-next") cycle(1);
		else if (command === "profile-prev") cycle(-1);
	});

	// --- search ---

	// This profile's tabs, for another profile's search. Icons go first when
	// the answer is too big to pass on, then the least recent tabs.
	async function tabsForSearch(): Promise<SearchTabs> {
		if (!hooks) return { tabs: [], closed: [] };
		const [tabs, closed] = await Promise.all([
			hooks.snapshot(null, { forSearch: true, incognito: false }),
			// needs no such filter: Chrome doesn't keep closed incognito tabs
			// with the profile's, so the extension is never shown them
			hooks.recentlyClosed(),
		]);
		let answer: SearchTabs = { tabs, closed };
		const size = () => new TextEncoder().encode(JSON.stringify(answer)).length;
		if (size() > MAX_REPLY) {
			const bare = <T extends TabItem | ClosedItem>(t: T): T => ({ ...t, icon: null });
			answer = { tabs: tabs.map(bare), closed: closed.map(bare) };
		}
		while (size() > MAX_REPLY && answer.tabs.length) answer.tabs.length = Math.floor(answer.tabs.length * 0.8);
		return answer;
	}

	// Every other profile's tabs, labeled with the profile they're in, and
	// the profiles themselves, so typing one's name switches to it. Their
	// marks come once, by profile, rather than with every tab.
	async function searchOthers(): Promise<Elsewhere> {
		const tabs: TabItem[] = [];
		const closed: ClosedItem[] = [];
		if (!connected) return { tabs, closed, profiles: [], marks: {} };
		const marks = Object.fromEntries(
			others().flatMap((p): [string, Mark][] => (markOf(p.profile) ? [[p.profile, markOf(p.profile)!]] : [])),
		);
		const profiles = shared.values.searchProfiles
			? others()
					.filter((p) => p.windows > 0)
					.map(
						(p): ProfileSwitchItem => ({
							profileSwitch: true,
							profile: p.profile,
							title: nameOf(p.profile),
							subtitle: "Switch to this profile",
						}),
					)
			: [];
		if (!shared.values.searchAll) return { tabs, closed, profiles, marks };
		for (const answer of await ask({ kind: "tabs" })) {
			const origin = { profile: answer.from, profileName: nameOf(answer.from) };
			for (const t of Array.isArray(answer.tabs) ? answer.tabs : []) {
				const tab = cleanTab(t);
				if (tab) tabs.push({ ...tab, ...origin });
			}
			for (const t of Array.isArray(answer.closed) ? answer.closed : []) {
				const tab = cleanClosed(t);
				if (tab) closed.push({ ...tab, ...origin });
			}
		}
		return { tabs, closed, profiles, marks };
	}

	// Brings another profile forward, as the shortcut does.
	async function switchTo(to: string) {
		post(to, { kind: "focus", frame: await currentFrame() });
	}

	async function activateIn(to: string, tabId: number, windowId: number) {
		post(to, { kind: "activate", tabId, windowId, frame: await currentFrame() });
	}

	async function restoreIn(to: string, sessionId: string | undefined) {
		post(to, { kind: "restore", sessionId, frame: await currentFrame() });
	}

	function closeIn(to: string, tabId: number): undefined {
		post(to, { kind: "close", tabId });
	}

	// --- moving links and tabs between profiles ---

	// The profile a URL belongs to, when that's another one. Links this
	// profile claims stay here, even when another claims them too.
	function owner(href: string) {
		if (!connected || !shared.values.route) return null;
		let url: URL;
		try {
			url = new URL(href);
		} catch {
			return null;
		}
		if (!/^https?:$/.test(url.protocol)) return null;
		if (local.claims.some((c) => covers(c, url))) return null;
		return others().find((p) => p.info?.claims?.some((c) => covers(c, url))) ?? null;
	}

	const siteOf = (href: string) => {
		try {
			return new URL(href).host;
		} catch {
			return "";
		}
	};

	async function openIn(to: string, url: string | undefined, { toast = false } = {}) {
		post(to, { kind: "open", url, toast, frame: await currentFrame() });
	}

	// A link or tab handed over from another profile: open it in this
	// profile's last window and bring that forward. A moved link says where
	// it came from, so it can be sent back.
	async function openHere(from: string, { url, frame, toast }: { url: string; frame?: Frame | null; toast?: boolean }) {
		// the new tab's first navigation can be reported before it's created
		arriving.set(url, Date.now() + EXEMPT_FOR);
		let win = await lastWindow();
		let tab: chrome.tabs.Tab;
		if (win) {
			tab = await api.tabs.create({ windowId: win.id, url, active: true });
		} else {
			const place: Frame = frame?.state === "normal" && shared.values.stack ? frame : {};
			const { left, top, width, height } = place;
			win = (await api.windows.create({ url, focused: true, left, top, width, height }))!;
			tab = win.tabs![0]!;
		}
		exempt.set(tab.id!, Date.now() + EXEMPT_FOR);
		if (toast)
			toastWhenLoaded(tab.id!, {
				text: `Opened here from ${nameOf(from)}`,
				action: `Open in ${nameOf(from)}`,
				mark: markOf(from),
				run: async () => {
					const now = await api.tabs.get(tab.id!).catch(() => null);
					// sent back for good: the other profile opens it without moving it again
					openIn(from, now?.url ?? url);
					api.tabs.remove(tab.id!).catch(() => {});
				},
			});
		await present(win, frame);
	}

	// A tab arriving at a site that belongs to another profile moves there. A
	// tab opened for the link closes; one that was already somewhere goes back.
	// Moving around within a site leaves the tab where it is, so a link sent
	// back from the other profile stays put.
	function onNavigate(tab: chrome.tabs.Tab, url: string) {
		const prev = tabUrls.get(tab.id!);
		tabUrls.set(tab.id!, url);
		if ((arriving.get(url) ?? 0) > Date.now()) {
			arriving.delete(url);
			exempt.set(tab.id!, Date.now() + EXEMPT_FOR);
		}
		if (tab.incognito || (exempt.get(tab.id!) ?? 0) > Date.now()) return;
		if (prev && siteOf(prev) === siteOf(url)) return;
		const to = owner(url);
		if (!to) return;
		const fresh = !prev || !/^https?:/.test(prev) || Date.now() - (createdAt.get(tab.id!) ?? 0) < FRESH_FOR;
		openIn(to.profile, url, { toast: true });
		if (fresh) api.tabs.remove(tab.id!).catch(() => {});
		else goBack(tab.id!, prev);
	}

	// Going back only works once the navigation has landed; before that
	// there's nothing to go back from. Failing that, reopen the page it left.
	async function goBack(tabId: number, prev: string | undefined) {
		exempt.set(tabId, Date.now() + EXEMPT_FOR);
		await loaded(tabId);
		try {
			await api.tabs.goBack(tabId);
		} catch {
			api.tabs.update(tabId, { url: prev }).catch(() => {});
		}
	}

	function loaded(tabId: number, timeout = 5000) {
		return new Promise<void>((resolve) => {
			const done = () => {
				api.tabs.onUpdated.removeListener(listener);
				clearTimeout(timer);
				resolve();
			};
			const listener = (id: number, change: chrome.tabs.OnUpdatedInfo) =>
				id === tabId && change.status === "complete" && done();
			const timer = setTimeout(done, timeout);
			api.tabs.onUpdated.addListener(listener);
		});
	}

	// --- the same page open in another profile ---

	// a find with no address finds nothing, not a tab without one
	async function findTab(href: string | undefined) {
		const want = pageKey(href);
		if (!want) return null;
		const tab = (await shareableTabs()).find((t) => pageKey(t.url) === want);
		return tab ? { id: tab.id, windowId: tab.windowId } : null;
	}

	// A tab just opened on a page another profile already has open offers to
	// go there instead.
	const dupeChecked = new Set<number>();
	async function checkDupe(tab: chrome.tabs.Tab) {
		const opened = createdAt.get(tab.id!);
		if (tab.incognito || !opened || Date.now() - opened > DUPE_CHECK_FOR || dupeChecked.has(tab.id!)) return;
		if (!connected || !shared.values.dupes || (exempt.get(tab.id!) ?? 0) > Date.now()) return;
		if (!/^https?:/.test(tab.url ?? "")) return;
		dupeChecked.add(tab.id!);
		const hit = (await ask({ kind: "find", url: tab.url })).find((a) => a.tab);
		if (!hit) return;
		toast(tab.id!, {
			text: `Already open in ${nameOf(hit.from)}`,
			action: "Go there",
			mark: markOf(hit.from),
			run: () => {
				api.tabs.remove(tab.id!).catch(() => {});
				activateIn(hit.from, hit.tab!.id, hit.tab!.windowId);
			},
		});
	}

	api.tabs.onCreated.addListener((tab) => {
		if (!port) return;
		createdAt.set(tab.id!, Date.now());
	});
	api.tabs.onUpdated.addListener((_tabId, change, tab) => {
		if (!port) return;
		if (change.url) onNavigate(tab, change.url);
		if (change.status === "complete") checkDupe(tab);
	});
	api.tabs.onRemoved.addListener((tabId) => {
		if (!port) return;
		for (const map of [exempt, tabUrls, createdAt]) map.delete(tabId);
		for (const [url, until] of arriving) if (until < Date.now()) arriving.delete(url);
		dupeChecked.delete(tabId);
	});
	// A prerendered page can take its tab's place under a new ID. It's still
	// the tab it was, with its history, so leaving the site goes back rather
	// than closing it as a tab opened for the link.
	api.tabs.onReplaced?.addListener((added, removed) => {
		if (!port) return;
		const move = <V>(map: Map<number, V>) => {
			if (map.has(removed)) map.set(added, map.get(removed)!);
			map.delete(removed);
		};
		move(exempt);
		move(tabUrls);
		move(createdAt);
		if (dupeChecked.delete(removed)) dupeChecked.add(added);
	});

	// --- notices on the page (content/index.ts) ---

	// mark is the profile the notice is about, drawn beside it
	function toast(tabId: number, { text, action, run, mark = null }: Toast) {
		const id = crypto.randomUUID();
		toastActions.set(id, run);
		setTimeout(() => toastActions.delete(id), TOAST_ACTION_FOR);
		api.tabs
			.sendMessage(tabId, { type: "toast", id, text, action, mark } satisfies PageMessage, { frameId: 0 })
			.catch(() => {});
	}

	function toastWhenLoaded(tabId: number, t: Toast) {
		let shown = false;
		const show = () => {
			if (shown) return;
			shown = true;
			api.tabs.onUpdated.removeListener(listener);
			toast(tabId, t);
		};
		const listener = (id: number, change: chrome.tabs.OnUpdatedInfo) =>
			id === tabId && change.status === "complete" && show();
		api.tabs.onUpdated.addListener(listener);
		// a page from the cache can finish before anyone's listening
		api.tabs.get(tabId).then(
			(tab) => tab.status === "complete" && tab.url !== "about:blank" && show(),
			() => {},
		);
		setTimeout(() => api.tabs.onUpdated.removeListener(listener), 15_000);
	}

	function onToastAction(id: string) {
		toastActions.get(id)?.();
		toastActions.delete(id);
	}

	// --- right-click: open a page or link in another profile ---

	// One rebuild at a time, or two would create the same items twice.
	let menus = Promise.resolve();
	function updateMenus() {
		menus = menus.then(rebuildMenus).catch(() => {});
	}

	async function rebuildMenus() {
		if (!api.contextMenus) return;
		await api.contextMenus.removeAll();
		if (!connected) return;
		const quiet = () => api.runtime.lastError;
		for (const p of others()) {
			const name = nameOf(p.profile);
			api.contextMenus.create(
				{ id: `page:${p.profile}`, title: `Move this tab to ${name}`, contexts: ["page"] },
				quiet,
			);
			api.contextMenus.create({ id: `link:${p.profile}`, title: `Open link in ${name}`, contexts: ["link"] }, quiet);
		}
	}

	function onMenu(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) {
		if (tab?.incognito) return; // nothing incognito goes to another profile
		const [what, to] = (info.menuItemId as string).split(":");
		if (what === "link") {
			openIn(to!, info.linkUrl);
		} else if (what === "page" && tab) {
			openIn(to!, tab.url, { toast: true });
			api.tabs.remove(tab.id!).catch(() => {});
		}
	}

	let menuListening = false;
	function listenToMenus() {
		if (menuListening || !api.contextMenus) return;
		menuListening = true;
		api.contextMenus.onClicked.addListener(onMenu);
	}
	listenToMenus();

	// --- settings and setup ---

	api.permissions.onAdded.addListener(() => {
		listenToMenus();
		start();
	});
	api.permissions.onRemoved.addListener(async () => {
		if (await granted()) return;
		enabled = false;
		teardown();
	});

	api.storage.onChanged.addListener((changes) => {
		if (!enabled) return;
		if (changes.profileMark) {
			local.mark = (changes.profileMark.newValue as Mark | undefined) ?? null;
			publishLabel();
			sendState(); // the other profiles show it too
		}
		if (!(changes.profileName || changes.profileClaims || changes.profileWhere || changes.setupDone)) return;
		if (changes.profileName) {
			local.name = (changes.profileName.newValue as string | undefined) ?? "";
			publishLabel();
		}
		if (changes.profileClaims) local.claims = strings(changes.profileClaims.newValue);
		if (changes.profileWhere) local.where = (changes.profileWhere.newValue as string | undefined) ?? "";
		if (changes.setupDone) local.done = (changes.setupDone.newValue as string | undefined) ?? "";
		sendState();
	});

	// What the settings popup and the setup page show.
	async function status(): Promise<ProfilesStatus> {
		return {
			granted: await granted(),
			connected,
			error: lastError,
			peers: peers.map((p) => ({
				profile: p.profile,
				name: nameOf(p.profile),
				mark: markOf(p.profile),
				windows: p.windows,
				self: p.profile === profile,
			})),
			name: local.name,
			placeholder: profile ? nameOf(profile) : "",
			claims: local.claims,
			done: local.done,
			shared: shared.values,
		};
	}

	async function setShared(values: Partial<SharedSettings>) {
		shared = { values: { ...shared.values, ...values }, at: Date.now() };
		await api.storage.local.set({ profileShared: shared });
		publishLabel(); // with search's numbers, or without
		sendState();
	}

	// The setup page's "Connect" button, which also retries.
	async function reconnect() {
		retryIn = RETRY_FIRST;
		teardown();
		await start();
		// the helper answers with the list of profiles, or the port closes
		for (let i = 0; i < 20 && port && !connected; i++) await new Promise((r) => setTimeout(r, 100));
		return status();
	}

	return {
		init,
		status,
		setShared,
		reconnect,
		switchTo,
		searchOthers,
		activateIn,
		restoreIn,
		closeIn,
		onToastAction,
	};
}

// --- what other profiles say of themselves ---
//
// Any process on the computer can join the helper, and what a profile says
// of itself reaches every other as it was sent. A field of the wrong type
// would throw in a listener here (owner() runs on every navigation) or in a
// page drawing a mark, so only what's the right type is kept.

export function cleanInfo(info: unknown): PeerInfo | undefined {
	if (!isRecord(info)) return undefined;
	const { name, mark, claims, where, done, shared } = info;
	return {
		...(typeof name === "string" && { name }),
		mark: cleanMark(mark),
		claims: strings(claims),
		...(typeof where === "string" && { where }),
		...(typeof done === "string" && { done }),
		...(isRecord(shared) &&
			typeof shared.at === "number" &&
			isRecord(shared.values) && {
				shared: {
					at: shared.at,
					values: Object.fromEntries(Object.entries(shared.values).filter(([, v]) => typeof v === "boolean")),
				},
			}),
	};
}

// A mark needs its color; the icon's path comes from this copy's icons (markOf).
function cleanMark(mark: unknown): Mark | null {
	if (!isRecord(mark) || typeof mark.color !== "string") return null;
	const { icon, glyph, color, style } = mark;
	return {
		color,
		...(typeof icon === "string" && { icon }),
		...(typeof glyph === "string" && { glyph }),
		...((style === "solid" || style === "clear") && { style }),
	};
}

// The strings in a list, or none when it isn't one.
export const strings = (list: unknown): string[] =>
	Array.isArray(list) ? list.filter((s): s is string => typeof s === "string") : [];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// Another profile's tabs, for search here: its rows are drawn and ranked by
// their title and address, which throw on anything but a string, so a row
// keeps only fields of the right type, and one without an id is dropped.
export function cleanTab(tab: unknown): TabItem | null {
	if (!isRecord(tab) || typeof tab.id !== "number" || typeof tab.windowId !== "number") return null;
	return {
		id: tab.id,
		windowId: tab.windowId,
		...text(tab),
		icon: imageOf(tab.icon),
		audible: tab.audible === true,
		call: tab.call === true,
		thumb: null,
	};
}

export function cleanClosed(tab: unknown): ClosedItem | null {
	if (!isRecord(tab)) return null;
	return {
		closed: true,
		...(typeof tab.sessionId === "string" && { sessionId: tab.sessionId }),
		...text(tab),
		icon: imageOf(tab.icon),
	};
}

const text = (tab: Record<string, unknown>) => ({
	...(typeof tab.title === "string" && { title: tab.title }),
	...(typeof tab.url === "string" && { url: tab.url }),
});

// Icons arrive as data URLs; anything else isn't one.
const imageOf = (icon: unknown): string | null =>
	typeof icon === "string" && icon.startsWith("data:image/") ? icon : null;
