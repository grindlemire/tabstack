// Everything tabstack does across this browser's profiles: switching between
// them, searching their tabs, moving links to the profile they belong to, and
// keeping their windows stacked.
//
// Each profile runs its own copy of tabstack, and extensions can't reach
// across profiles, so every copy connects to a native helper (cmd/tabstack/) that
// passes messages between them. Few people install it, so none of this shows
// until they do: the permission it needs is optional, asked for from the
// setup page (setup.html), and without it this file does nothing at all.
// Chrome only; the Firefox build leaves it out.

globalThis.TabstackProfiles = (() => {
	const { api } = TabstackShared;
	const HOST = "dev.alethi.tabstack";
	const ASK_TIMEOUT = 300; // ms to wait for other profiles to answer
	const MAX_REPLY = 900_000; // bytes; the helper drops messages over 1 MB
	const EXEMPT_FOR = 10_000; // ms a tab opened from another profile isn't moved again
	const FRESH_FOR = 3000; // ms; a tab this new when it navigates was opened for that link
	const DUPE_CHECK_FOR = 10_000; // ms after opening that a tab is checked against other profiles
	const TOAST_ACTION_FOR = 30_000;
	const BOUNDS_DELAY = 250; // let a drag or resize settle before the others follow
	const RESTART_GAP = 60_000; // ms; restarting to connect is tried once, not in a loop

	// Settings every profile shares. Each keeps a copy, and the newest wins.
	const SHARED_DEFAULTS = { searchAll: true, searchProfiles: true, stack: true, dupes: true, route: true };

	let hooks = null; // { snapshot, recentlyClosed } from background.js
	let port = null;
	let enabled = false; // the helper's permission is granted
	let connected = false; // the helper answered
	let lastError = "";
	let profile = null; // this profile's ID; profiles are listed in the order of their IDs
	let peers = []; // every connected profile, this one included: { profile, windows, info }
	// this profile's name, its mark ({ glyph, color }), the links that belong
	// to it, and, from tabstack install, where it is and which install
	// run's setup page was finished
	let local = { name: "", mark: null, claims: [], where: "", done: "" };
	let shared = { values: SHARED_DEFAULTS, at: 0 };
	let started = null;

	const pending = new Map(); // request id -> { replies, expected, done }
	const exempt = new Map(); // tab id -> time until which it isn't moved
	const arriving = new Map(); // URL being opened from another profile -> until when
	const tabUrls = new Map(); // tab id -> the URL it was last at
	const createdAt = new Map(); // tab id -> when it opened
	const toastActions = new Map(); // toast id -> what its button does

	const granted = () => api.permissions.contains({ permissions: ["nativeMessaging"] });
	const others = () => peers.filter((p) => p.profile !== profile);

	// What a profile's called: the name it was given, or its place in the list.
	function nameOf(id) {
		const i = peers.findIndex((p) => p.profile === id);
		return peers[i]?.info?.name || (i >= 0 ? `Profile ${i + 1}` : "another profile");
	}

	// A profile's mark, with its icon's path filled in from this copy's
	// icons, so it's drawn the same here as there. Profiles share only the
	// mark itself, since what they share goes to every profile on any change.
	function markOf(id) {
		const mark = peers.find((p) => p.profile === id)?.info?.mark;
		if (!mark) return null;
		const path = mark.icon && globalThis.TabstackIcons?.[mark.icon];
		return { ...mark, ...(path && { path }) };
	}

	// --- connecting ---

	function init(h) {
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
				api.storage.local.get(["profileId", "profileShared", "profileWhere", "setupDone", "reopenSetup"]),
				api.storage.sync.get(["profileName", "profileMark", "profileClaims"]),
				api.tabs.query({}),
			]);
			// made from the time, so profiles are listed in the order they were set up
			profile = profileId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			if (!profileId) api.storage.local.set({ profileId: profile });
			if (profileShared) shared = { ...profileShared, values: { ...SHARED_DEFAULTS, ...profileShared.values } };
			local = {
				name: sync.profileName ?? "",
				mark: sync.profileMark ?? null,
				claims: sync.profileClaims ?? [],
				where: profileWhere ?? "",
				done: setupDone ?? "",
			};
			publishLabel();
			for (const tab of tabs) tabUrls.set(tab.id, tab.url);
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
		const { restartedAt = 0 } = await api.storage.local.get("restartedAt");
		if (Date.now() - restartedAt < RESTART_GAP) {
			lastError = "Chrome hasn't let tabstack reach the helper yet. Reload tabstack on chrome://extensions";
			return;
		}
		// the setup page left its own address, with what install told it
		const { setupUrl } = await api.storage.local.get("setupUrl");
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
			lastError = api.runtime.lastError?.message ?? "the helper stopped";
			if (port !== p) return;
			port = null;
			connected = false;
			peers = [];
			updateMenus();
			publishLabel();
		});
		sendState();
	}

	function disconnect() {
		port?.disconnect();
		port = null;
		connected = false;
		peers = [];
		lastError = "";
	}

	// What this profile shows of itself: its name over search (ui.js), and
	// its mark as the toolbar icon (background.js). It's kept in storage, so
	// search has it the moment it opens. A profile with no name yet goes by
	// its place in the list, once the helper has sent the list. A mark's icon
	// goes with it, so pages needn't load every icon to show one.
	let label;
	function publishLabel() {
		const name = local.name || (connected ? nameOf(profile) : "");
		const path = local.mark?.icon && globalThis.TabstackIcons?.[local.mark.icon];
		const mark = local.mark && { ...local.mark, ...(path && { path }) };
		const next = enabled && (name || mark) ? { name, mark } : null;
		if (JSON.stringify(next) === JSON.stringify(label)) return;
		label = next;
		if (next) api.storage.local.set({ profileLabel: next });
		else api.storage.local.remove("profileLabel");
	}

	async function sendState() {
		if (!port) return;
		const windows = await api.windows.getAll({ windowTypes: ["normal"] });
		port?.postMessage({
			type: "state",
			profile,
			windows: windows.length,
			// where tells tabstack install which of the browser's profiles this is
			info: { name: local.name, mark: local.mark, claims: local.claims, where: local.where, done: local.done, shared },
		});
	}

	function onMessage(msg) {
		if (msg.type === "peers") {
			connected = true;
			lastError = "";
			peers = msg.peers;
			for (const p of peers) {
				const theirs = p.info?.shared;
				if (theirs?.at > shared.at) {
					shared = { ...theirs, values: { ...SHARED_DEFAULTS, ...theirs.values } };
					api.storage.local.set({ profileShared: shared });
				}
			}
			updateMenus();
			publishLabel();
		} else if (msg.type === "msg") {
			onBody(msg.from, msg.body ?? {});
		} else if (msg.type === "reconnect") {
			// a new helper is installed; connecting again starts it
			reconnect();
		}
	}

	// --- talking to other profiles ---

	function post(to, body) {
		port?.postMessage({ type: "send", to, body });
	}

	// Asks one profile, or every other one ("*"), and settles with what comes
	// back in time: one answer (or null), or a list of them.
	function ask(to, body, timeout = ASK_TIMEOUT) {
		const all = to === "*";
		const expected = all ? others().length : 1;
		if (!connected || !expected) return Promise.resolve(all ? [] : null);
		const rid = crypto.randomUUID();
		return new Promise((resolve) => {
			const entry = {
				replies: [],
				expected,
				done() {
					clearTimeout(timer);
					pending.delete(rid);
					resolve(all ? entry.replies : (entry.replies[0] ?? null));
				},
			};
			const timer = setTimeout(entry.done, timeout);
			pending.set(rid, entry);
			post(to, { ...body, rid });
		});
	}

	function reply(to, rid, body) {
		post(to, { ...body, kind: "reply", rid });
	}

	async function onBody(from, body) {
		if (from.startsWith("cli")) return fromCommandLine(from, body);
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
				const win = await lastWindow();
				if (win) await present(win, body.frame);
				return;
			}
			case "activate":
				await api.tabs.update(body.tabId, { active: true }).catch(() => {});
				await present(await api.windows.get(body.windowId).catch(() => null), body.frame);
				return;
			case "restore": {
				const session = await api.sessions.restore(body.sessionId).catch(() => null);
				const windowId = session?.tab?.windowId ?? session?.window?.id;
				if (windowId != null) await present(await api.windows.get(windowId), body.frame);
				return;
			}
			case "close":
				api.tabs.remove(body.tabId).catch(() => {});
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
	async function fromCommandLine(from, body) {
		switch (body.kind) {
			case "tabs": {
				// every tab, most recently used first, without icons
				const tabs = await api.tabs.query({});
				tabs.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
				reply(from, body.rid, {
					tabs: tabs.map((t) => ({ id: t.id, windowId: t.windowId, title: t.title, url: t.url, lastAccessed: t.lastAccessed })),
				});
				return;
			}
			case "focus": {
				let win = await lastWindow();
				if (body.tabId != null) {
					const tab = await api.tabs.update(body.tabId, { active: true }).catch(() => null);
					if (!tab) return reply(from, body.rid, { error: `there's no tab ${body.tabId} here` });
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
				disconnect();
				updateMenus();
				return;
			case "rename":
				await api.storage.sync.set({ profileName: body.name ?? "" });
				return;
			case "links":
				await api.storage.sync.set({ profileClaims: body.links ?? [] });
				return;
			case "reset":
				await api.storage.sync.set({ profileName: body.name ?? "", profileClaims: [] });
				await reconnect();
				return;
		}
	}

	// --- windows ---

	// This profile's most recent window: the one that comes forward.
	function lastWindow() {
		return api.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
	}

	// Where the window being left is, so the next one can take its place.
	async function currentFrame() {
		const win = await lastWindow();
		if (!win) return null;
		const { state, left, top, width, height } = win;
		return { state, left, top, width, height };
	}

	// Brings a window forward, in the place of the one being left when the
	// windows are kept stacked.
	async function present(win, frame) {
		if (!win) return;
		if (frame && shared.values.stack) {
			if (frame.state === "normal") {
				// a minimized or maximized window won't take a size
				if (win.state !== "normal") await api.windows.update(win.id, { state: "normal" });
				const { left, top, width, height } = frame;
				await api.windows.update(win.id, { left, top, width, height, focused: true });
				return;
			}
			if (frame.state === "maximized" || frame.state === "fullscreen") {
				await api.windows.update(win.id, { state: frame.state, focused: true });
				return;
			}
		}
		if (win.state === "minimized") await api.windows.update(win.id, { state: "normal" });
		await api.windows.update(win.id, { focused: true });
	}

	// Another profile's window moved or resized: move this profile's to match,
	// without bringing it forward.
	async function follow(frame) {
		if (!shared.values.stack || frame?.state !== "normal") return;
		const win = await lastWindow();
		if (win?.state !== "normal") return;
		const { left, top, width, height } = frame;
		await api.windows.update(win.id, { left, top, width, height }).catch(() => {});
	}

	let boundsTimer = 0;
	api.windows.onBoundsChanged?.addListener((win) => {
		// only the window in front leads; the others moving to match don't
		if (!win.focused || !connected || !shared.values.stack) return;
		clearTimeout(boundsTimer);
		boundsTimer = setTimeout(async () => post("*", { kind: "bounds", frame: await currentFrame() }), BOUNDS_DELAY);
	});

	api.windows.onCreated.addListener(() => sendState());
	api.windows.onRemoved.addListener(() => sendState());

	// Hands the turn to the next profile with a window open, or the previous
	// one, in the order profiles are listed.
	async function cycle(dir) {
		const ring = peers.filter((p) => p.windows > 0 || p.profile === profile);
		const i = ring.findIndex((p) => p.profile === profile);
		if (i < 0 || ring.length < 2) return;
		const to = ring[(i + dir + ring.length) % ring.length];
		post(to.profile, { kind: "focus", frame: await currentFrame() });
	}

	api.commands.onCommand.addListener((command) => {
		if (command === "profile-next") cycle(1);
		else if (command === "profile-prev") cycle(-1);
	});

	// --- search ---

	// This profile's tabs, for another profile's search. Icons go first when
	// the answer is too big to pass on, then the least recent tabs.
	async function tabsForSearch() {
		if (!hooks) return { tabs: [], closed: [] };
		const [tabs, closed] = await Promise.all([hooks.snapshot(null, { forSearch: true }), hooks.recentlyClosed()]);
		let answer = { tabs, closed };
		const size = () => JSON.stringify(answer).length;
		if (size() > MAX_REPLY) {
			const bare = (t) => ({ ...t, icon: null });
			answer = { tabs: tabs.map(bare), closed: closed.map(bare) };
		}
		while (size() > MAX_REPLY && answer.tabs.length) answer.tabs.length = Math.floor(answer.tabs.length * 0.8);
		return answer;
	}

	// Every other profile's tabs, labeled with the profile they're in, and
	// the profiles themselves, so typing one's name switches to it. Their
	// marks come once, by profile, rather than with every tab.
	async function searchOthers() {
		const tabs = [];
		const closed = [];
		if (!connected) return { tabs, closed, profiles: [], marks: {} };
		const marks = Object.fromEntries(others().flatMap((p) => (markOf(p.profile) ? [[p.profile, markOf(p.profile)]] : [])));
		const profiles = shared.values.searchProfiles
			? others()
					.filter((p) => p.windows > 0)
					.map((p) => ({ profileSwitch: true, profile: p.profile, title: nameOf(p.profile), subtitle: "Switch to this profile" }))
			: [];
		if (!shared.values.searchAll) return { tabs, closed, profiles, marks };
		for (const answer of await ask("*", { kind: "tabs" })) {
			const label = { profile: answer.from, profileName: nameOf(answer.from) };
			tabs.push(...(answer.tabs ?? []).map((t) => ({ ...t, ...label })));
			closed.push(...(answer.closed ?? []).map((t) => ({ ...t, ...label })));
		}
		return { tabs, closed, profiles, marks };
	}

	// Brings another profile forward, as the shortcut does.
	async function switchTo(to) {
		post(to, { kind: "focus", frame: await currentFrame() });
	}

	async function activateIn(to, tabId, windowId) {
		post(to, { kind: "activate", tabId, windowId, frame: await currentFrame() });
	}

	async function restoreIn(to, sessionId) {
		post(to, { kind: "restore", sessionId, frame: await currentFrame() });
	}

	function closeIn(to, tabId) {
		post(to, { kind: "close", tabId });
	}

	// --- moving links and tabs between profiles ---

	// Whether a pattern from "Links that open in this profile" covers a URL.
	// "corp.com" is that site (and www.corp.com), "*.corp.com" adds its
	// subdomains, and a path covers everything under it: "github.com/acme" is
	// /acme and /acme/…. A * matches anything, so "github.com/g*" covers every
	// path starting with /g, and "github.com/*/issues" every repo's issues.
	function covers(pattern, url) {
		const [site, ...rest] = pattern.trim().toLowerCase().replace(/^https?:\/\//, "").split("/");
		if (!site) return false;
		const glob = (text, star) => text.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(star);
		const sitePattern = site.startsWith("*.")
			? `(?:[^/]*\\.)?${glob(site.slice(2), "[^/]*")}`
			: `(?:www\\.)?${glob(site, "[^/]*")}`;
		// a port in the pattern ("localhost:3000") has to match too
		const host = (site.includes(":") ? url.host : url.hostname).toLowerCase();
		if (!new RegExp(`^${sitePattern}$`).test(host)) return false;
		const path = rest.join("/").replace(/\/\*?$/, "").replace(/\/+$/, "");
		if (!path) return true;
		return new RegExp(`^/${glob(path, ".*")}(?:/.*)?$`).test(url.pathname.toLowerCase());
	}

	// The profile a URL belongs to, when that's another one. Links this
	// profile claims stay here, even when another claims them too.
	function owner(href) {
		if (!connected || !shared.values.route) return null;
		let url;
		try {
			url = new URL(href);
		} catch {
			return null;
		}
		if (!/^https?:$/.test(url.protocol)) return null;
		if (local.claims.some((c) => covers(c, url))) return null;
		return others().find((p) => p.info?.claims?.some((c) => covers(c, url))) ?? null;
	}

	const siteOf = (href) => {
		try {
			return new URL(href).host;
		} catch {
			return "";
		}
	};

	async function openIn(to, url, { toast = false } = {}) {
		post(to, { kind: "open", url, toast, frame: await currentFrame() });
	}

	// A link or tab handed over from another profile: open it in this
	// profile's last window and bring that forward. A moved link says where
	// it came from, so it can be sent back.
	async function openHere(from, { url, frame, toast }) {
		// the new tab's first navigation can be reported before it's created
		arriving.set(url, Date.now() + EXEMPT_FOR);
		let win = await lastWindow();
		let tab;
		if (win) {
			tab = await api.tabs.create({ windowId: win.id, url, active: true });
		} else {
			const place = frame?.state === "normal" && shared.values.stack ? frame : {};
			const { left, top, width, height } = place;
			win = await api.windows.create({ url, focused: true, left, top, width, height });
			tab = win.tabs[0];
		}
		exempt.set(tab.id, Date.now() + EXEMPT_FOR);
		if (toast) toastWhenLoaded(tab.id, {
			text: `Opened here from ${nameOf(from)}`,
			action: `Open in ${nameOf(from)}`,
			mark: markOf(from),
			run: async () => {
				const now = await api.tabs.get(tab.id).catch(() => null);
				// sent back for good: the other profile opens it without moving it again
				openIn(from, now?.url ?? url);
				api.tabs.remove(tab.id).catch(() => {});
			},
		});
		await present(win, frame);
	}

	// A tab arriving at a site that belongs to another profile moves there. A
	// tab opened for the link closes; one that was already somewhere goes back.
	// Moving around within a site leaves the tab where it is, so a link sent
	// back from the other profile stays put.
	function onNavigate(tab, url) {
		const prev = tabUrls.get(tab.id);
		tabUrls.set(tab.id, url);
		if ((arriving.get(url) ?? 0) > Date.now()) {
			arriving.delete(url);
			exempt.set(tab.id, Date.now() + EXEMPT_FOR);
		}
		if (tab.incognito || (exempt.get(tab.id) ?? 0) > Date.now()) return;
		if (prev && siteOf(prev) === siteOf(url)) return;
		const to = owner(url);
		if (!to) return;
		const fresh = !prev || !/^https?:/.test(prev) || Date.now() - (createdAt.get(tab.id) ?? 0) < FRESH_FOR;
		openIn(to.profile, url, { toast: true });
		if (fresh) api.tabs.remove(tab.id).catch(() => {});
		else goBack(tab.id, prev);
	}

	// Going back only works once the navigation has landed; before that
	// there's nothing to go back from. Failing that, reopen the page it left.
	async function goBack(tabId, prev) {
		exempt.set(tabId, Date.now() + EXEMPT_FOR);
		await loaded(tabId);
		try {
			await api.tabs.goBack(tabId);
		} catch {
			api.tabs.update(tabId, { url: prev }).catch(() => {});
		}
	}

	function loaded(tabId, timeout = 5000) {
		return new Promise((resolve) => {
			const done = () => {
				api.tabs.onUpdated.removeListener(listener);
				clearTimeout(timer);
				resolve();
			};
			const listener = (id, change) => id === tabId && change.status === "complete" && done();
			const timer = setTimeout(done, timeout);
			api.tabs.onUpdated.addListener(listener);
		});
	}

	// --- the same page open in another profile ---

	const normalize = (href) => {
		try {
			const url = new URL(href);
			url.hash = "";
			return url.href.replace(/\/$/, "");
		} catch {
			return href;
		}
	};

	async function findTab(href) {
		const want = normalize(href);
		const tab = (await api.tabs.query({})).find((t) => normalize(t.url) === want);
		return tab ? { id: tab.id, windowId: tab.windowId } : null;
	}

	// A tab just opened on a page another profile already has open offers to
	// go there instead.
	const dupeChecked = new Set();
	async function checkDupe(tab) {
		const opened = createdAt.get(tab.id);
		if (!opened || Date.now() - opened > DUPE_CHECK_FOR || dupeChecked.has(tab.id)) return;
		if (!connected || !shared.values.dupes || (exempt.get(tab.id) ?? 0) > Date.now()) return;
		if (!/^https?:/.test(tab.url ?? "")) return;
		dupeChecked.add(tab.id);
		const hit = (await ask("*", { kind: "find", url: tab.url })).find((a) => a.tab);
		if (!hit) return;
		toast(tab.id, {
			text: `Already open in ${nameOf(hit.from)}`,
			action: "Go there",
			mark: markOf(hit.from),
			run: () => {
				api.tabs.remove(tab.id).catch(() => {});
				activateIn(hit.from, hit.tab.id, hit.tab.windowId);
			},
		});
	}

	api.tabs.onCreated.addListener((tab) => port && createdAt.set(tab.id, Date.now()));
	api.tabs.onUpdated.addListener((tabId, change, tab) => {
		if (!connected) return;
		if (change.url) onNavigate(tab, change.url);
		if (change.status === "complete") checkDupe(tab);
	});
	api.tabs.onRemoved.addListener((tabId) => {
		for (const map of [exempt, tabUrls, createdAt]) map.delete(tabId);
		for (const [url, until] of arriving) if (until < Date.now()) arriving.delete(url);
		dupeChecked.delete(tabId);
	});

	// --- notices on the page (content.js) ---

	// mark is the profile the notice is about, drawn beside it
	function toast(tabId, { text, action, run, mark = null }) {
		const id = crypto.randomUUID();
		toastActions.set(id, run);
		setTimeout(() => toastActions.delete(id), TOAST_ACTION_FOR);
		api.tabs.sendMessage(tabId, { type: "toast", id, text, action, mark }, { frameId: 0 }).catch(() => {});
	}

	function toastWhenLoaded(tabId, t) {
		let shown = false;
		const show = () => {
			if (shown) return;
			shown = true;
			api.tabs.onUpdated.removeListener(listener);
			toast(tabId, t);
		};
		const listener = (id, change) => id === tabId && change.status === "complete" && show();
		api.tabs.onUpdated.addListener(listener);
		// a page from the cache can finish before anyone's listening
		api.tabs.get(tabId).then((tab) => tab.status === "complete" && tab.url !== "about:blank" && show(), () => {});
		setTimeout(() => api.tabs.onUpdated.removeListener(listener), 15_000);
	}

	function onToastAction(id) {
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
			api.contextMenus.create({ id: `page:${p.profile}`, title: `Move this tab to ${name}`, contexts: ["page"] }, quiet);
			api.contextMenus.create({ id: `link:${p.profile}`, title: `Open link in ${name}`, contexts: ["link"] }, quiet);
		}
	}

	function onMenu(info, tab) {
		const [what, to] = info.menuItemId.split(":");
		if (what === "link") {
			openIn(to, info.linkUrl);
		} else if (what === "page" && tab) {
			openIn(to, tab.url, { toast: true });
			api.tabs.remove(tab.id).catch(() => {});
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
		disconnect();
		publishLabel();
	});

	api.storage.onChanged.addListener((changes) => {
		if (changes.profileMark) {
			local.mark = changes.profileMark.newValue ?? null;
			publishLabel();
			sendState(); // the other profiles show it too
		}
		if (!(changes.profileName || changes.profileClaims || changes.profileWhere || changes.setupDone)) return;
		if (changes.profileName) {
			local.name = changes.profileName.newValue ?? "";
			publishLabel();
		}
		if (changes.profileClaims) local.claims = changes.profileClaims.newValue ?? [];
		if (changes.profileWhere) local.where = changes.profileWhere.newValue ?? "";
		if (changes.setupDone) local.done = changes.setupDone.newValue ?? "";
		sendState();
	});

	// What the settings popup and the setup page show.
	async function status() {
		return {
			granted: await granted(),
			connected,
			error: lastError,
			peers: peers.map((p) => ({ name: nameOf(p.profile), windows: p.windows, self: p.profile === profile })),
			name: local.name,
			placeholder: profile ? nameOf(profile) : "",
			claims: local.claims,
			done: local.done,
			shared: shared.values,
		};
	}

	async function setShared(values) {
		shared = { values: { ...shared.values, ...values }, at: Date.now() };
		await api.storage.local.set({ profileShared: shared });
		sendState();
	}

	// The setup page's "Connect" button, which also retries.
	async function reconnect() {
		disconnect();
		await start();
		// the helper answers with the list of profiles, or the port closes
		for (let i = 0; i < 20 && port && !connected; i++) await new Promise((r) => setTimeout(r, 100));
		return status();
	}

	return { init, status, setShared, reconnect, cycle, switchTo, searchOthers, activateIn, restoreIn, closeIn, onToastAction };
})();
