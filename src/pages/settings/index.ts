// Toolbar popup: shortcuts and options.

import { api, isFirefox, isMac } from "../../shared/api";
import { firstGlyph, markElement } from "../../shared/marks";
import { type Mark, type PeerRow, type ProfilesStatus, type SharedSettings, sendMessage } from "../../shared/messages";
import { DEFAULTS, loadSettings } from "../../shared/settings";
import { format, fromEvent, type Shortcut } from "../../shared/shortcuts";
import { $, cssTime, keycaps } from "../page";
import { connectProfiles, linksEditor, nameEditor, profilesStatus, turnOff } from "../profile";
import { firefoxShortcut, prettyCommand } from "./commands";
import { initPicker } from "./picker";

// Firefox lets an extension rebind its own commands. Chrome only allows it on
// its shortcuts page.
const canRebindCommands = typeof api.commands.update === "function";

// --- motion: what comes and goes in the popup (the animations are in settings.html) ---

const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// Plays an entrance on an element from the start, even one it played before.
// It's taken off once it ends, so showing the element again doesn't replay it.
function play(el: HTMLElement, name: string) {
	el.classList.remove("from-right", "from-left", "appear", name);
	void el.offsetWidth; // restarts the animation
	el.classList.add(name);
	el.addEventListener("animationend", () => el.classList.remove(name), { once: true });
}

// Once the popup's been moved around in, its opening rise is done, so it
// doesn't replay with every tab.
const settle = () => document.body.classList.add("settled");

const fading = new Map<HTMLElement, ReturnType<typeof setTimeout>>(); // element fading out -> the timer that hides it

function reveal(el: HTMLElement) {
	if (fading.has(el)) {
		// called back mid-fade: it comes back in from where it is
		clearTimeout(fading.get(el));
		fading.delete(el);
		el.classList.remove("leaving");
		el.hidden = true;
	}
	if (!el.hidden) return;
	el.hidden = false;
	play(el, "appear");
}

// Fades out, then hides, as the fade (.leaving, --leave) ends.
function conceal(el: HTMLElement) {
	if (el.hidden || fading.has(el)) return;
	if (calm()) {
		el.hidden = true;
		return;
	}
	el.classList.remove("appear");
	el.classList.add("leaving");
	fading.set(
		el,
		setTimeout(() => {
			fading.delete(el);
			el.hidden = true;
			el.classList.remove("leaving");
		}, cssTime("--leave")),
	);
}

function note(text: string, error = false) {
	const was = $("note").textContent;
	$("note").textContent = text;
	$("note").classList.toggle("error", error);
	if (text && text !== was) play($("note"), "appear");
}

const KEY_STAGGER = 45; // ms between the keys of a changed shortcut popping in

// Each key of a shortcut gets its own keycap. A shortcut that just changed
// pops in a key at a time. With none, it's "Not set", in red, or "Off" for one
// that was turned off on purpose.
function showKeys(el: HTMLElement, shortcut: string, { off = false } = {}) {
	const changed = el.dataset.shown !== undefined && el.dataset.shown !== shortcut;
	el.dataset.shown = shortcut;
	el.classList.toggle("missing", !shortcut && !off);
	el.classList.toggle("unset", !shortcut && off);
	if (!shortcut) {
		el.textContent = off ? "Off" : "Not set";
		return;
	}
	el.replaceChildren(
		...keycaps(shortcut).map((key, i) => {
			const kbd = Object.assign(document.createElement("kbd"), { textContent: key });
			if (changed) {
				kbd.classList.add("pop");
				kbd.style.animationDelay = `${i * KEY_STAGGER}ms`;
			}
			return kbd;
		}),
	);
}

// --- recording a shortcut ---

let recording: { kbd: HTMLElement; save: (s: Shortcut) => Promise<unknown> } | null = null;

function record(kbd: HTMLElement, save: (s: Shortcut) => Promise<unknown>) {
	stopRecording();
	kbd.textContent = "Press keys…";
	kbd.classList.add("recording");
	note("Press Esc to cancel.");
	recording = { kbd, save };
}

function stopRecording() {
	if (!recording) return;
	recording.kbd.classList.remove("recording");
	recording = null;
	note("");
}

addEventListener("keydown", async (e) => {
	if (!recording) return;
	e.preventDefault();
	if (e.key === "Escape") {
		stopRecording();
		refresh();
		return;
	}
	const shortcut = fromEvent(e);
	if (!shortcut) return; // a lone modifier; wait for the key
	if (!shortcut.meta && !shortcut.ctrl && !shortcut.alt) {
		note(`Include ${isMac ? "⌘, ⌃ or ⌥" : "Ctrl or Alt"} so it doesn't fire while you type.`, true);
		if (!calm()) play(recording.kbd, "shake");
		return;
	}
	const { save } = recording;
	stopRecording();
	try {
		await save(shortcut);
	} catch (err) {
		note((err as Error).message, true);
	}
	refresh();
});

