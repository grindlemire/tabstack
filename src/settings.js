// Toolbar popup: shortcuts and options.

const { api, isMac, isFirefox, DEFAULTS, loadSettings, iconSvg, inkOn, markElement, fromEvent, format } = TabstackShared;
const $ = (id) => document.getElementById(id);

// Firefox lets an extension rebind its own commands. Chrome only allows it on
// its shortcuts page.
const canRebindCommands = typeof api.commands.update === "function";

// --- motion: what comes and goes in the popup (the animations are in settings.html) ---

const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// Plays an entrance on an element from the start, even one it played before.
// It's taken off once it ends, so showing the element again doesn't replay it.
function play(el, name) {
	el.classList.remove("from-right", "from-left", "appear", name);
	void el.offsetWidth; // restarts the animation
	el.classList.add(name);
	el.addEventListener("animationend", () => el.classList.remove(name), { once: true });
}

// Once the popup's been moved around in, its opening rise is done, so it
// doesn't replay with every tab.
const settle = () => document.body.classList.add("settled");

const fading = new Map(); // element fading out -> the timer that hides it

function reveal(el) {
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

// Fades out, then hides, as the fade (.leaving, 0.16s) ends.
function conceal(el) {
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
		}, 160),
	);
}

function note(text, error = false) {
	const was = $("note").textContent;
	$("note").textContent = text;
	$("note").classList.toggle("error", error);
	if (text && text !== was) play($("note"), "appear");
}

// Chrome reports "⌘J" on macOS already; Firefox reports "Command+J".
function prettyCommand(shortcut) {
	if (!shortcut) return "";
	if (!isMac) return shortcut;
	return shortcut
		.replace("MacCtrl+", "⌃")
		.replace("Alt+", "⌥")
		.replace("Shift+", "⇧")
		.replace(/(Command|Ctrl)\+/, "⌘");
}

// Firefox's names for the keys a command may use.
const FIREFOX_KEYS = {
	Comma: "Comma", Period: "Period", Space: "Space", Home: "Home", End: "End",
	PageUp: "PageUp", PageDown: "PageDown", Insert: "Insert", Delete: "Delete",
	ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
};

function firefoxShortcut(s) {
	const key = /^Key[A-Z]$/.test(s.code)
		? s.code.slice(3)
		: /^Digit\d$/.test(s.code)
			? s.code.slice(5)
			: /^F([1-9]|1[0-2])$/.test(s.code)
				? s.code
				: FIREFOX_KEYS[s.code];
	if (!key) return null;
	const mods = [];
	if (s.alt) mods.push("Alt");
	if (isMac && s.meta) mods.push("Command");
	if (s.ctrl) mods.push(isMac ? "MacCtrl" : "Ctrl");
	if (s.shift) mods.push("Shift");
	return [...mods, key].join("+");
}

// Each key of a shortcut gets its own keycap: "⇧⌘K" is ⇧ ⌘ K, and
// "Ctrl+Shift+K" is Ctrl Shift K. A shortcut that just changed pops in a
// key at a time.
function showKeys(el, shortcut) {
	const changed = el.dataset.shown !== undefined && el.dataset.shown !== shortcut;
	el.dataset.shown = shortcut;
	el.classList.toggle("missing", !shortcut);
	if (!shortcut) {
		el.textContent = "Not set";
		return;
	}
	const keys = shortcut.includes("+") ? shortcut.split("+") : shortcut.match(/[⌃⌥⇧⌘]|[^⌃⌥⇧⌘]+/g);
	el.replaceChildren(
		...keys.map((key, i) => {
			const kbd = Object.assign(document.createElement("kbd"), { textContent: key });
			if (changed) {
				kbd.classList.add("pop");
				kbd.style.animationDelay = `${i * 45}ms`;
			}
			return kbd;
		}),
	);
}

// --- recording a shortcut ---

let recording = null; // { kbd, save }

function record(kbd, save) {
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
		note(err.message, true);
	}
	refresh();
});