// The switch and search shortcuts are the browser's commands.
function bindCommand(name: string, id: string) {
	$(`${id}-change`).addEventListener("click", () => {
		if (!canRebindCommands) {
			api.tabs.create({ url: "chrome://extensions/shortcuts" });
			window.close();
			return;
		}
		record($(`${id}-key`), async (s) => {
			const shortcut = firefoxShortcut(s);
			if (!shortcut) throw new Error("Firefox only allows letters, digits, F-keys, arrows, and a few others here.");
			// canRebindCommands: commands.update is there
			await api.commands.update!({ name, shortcut });
			sendMessage({ type: "checkShortcut" });
		});
	});
	if (!canRebindCommands) $(`${id}-change`).title = "Opens Chrome's keyboard shortcuts page";
}
bindCommand("switch", "switch");
bindCommand("search", "find");

// Off is searchOnPage: false, beside the shortcut (settings.ts).
$("search-change").addEventListener("click", () =>
	record($("search-key"), (s) => api.storage.sync.set({ searchShortcut: s, searchOnPage: true })),
);
$("search-reset").addEventListener("click", async () => {
	await api.storage.sync.remove(["searchShortcut", "searchOnPage"]);
	refresh();
});
$("search-clear").addEventListener("click", async () => {
	stopRecording();
	await api.storage.sync.set({ searchOnPage: false });
	refresh();
});

for (const [id, key] of [
	["auto-switch", "autoSwitch"],
	["include-closed", "includeClosed"],
	["this-window-only", "thisWindowOnly"],
	["show-timings", "showTimings"],
] as const) {
	$(id).addEventListener("change", (e) => api.storage.sync.set({ [key]: (e.target as HTMLInputElement).checked }));
}

async function refresh() {
	const s = await loadSettings();
	const commands = await api.commands.getAll();
	const switchKey = commands.find((c) => c.name === "switch")?.shortcut;
	showKeys($("switch-key"), prettyCommand(switchKey));
	showKeys($("find-key"), prettyCommand(commands.find((c) => c.name === "search")?.shortcut));
	if (!switchKey && !recording && !$("note").textContent) {
		note("Another extension or the browser already uses this shortcut. Choose a different one.", true);
	}
	showKeys($("search-key"), s.searchOnPage ? format(s.searchShortcut) : "", { off: true });
	$("search-reset").hidden =
		s.searchOnPage && JSON.stringify(s.searchShortcut) === JSON.stringify(DEFAULTS.searchShortcut);
	$("search-clear").hidden = !s.searchOnPage;
	$<HTMLInputElement>("auto-switch").checked = s.autoSwitch;
	$<HTMLInputElement>("include-closed").checked = s.includeClosed;
	$<HTMLInputElement>("this-window-only").checked = s.thisWindowOnly;
	$<HTMLInputElement>("show-timings").checked = s.showTimings;
}

// --- profiles (the background's profiles module) ---
//
// Shown only once the profile helper is set up. Until then there's one small
// offer to set it up, which stays dismissed once closed.

const openSetup = () => {
	api.tabs.create({ url: "setup.html" });
	window.close();
};

// With profile features on, they get a tab of their own beside the rest of
// the settings, and with another profile to switch to, the popup opens on
// Switch. Otherwise it opens on whichever settings tab was used last.
const TABS = ["switch", "general", "profiles"]; // left to right
let tabPicked = false;

const currentTab = () =>
	document.querySelector<HTMLElement>("[data-tab][aria-selected='true']")?.dataset.tab ?? "general";

function lastTab() {
	try {
		return localStorage.getItem("tab") === "profiles" ? "profiles" : "general";
	} catch {
		return "general";
	}
}

let resized: ReturnType<typeof setTimeout> | 0 = 0;

// Each tab is as tall as it needs to be. Chrome sizes the popup to the page,
// so easing the panel's height from one tab's to the other's (ease) grows or
// shrinks the popup smoothly, instead of in a jump.
function selectTab(name: string, { ease = false } = {}) {
	const panels = document.querySelector<HTMLElement>(".panels")!;
	const from = panels.offsetHeight;
	const tabs = [...document.querySelectorAll<HTMLElement>("[data-tab]")];
	for (const tab of tabs) tab.setAttribute("aria-selected", String(tab.dataset.tab === name));
	const shown = tabs.filter((tab) => !tab.hidden);
	$("tabs").style.setProperty("--n", String(shown.length));
	$("tabs").style.setProperty(
		"--at",
		String(
			Math.max(
				0,
				shown.findIndex((tab) => tab.dataset.tab === name),
			),
		),
	);
	for (const panel of TABS.map((id) => $(id))) {
		panel.classList.toggle("inactive", panel.id !== name);
		panel.inert = panel.id !== name;
	}
	if (name === "switch") focusSelf();
	clearTimeout(resized);
	panels.classList.remove("resizing");
	panels.style.height = "";
	const to = panels.offsetHeight;
	if (!ease || calm() || from === to) return;
	panels.style.height = `${from}px`;
	panels.classList.add("resizing");
	void panels.offsetHeight; // starts the transition from the old height
	panels.style.height = `${to}px`;
	resized = setTimeout(() => {
		panels.classList.remove("resizing");
		panels.style.height = "";
	}, cssTime("--resize"));
}

const shownTab = () => $(currentTab());

for (const tab of document.querySelectorAll<HTMLElement>("[data-tab]")) {
	tab.addEventListener("click", () => {
		// every tab button has a data-tab, as the selector says
		const name = tab.dataset.tab!;
		const from = currentTab();
		if (name === from) return;
		tabPicked = true;
		selectTab(name, { ease: true });
		settle();
		// in from the side it sits on
		play($(name), TABS.indexOf(name) > TABS.indexOf(from) ? "from-right" : "from-left");
		try {
			localStorage.setItem("tab", name);
		} catch {}
	});
}

// --- the connection, at the foot of the profile's card ---

const STATUS_POLL = 2000; // ms; other profiles connect, or the helper stops, while the popup's open
let granted: boolean | null = null; // whether profile features were on when last looked
let reconnecting = false;

// How this profile's connected, with Reconnect only when it isn't. A change
// of wording fades in.
function showStatus(status: ProfilesStatus) {
	const others = status.peers.filter((p) => !p.self);
	let text: string;
	let detail = "";
	if (!status.connected && /not found/.test(status.error)) {
		// uninstalled, or never registered with this browser
		text = "The profile helper isn't installed";
		detail = "Run tabstack install, then Reconnect.";
	} else if (!status.connected) {
		text = "Can't reach the profile helper";
		detail = status.error;
	} else if (!others.length) {
		text = "Only this profile so far";
		detail = "Set up tabstack in your other profiles too.";
	} else {
		// their names are on the Switch tab
		text = `Connected to ${others.length === 1 ? others[0]!.name : `${others.length} profiles`}`;
	}
	showPeers(status);
	$("profiles-dot").classList.toggle("ok", status.connected);
	$("profiles-retry").hidden = status.connected;
	if ($("profiles-status").textContent !== text && $("profiles-status").textContent)
		play($("profiles-status"), "appear");
	$("profiles-status").textContent = text;
	$("profiles-detail").textContent = detail;
}

// --- Switch: every connected profile, a click away ---
//
// In the order the shortcut steps through them, numbered so 1 to 9 pick
// them, and laid out as evenly as their number allows.

let peers: PeerRow[] = [];
let peersShown = "";

const switchable = () => peers.length > 1;

// Up to four across, in as few rows as that takes, with the rows as even as
// they'll go: five are three and two, seven four and three, nine three by three.
const MOST_ACROSS = 4;
const acrossFor = (n: number) => Math.ceil(n / Math.ceil(n / MOST_ACROSS));
const across = () => Number($("peers").dataset.across) || 1;

// Redrawn only when something changed, or every poll would lose the
// profile under the pointer, and the one picked with the keys.
function showPeers(status: ProfilesStatus | { connected: false }) {
	const next = status.connected ? status.peers : [];
	const key = JSON.stringify(next);
	if (key === peersShown) return;
	const had = switchable();
	const first = !peersShown; // the popup opening, which shouldn't ease from tab to tab
	const focused = (document.activeElement as HTMLElement | null)?.dataset.profile;
	peersShown = key;
	peers = next;
	const n = acrossFor(peers.length);
	$("peers").dataset.across = String(n);
	$("peers").style.setProperty("--across", String(n));
	$("peers").replaceChildren(...peers.map(peerTile));
	$("peers")
		.querySelector<HTMLElement>(`[data-profile="${CSS.escape(focused ?? "")}"]`)
		?.focus();

	// Switch comes and goes as other profiles connect and leave
	$("switch").hidden = document.querySelector<HTMLElement>("[data-tab='switch']")!.hidden = !switchable();
	if (switchable() === had) return;
	if (!switchable() && currentTab() === "switch") selectTab(lastTab(), { ease: !first });
	else if (switchable() && !tabPicked) selectTab("switch", { ease: !first });
	else selectTab(currentTab()); // the pill, for one more tab or one fewer
}