// The switch and search shortcuts are the browser's commands.
function bindCommand(name, id) {
	$(`${id}-change`).addEventListener("click", () => {
		if (!canRebindCommands) {
			api.tabs.create({ url: "chrome://extensions/shortcuts" });
			window.close();
			return;
		}
		record($(`${id}-key`), async (s) => {
			const shortcut = firefoxShortcut(s);
			if (!shortcut) throw new Error("Firefox only allows letters, digits, F-keys, arrows, and a few others here.");
			await api.commands.update({ name, shortcut });
			api.runtime.sendMessage({ type: "checkShortcut" });
		});
	});
	if (!canRebindCommands) $(`${id}-change`).title = "Opens Chrome's keyboard shortcuts page";
}
bindCommand("switch", "switch");
bindCommand("search", "find");

$("search-change").addEventListener("click", () =>
	record($("search-key"), (s) => api.storage.sync.set({ searchShortcut: s })),
);
$("search-reset").addEventListener("click", async () => {
	await api.storage.sync.remove("searchShortcut");
	refresh();
});

for (const [id, key] of [
	["auto-switch", "autoSwitch"],
	["include-closed", "includeClosed"],
	["this-window-only", "thisWindowOnly"],
	["show-timings", "showTimings"],
]) {
	$(id).addEventListener("change", (e) => api.storage.sync.set({ [key]: e.target.checked }));
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
	showKeys($("search-key"), format(s.searchShortcut));
	$("search-reset").hidden = JSON.stringify(s.searchShortcut) === JSON.stringify(DEFAULTS.searchShortcut);
	$("auto-switch").checked = s.autoSwitch;
	$("include-closed").checked = s.includeClosed;
	$("this-window-only").checked = s.thisWindowOnly;
	$("show-timings").checked = s.showTimings;
}

// --- profiles (profiles.js) ---
//
// Shown only once the profile helper is set up. Until then there's one small
// offer to set it up, which stays dismissed once closed.

const PERMISSIONS = { permissions: ["nativeMessaging", "contextMenus"] };

const openSetup = () => {
	api.tabs.create({ url: "setup.html" });
	window.close();
};

// With profile features on, they get a tab of their own beside the rest of
// the settings, and with another profile to switch to, the popup opens on
// Switch. Otherwise it opens on whichever settings tab was used last.
const TABS = ["switch", "general", "profiles"]; // left to right
let tabPicked = false;

const currentTab = () => document.querySelector("[data-tab][aria-selected='true']")?.dataset.tab ?? "general";

function lastTab() {
	try {
		return localStorage.getItem("tab") === "profiles" ? "profiles" : "general";
	} catch {
		return "general";
	}
}

const RESIZE_FOR = 300; // ms, as .panels.resizing's transition
let resized = 0;

// Each tab is as tall as it needs to be. Chrome sizes the popup to the page,
// so easing the panel's height from one tab's to the other's (ease) grows or
// shrinks the popup smoothly, instead of in a jump.
function selectTab(name, { ease = false } = {}) {
	const panels = document.querySelector(".panels");
	const from = panels.offsetHeight;
	const tabs = [...document.querySelectorAll("[data-tab]")];
	for (const tab of tabs) tab.setAttribute("aria-selected", tab.dataset.tab === name);
	const shown = tabs.filter((tab) => !tab.hidden);
	$("tabs").style.setProperty("--n", shown.length);
	$("tabs").style.setProperty("--at", Math.max(0, shown.findIndex((tab) => tab.dataset.tab === name)));
	for (const panel of TABS.map($)) {
		panel.classList.toggle("inactive", panel.id !== name);
		panel.inert = panel.id !== name;
	}
	if (name === "switch") focusNext();
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
	}, RESIZE_FOR);
}

const shownTab = () => $(currentTab());

for (const tab of document.querySelectorAll("[data-tab]")) {
	tab.addEventListener("click", () => {
		const name = tab.dataset.tab;
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
let granted = null; // whether profile features were on when last looked
let reconnecting = false;

// How this profile's connected, with Reconnect only when it isn't. A change
// of wording fades in.
function showStatus(status) {
	const others = status.peers.filter((p) => !p.self);
	let text;
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
		text = `Connected to ${others.length === 1 ? others[0].name : `${others.length} profiles`}`;
	}
	showPeers(status);
	$("profiles-dot").classList.toggle("ok", status.connected);
	$("profiles-retry").hidden = status.connected;
	if ($("profiles-status").textContent !== text && $("profiles-status").textContent) play($("profiles-status"), "appear");
	$("profiles-status").textContent = text;
	$("profiles-detail").textContent = detail;
}

// --- Switch: every connected profile, a click away ---
//
// In the order the shortcut steps through them, numbered so 1 to 9 pick
// them, and laid out as evenly as their number allows.

let peers = [];
let peersShown = "";

const switchable = () => peers.length > 1;

// Up to four across, in as few rows as that takes, with the rows as even as
// they'll go: five are three and two, seven four and three, nine three by three.
const acrossFor = (n) => Math.ceil(n / Math.ceil(n / 4));
const across = () => Number($("peers").dataset.across) || 1;

// Redrawn only when something changed, or every poll would lose the
// profile under the pointer, and the one picked with the keys.
function showPeers(status) {
	const next = status.connected ? status.peers : [];
	const key = JSON.stringify(next);
	if (key === peersShown) return;
	const had = switchable();
	const first = !peersShown; // the popup opening, which shouldn't ease from tab to tab
	const focused = document.activeElement?.dataset.profile;
	peersShown = key;
	peers = next;
	const n = acrossFor(peers.length);
	$("peers").dataset.across = n;
	$("peers").style.setProperty("--across", n);
	$("peers").replaceChildren(...peers.map(peerTile));
	$("peers").querySelector(`[data-profile="${CSS.escape(focused ?? "")}"]`)?.focus();

	// Switch comes and goes as other profiles connect and leave
	$("switch").hidden = document.querySelector("[data-tab='switch']").hidden = !switchable();
	if (switchable() === had) return;
	if (!switchable() && currentTab() === "switch") selectTab(lastTab(), { ease: !first });
	else if (switchable() && !tabPicked) selectTab("switch", { ease: !first });
	else selectTab(currentTab()); // the pill, for one more tab or one fewer
}

$("switch-note").textContent = `Press a number, or use the arrow keys and ${isMac ? "Return" : "Enter"}.`;

// This profile is shown but does nothing; another comes forward, as the
// shortcut brings it, or opens a window if it has none.
function peerTile(peer, i) {
	const tile = document.createElement("button");
	tile.className = `peer${peer.self ? " self" : ""}${peer.windows ? "" : " closed"}`;
	tile.dataset.profile = peer.profile;
	const mark = peer.mark
		? markElement(peer.mark, peer.mark.path)
		: Object.assign(document.createElement("span"), { className: "mark empty", textContent: firstGlyph(peer.name).toUpperCase() });
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

async function switchProfile(peer) {
	await api.runtime.sendMessage({ type: "switchProfile", profile: peer.profile }).catch(() => {});
	window.close();
}

// Return switches to the profile the shortcut would bring: the next one.
function focusNext() {
	const self = peers.findIndex((p) => p.self);
	$("peers").children[(self + 1) % peers.length]?.focus({ preventScroll: true });
}

document.addEventListener("keydown", (e) => {
	if (currentTab() !== "switch" || document.body.classList.contains("picking")) return;
	if (e.metaKey || e.ctrlKey || e.altKey) return;
	if (/^[1-9]$/.test(e.key)) {
		const peer = peers[e.key - 1];
		if (!peer || peer.self) return;
		e.preventDefault();
		switchProfile(peer);
		return;
	}
	const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -across(), ArrowDown: across() }[e.key];
	if (!step) return;
	e.preventDefault();
	const tiles = [...$("peers").children];
	const at = tiles.indexOf(document.activeElement);
	tiles[at < 0 ? 0 : Math.min(Math.max(at + step, 0), tiles.length - 1)]?.focus();
});

$("profiles-retry").addEventListener("click", async () => {
	reconnecting = true;
	$("profiles-dot").classList.add("busy");
	$("profiles-retry").disabled = true;
	$("profiles-status").textContent = "Reconnecting…";
	const status = await api.runtime.sendMessage({ type: "profilesConnect" }).catch(() => null);
	reconnecting = false;
	$("profiles-dot").classList.remove("busy");
	$("profiles-retry").disabled = false;
	if (status && "granted" in status) showStatus(status);
});

setInterval(async () => {
	if (isFirefox || reconnecting) return;
	const status = await api.runtime.sendMessage({ type: "profiles" }).catch(() => null);
	if (!status || !("granted" in status)) return;
	// turned on or off from elsewhere (setup page, the tabstack command): redraw it all
	if (status.granted !== granted) refreshProfiles();
	else if (status.granted) showStatus(status);
}, STATUS_POLL);

async function refreshProfiles() {
	if (isFirefox) return;
	const status = await api.runtime.sendMessage({ type: "profiles" }).catch(() => null);
	if (!status || !("granted" in status)) return;
	const [{ profilesAdHidden }, { profileId }] = await Promise.all([
		api.storage.sync.get("profilesAdHidden"),
		api.storage.local.get("profileId"),
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

	if (document.activeElement !== $("profile-name")) $("profile-name").value = status.name;
	$("profile-name").placeholder = status.placeholder;
	({ profileMark: mark = null } = await api.storage.sync.get("profileMark"));
	showMark();
	if (document.activeElement !== $("profile-claims")) $("profile-claims").value = status.claims.join("\n");
	for (const box of document.querySelectorAll("[data-shared]")) box.checked = !!status.shared[box.dataset.shared];
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
	await api.permissions.remove(PERMISSIONS);
	// the offer comes back, to turn them on again from here
	await api.storage.sync.set({ profilesAdHidden: false });
	await refreshProfiles();
	// back on General, which sits to the left
	settle();
	play($("general"), "from-left");
});

for (const box of document.querySelectorAll("[data-shared]")) {
	box.addEventListener("change", () => {
		api.runtime.sendMessage({ type: "profilesShared", values: { [box.dataset.shared]: box.checked } });
		if (box.dataset.shared === "route") (box.checked ? reveal : conceal)($("claims-row"));
	});
}

// --- this profile's mark: an icon or letter in a color, as the toolbar icon ---
//
// Picked on a page of its own over the settings. The mark shows large at the
// top; hovering a choice previews it there, and clicking keeps it.

// a spectrum, then the neutrals: two rows of eight
const MARK_COLORS = [
	["Red", "#e5484d"], ["Orange", "#f2711c"], ["Amber", "#d99a06"], ["Lime", "#7fae1b"],
	["Green", "#30a46c"], ["Teal", "#0e9aa7"], ["Sky", "#1c9be6"], ["Blue", "#3b6cf6"],
	["Indigo", "#5b5bd6"], ["Violet", "#7c5cf0"], ["Purple", "#a34fd8"], ["Pink", "#d6409f"],
	["Brown", "#9e6a4f"], ["Gray", "#8e8e93"], ["Black", "#1d1d1f"], ["White", "#ffffff"],
];
const BLUE = "#3b6cf6";
const STYLE_NAMES = { solid: "Solid", clear: "Transparent" };

// What else each icon answers to in the picker's search, besides its name.
const ICON_WORDS = {
	house: "home personal", briefcase: "work job office business", buildings: "company office city",
	"graduation-cap": "school university study education", book: "read library study",
	chart: "graph trend stats analytics growth", dollar: "money finance bank pay",
	code: "dev developer programming brackets html", terminal: "cli shell prompt command console",
	bug: "debug beetle insect", cpu: "chip hardware computer", database: "data storage server",
	"git-branch": "github version source", "paint-brush": "art design", palette: "art design paint",
	"music-note": "song audio", flask: "science lab test experiment", lightbulb: "idea",
	"game-controller": "games gaming play", airplane: "travel flight", rocket: "launch startup space",
	lightning: "bolt fast power", fire: "flame hot", globe: "world earth web internet", planet: "space saturn",
	smiley: "happy face", chat: "message talk", envelope: "mail email", user: "person me account",
	"shopping-cart": "shop store buy", lock: "secure private", shield: "security safe",
};

// { icon or glyph, color, style: "solid" or "clear" }, or null for tabstack's own icon
let mark = null;
let previewing = null; // the choice under the pointer, shown at the top until it leaves

// The first character as you'd count it, so an accented letter stays whole.
const firstGlyph = (text) => [...new Intl.Segmenter().segment(text)][0]?.segment ?? "";

function initial() {
	const name = $("profile-name").value.trim() || $("profile-name").placeholder;
	return firstGlyph(name).toUpperCase() || "A";
}

// The mark with one choice made: an icon or letter, a color, or a style.
// With no mark yet, a color or style goes with the profile's initial.
function withChoice(choice) {
	const base = mark ?? { glyph: initial(), color: BLUE, style: "solid" };
	const { color, style } = { ...base, ...choice };
	const shape = choice.icon || choice.glyph ? choice : base;
	return shape.icon ? { icon: shape.icon, color, style } : { glyph: shape.glyph, color, style };
}

// Every choice previews on hover or focus, and is kept on click.
function choice(button, pick) {
	const preview = (on) => {
		previewing = on ? withChoice(pick()) : null;
		showHero();
	};
	button.addEventListener("pointerenter", () => preview(true));
	button.addEventListener("pointerleave", () => preview(false));
	button.addEventListener("focus", () => preview(true));
	button.addEventListener("blur", () => preview(false));
	button.addEventListener("click", () => {
		previewing = null;
		saveMark(withChoice(pick()));
	});
}

// Built once, and filtered by the search: a letter, when one's typed, then
// every icon.
const letterChoice = document.createElement("button");
choice(letterChoice, () => ({ glyph: letterChoice.textContent }));
const iconChoices = Object.entries(TabstackIcons).map(([icon, path]) => {
	const button = document.createElement("button");
	button.title = icon.replaceAll("-", " ");
	button.setAttribute("aria-label", button.title);
	button.append(iconSvg(path));
	choice(button, () => ({ icon }));
	return { icon, button, words: `${button.title} ${ICON_WORDS[icon] ?? ""}`.split(/\s+/).filter(Boolean) };
});
$("mark-glyphs").append(letterChoice, ...iconChoices.map((c) => c.button));

const swatches = MARK_COLORS.map(([name, color]) => {
	const button = document.createElement("button");
	button.style.setProperty("--swatch", color);
	button.title = name;
	button.setAttribute("aria-label", name);
	choice(button, () => ({ color }));
	return [color, button];
});
$("mark-colors").append(...swatches.map(([, button]) => button));

for (const button of document.querySelectorAll("[data-style]")) choice(button, () => ({ style: button.dataset.style }));

const iconTitle = (icon) => icon[0].toUpperCase() + icon.slice(1).replaceAll("-", " ");
const colorName = (color) => MARK_COLORS.find(([, c]) => c === color)?.[0] ?? color;

// The top of the picker: what's under the pointer, or what's picked. It's
// redrawn, and pops, only when that changes.
let heroShown;
function showHero() {
	const shown = previewing ?? mark;
	const key = JSON.stringify(shown);
	if (key === heroShown) return;
	heroShown = key;
	if (!shown) {
		$("mark-big").replaceChildren(Object.assign(document.createElement("img"), { src: "icons/icon-48.png", alt: "" }));
		$("mark-title").textContent = "tabstack's icon";
		$("mark-subtitle").textContent = "Pick an icon or a color below";
		return;
	}
	$("mark-big").replaceChildren(markElement(shown, TabstackIcons[shown.icon]));
	$("mark-title").textContent = shown.icon ? iconTitle(shown.icon) : `Letter ${shown.glyph}`;
	$("mark-subtitle").textContent = `${STYLE_NAMES[shown.style] ?? "Solid"} · ${colorName(shown.color)}`;
}

function showMark() {
	$("mark-preview").replaceChildren(
		mark ? markElement(mark, TabstackIcons[mark.icon]) : Object.assign(document.createElement("span"), { className: "mark empty", textContent: initial() }),
	);
	$("mark-remove").hidden = !mark;
	showHero();

	const style = mark?.style === "clear" ? "clear" : "solid";
	for (const button of document.querySelectorAll("[data-style]")) {
		button.setAttribute("aria-checked", !!mark && button.dataset.style === style);
	}
	const grid = $("mark-glyphs");
	grid.className = `glyphs ${style}`;
	if (mark) {
		grid.style.setProperty("--mark", mark.color);
		grid.style.setProperty("--ink", inkOn(mark.color));
	}
	letterChoice.setAttribute("aria-pressed", !!mark?.glyph && letterChoice.textContent === mark.glyph);
	for (const { icon, button } of iconChoices) button.setAttribute("aria-pressed", icon === mark?.icon);
	for (const [color, button] of swatches) button.setAttribute("aria-pressed", color === mark?.color);
}

function saveMark(next) {
	mark = next;
	showMark();
	if (next) api.storage.sync.set({ profileMark: next });
	else api.storage.sync.remove("profileMark");
}

// Every word typed has to start a word of an icon's name, or of the words it
// answers to. A single letter or number can be the mark itself; an emoji
// can't, since it doesn't draw cleanly at toolbar size.
function filterIcons() {
	const query = $("mark-search").value.trim();
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	let shown = 0;
	for (const { button, words: theirs } of iconChoices) {
		button.hidden = !words.every((w) => theirs.some((t) => t.startsWith(w)));
		if (!button.hidden) shown++;
	}
	const glyph = firstGlyph(query);
	const isLetter = !!query && glyph === query && !/\p{Extended_Pictographic}/u.test(glyph);
	letterChoice.hidden = !isLetter;
	if (isLetter) {
		letterChoice.textContent = glyph;
		letterChoice.setAttribute("aria-label", `Letter ${glyph}`);
	}
	$("mark-empty").hidden = shown > 0 || isLetter;
	showMark();
}

// --- a page of its own over the settings: the icon picker ---

// A page slides in from the right, and going back slides the settings in
// from the left. A shorter page keeps the popup's size, so it doesn't shrink
// under the pointer.
function openView(id, focus) {
	settle();
	document.body.style.minHeight = `${document.body.offsetHeight}px`;
	document.body.classList.add("picking");
	$(id).hidden = false;
	play($(id), "from-right");
	$(id).scrollTop = 0;
	$(focus).focus();
}

// Back where the page was opened from.
function closeView(id, opener) {
	document.body.classList.remove("picking");
	document.body.style.minHeight = "";
	$(id).hidden = true;
	play(document.querySelector("header"), "from-left");
	play(shownTab(), "from-left");
	$(opener).focus({ preventScroll: true });
	$(opener).scrollIntoView({ block: "nearest" });
}

function openPicker() {
	$("mark-search").value = "";
	filterIcons();
	openView("mark-view", "mark-search");
}

function closePicker() {
	previewing = null;
	closeView("mark-view", "mark-open");
}

$("mark-open").addEventListener("click", openPicker);
$("mark-back").addEventListener("click", closePicker);
$("mark-remove").addEventListener("click", () => saveMark(null));
$("mark-search").addEventListener("input", filterIcons);
$("mark-search").addEventListener("keydown", (e) => {
	if (e.key !== "Enter") return;
	// the first match: the letter, when one's typed, or the first icon
	$("mark-glyphs").querySelector("button:not([hidden])")?.click();
});
$("mark-view").addEventListener("keydown", (e) => {
	if (e.key !== "Escape") return;
	e.preventDefault();
	if ($("mark-search").value) {
		$("mark-search").value = "";
		filterIcons();
	} else {
		closePicker();
	}
});

let nameTimer = 0;
$("profile-name").addEventListener("input", (e) => {
	if (!mark) showMark(); // with no icon yet, the name's initial stands in
	clearTimeout(nameTimer);
	nameTimer = setTimeout(async () => {
		await api.storage.sync.set({ profileName: e.target.value.trim() });
		play($("name-saved"), "flash");
	}, 300);
});
$("profile-name").addEventListener("keydown", (e) => {
	if (e.key === "Enter") e.target.blur();
});

// The profile's links, edited in place and saved a moment after each
// change, as the name is, or at once when the box loses focus.
let claimsTimer = 0;
async function saveClaims() {
	clearTimeout(claimsTimer);
	claimsTimer = 0;
	await api.storage.sync.set({ profileClaims: $("profile-claims").value.split("\n").map((c) => c.trim()).filter(Boolean) });
	play($("claims-saved"), "flash");
}
$("profile-claims").addEventListener("input", () => {
	clearTimeout(claimsTimer);
	claimsTimer = setTimeout(saveClaims, 300);
});
$("profile-claims").addEventListener("blur", () => claimsTimer && saveClaims());

refresh();
refreshProfiles();
// the shortcut may have just been set on Chrome's shortcuts page
api.runtime.sendMessage({ type: "checkShortcut" });