$("switch-note").textContent = `Press a number, or use the arrow keys and ${isMac ? "Return" : "Enter"}.`;

// This profile is shown but does nothing; another comes forward, as the
// shortcut brings it, or opens a window if it has none.
function peerTile(peer: PeerRow, i: number) {
	const tile = document.createElement("button");
	tile.className = `peer${peer.self ? " self" : ""}${peer.windows ? "" : " closed"}`;
	tile.dataset.profile = peer.profile;
	const mark = peer.mark
		? markElement(peer.mark, peer.mark.path)
		: Object.assign(document.createElement("span"), {
				className: "mark empty",
				textContent: firstGlyph(peer.name).toUpperCase(),
			});
	const note = peer.self ? "This profile" : peer.windows ? "" : "No window";
	tile.append(
		mark,
		Object.assign(document.createElement("span"), { className: "name", textContent: peer.name }),
		Object.assign(document.createElement("small"), { textContent: note }),
	);
	if (peer.self) {
		tile.setAttribute("aria-disabled", "true");
		tile.title = `${peer.name}, this profile`;
		return tile;
	}
	if (i < 9) tile.prepend(Object.assign(document.createElement("span"), { className: "num", textContent: i + 1 }));
	tile.title = `${peer.windows ? "Switch to" : "Open a window in"} ${peer.name}`;
	tile.addEventListener("click", () => switchProfile(peer));
	return tile;
}

async function switchProfile(peer: PeerRow) {
	await sendMessage({ type: "switchProfile", profile: peer.profile }).catch(() => {});
	window.close();
}

// The pick starts on the profile you're in, for the arrow keys to move from.
function focusSelf() {
	$("peers").querySelector<HTMLElement>(".self")?.focus({ preventScroll: true });
}

document.addEventListener("keydown", (e) => {
	if (currentTab() !== "switch" || document.body.classList.contains("picking")) return;
	if (e.metaKey || e.ctrlKey || e.altKey) return;
	if (/^[1-9]$/.test(e.key)) {
		const peer = peers[Number(e.key) - 1];
		if (!peer || peer.self) return;
		e.preventDefault();
		switchProfile(peer);
		return;
	}
	const steps: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -across(), ArrowDown: across() };
	const step = steps[e.key];
	if (!step) return;
	e.preventDefault();
	const tiles = [...$("peers").children] as HTMLElement[];
	const at = tiles.indexOf(document.activeElement as HTMLElement);
	tiles[at < 0 ? 0 : Math.min(Math.max(at + step, 0), tiles.length - 1)]?.focus();
});

$("profiles-retry").addEventListener("click", async () => {
	reconnecting = true;
	$("profiles-dot").classList.add("busy");
	$<HTMLButtonElement>("profiles-retry").disabled = true;
	$("profiles-status").textContent = "Reconnecting…";
	const status = await connectProfiles();
	reconnecting = false;
	$("profiles-dot").classList.remove("busy");
	$<HTMLButtonElement>("profiles-retry").disabled = false;
	if (status) showStatus(status);
});

setInterval(async () => {
	if (isFirefox || reconnecting) return;
	const status = await profilesStatus();
	if (!status) return;
	// turned on or off from elsewhere (setup page, the tabstack command): redraw it all
	if (status.granted !== granted) refreshProfiles();
	else if (status.granted) showStatus(status);
}, STATUS_POLL);

async function refreshProfiles() {
	if (isFirefox) return;
	const status = await profilesStatus();
	if (!status) return;
	const [{ profilesAdHidden }, { profileId }] = await Promise.all([
		api.storage.sync.get<{ profilesAdHidden?: boolean }>("profilesAdHidden"),
		api.storage.local.get<{ profileId?: string }>("profileId"),
	]);
	$("profiles-ad").hidden = status.granted || !!profilesAdHidden;
	// set up once and turned off since (here, or by tabstack uninstall)
	if (profileId) {
		$("profiles-ad-title").textContent = "Profile features are off";
		$("profiles-ad-text").textContent = "Turn them back on to switch, search and open links across your profiles.";
		$("profiles-learn").textContent = "Turn back on";
	}
	granted = status.granted;
	$("tabs").hidden = $("profiles").hidden = !status.granted;
	if (!status.granted) {
		showPeers({ connected: false });
		selectTab("general");
		return;
	}
	if (!tabPicked) selectTab(switchable() ? "switch" : lastTab());
	showStatus(status);

	profileName.show(status.name);
	$<HTMLInputElement>("profile-name").placeholder = status.placeholder;
	const { profileMark } = await api.storage.sync.get<{ profileMark?: Mark }>("profileMark");
	picker.show(profileMark ?? null);
	profileLinks.show(status.claims.join("\n"));
	for (const box of document.querySelectorAll<HTMLInputElement>("[data-shared]"))
		box.checked = !!status.shared[box.dataset.shared as keyof SharedSettings];
	$("claims-row").hidden = !status.shared.route;

	const commands = await api.commands.getAll();
	const keys = ["profile-prev", "profile-next"].map((n) => prettyCommand(commands.find((c) => c.name === n)?.shortcut));
	// ⌃⌘← and ⌃⌘→ show as ⌃⌘←→: the popup's too narrow for both in full
	const [prev, next] = keys;
	if (prev && next && prev.slice(0, -1) === next.slice(0, -1) && !prev.includes("+")) {
		showKeys($("profile-keys"), prev);
		$("profile-keys").append(Object.assign(document.createElement("kbd"), { textContent: next.slice(-1) }));
		$("profile-keys").classList.remove("unset");
	} else if (keys.some(Boolean)) {
		const groups = keys.filter(Boolean).map((k) => {
			const group = Object.assign(document.createElement("span"), { className: "keys" });
			showKeys(group, k);
			return group;
		});
		$("profile-keys").replaceChildren(...groups);
		$("profile-keys").classList.remove("unset");
	} else {
		$("profile-keys").textContent = "Not set";
		$("profile-keys").classList.add("unset");
	}
	// Chrome's "Activate the extension", which has no key until one's set
	const open = prettyCommand(commands.find((c) => c.name === "_execute_action")?.shortcut);
	if (open) showKeys($("open-key"), open);
	else $("open-key").textContent = "Not set";
	$("open-key").classList.toggle("unset", !open);
}

$("profiles-learn").addEventListener("click", openSetup);
$("profiles-ad-hide").addEventListener("click", () => {
	api.storage.sync.set({ profilesAdHidden: true });
	conceal($("profiles-ad"));
});
for (const id of ["profile-keys-change", "open-key-change"]) {
	$(id).addEventListener("click", () => {
		api.tabs.create({ url: "chrome://extensions/shortcuts" });
		window.close();
	});
}
$("profiles-off").addEventListener("click", async () => {
	await turnOff();
	await refreshProfiles();
	// back on General, which sits to the left
	settle();
	play($("general"), "from-left");
});

for (const box of document.querySelectorAll<HTMLInputElement>("[data-shared]")) {
	box.addEventListener("change", () => {
		sendMessage({
			type: "profilesShared",
			values: { [box.dataset.shared as keyof SharedSettings]: box.checked },
		});
		if (box.dataset.shared === "route") (box.checked ? reveal : conceal)($("claims-row"));
	});
}

// --- this profile's name, links and mark (the mark's picker is picker.ts) ---

// The name and links save a moment after each change, and say so.
const profileName = nameEditor($("profile-name"), () => play($("name-saved"), "flash"));
const profileLinks = linksEditor($("profile-claims"), () => play($("claims-saved"), "flash"));

$("profile-name").addEventListener("input", () => picker.nameChanged());
$("profile-name").addEventListener("keydown", (e) => {
	if (e.key === "Enter") (e.target as HTMLInputElement).blur();
});

// A page of its own over the settings slides in from the right, and going
// back slides the settings in from the left. A shorter page keeps the popup's
// size, so it doesn't shrink under the pointer.
function openView(id: string, focus: string) {
	settle();
	document.body.style.minHeight = `${document.body.offsetHeight}px`;
	document.body.classList.add("picking");
	$(id).hidden = false;
	play($(id), "from-right");
	$(id).scrollTop = 0;
	$(focus).focus();
}

// Back where the page was opened from.
function closeView(id: string, opener: string) {
	document.body.classList.remove("picking");
	document.body.style.minHeight = "";
	$(id).hidden = true;
	play(document.querySelector("header")!, "from-left");
	play(shownTab(), "from-left");
	$(opener).focus({ preventScroll: true });
	$(opener).scrollIntoView({ block: "nearest" });
}

const picker = initPicker({
	name: () => $<HTMLInputElement>("profile-name").value.trim() || $<HTMLInputElement>("profile-name").placeholder,
	openView,
	closeView,
});

refresh();
refreshProfiles();
// the shortcut may have just been set on Chrome's shortcuts page
sendMessage({ type: "checkShortcut" });
