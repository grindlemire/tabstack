// Toolbar popup: shortcuts and options.

const { api, isMac, isFirefox, DEFAULTS, loadSettings, iconSvg, inkOn, markElement, fromEvent, format } = TabstackShared;
const $ = (id) => document.getElementById(id);

// Firefox lets an extension rebind its own commands. Chrome only allows it on
// its shortcuts page.
const canRebindCommands = typeof api.commands.update === "function";

function note(text, error = false) {
	$("note").textContent = text;
	$("note").classList.toggle("error", error);
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
// "Ctrl+Shift+K" is Ctrl Shift K.
function showKeys(el, shortcut) {
	el.classList.toggle("missing", !shortcut);
	if (!shortcut) {
		el.textContent = "Not set";
		return;
	}
	const keys = shortcut.includes("+") ? shortcut.split("+") : shortcut.match(/[⌃⌥⇧⌘]|[^⌃⌥⇧⌘]+/g);
	el.replaceChildren(...keys.map((key) => Object.assign(document.createElement("kbd"), { textContent: key })));
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

async function refreshProfiles() {
	if (isFirefox) return;
	const status = await api.runtime.sendMessage({ type: "profiles" }).catch(() => null);
	if (!status || !("granted" in status)) return;
	const [{ profilesAdHidden }, { profileId }] = await Promise.all([
		api.storage.sync.get("profilesAdHidden"),
		api.storage.local.get("profileId"),
	]);
	$("profiles-ad").hidden = status.granted || !!profilesAdHidden;
	// set up once and turned off since (here, or by tabstack-host uninstall)
	if (profileId) {
		$("profiles-ad-title").textContent = "Profile features are off";
		$("profiles-ad-text").textContent = "Turn them back on to switch, search and open links across your profiles.";
		$("profiles-learn").textContent = "Turn back on";
	}
	$("profiles").hidden = !status.granted;
	if (!status.granted) return;

	const others = status.peers.filter((p) => !p.self);
	if (!status.connected && /not found/.test(status.error)) {
		// uninstalled, or never registered with this browser
		$("profiles-status").textContent = "The profile helper isn't installed";
		$("profiles-detail").textContent = "Run tabstack-host install, or turn off profile features below.";
	} else if (!status.connected) {
		$("profiles-status").textContent = "Can't reach the profile helper";
		$("profiles-detail").textContent = status.error;
	} else if (!others.length) {
		$("profiles-status").textContent = "Only this profile so far";
		$("profiles-detail").textContent = "Set up tabstack in your other profiles too.";
	} else {
		const one = others.length === 1;
		$("profiles-status").textContent = `Connected to ${one ? others[0].name : `${others.length} profiles`}`;
		$("profiles-detail").textContent = one ? "" : others.map((p) => p.name).join(" · ");
	}

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
}

$("profiles-learn").addEventListener("click", openSetup);
$("profiles-setup").addEventListener("click", openSetup);
$("profiles-ad-hide").addEventListener("click", () => {
	api.storage.sync.set({ profilesAdHidden: true });
	$("profiles-ad").hidden = true;
});
$("profile-keys-change").addEventListener("click", () => {
	api.tabs.create({ url: "chrome://extensions/shortcuts" });
	window.close();
});
$("profiles-off").addEventListener("click", async () => {
	await api.permissions.remove(PERMISSIONS);
	// the offer comes back, to turn them on again from here
	await api.storage.sync.set({ profilesAdHidden: false });
	refreshProfiles();
});

for (const box of document.querySelectorAll("[data-shared]")) {
	box.addEventListener("change", () => {
		api.runtime.sendMessage({ type: "profilesShared", values: { [box.dataset.shared]: box.checked } });
		if (box.dataset.shared === "route") $("claims-row").hidden = !box.checked;
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

// The top of the picker: what's under the pointer, or what's picked.
function showHero() {
	const shown = previewing ?? mark;
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
	$("mark-preview").replaceChildren(mark ? markElement(mark, TabstackIcons[mark.icon]) : "None");
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

function openPicker() {
	document.body.classList.add("picking");
	$("mark-view").hidden = false;
	$("mark-search").value = "";
	filterIcons();
	scrollTo(0, 0);
	$("mark-search").focus();
}

function closePicker() {
	previewing = null;
	document.body.classList.remove("picking");
	$("mark-view").hidden = true;
	$("mark-open").focus({ preventScroll: true });
	$("mark-open").scrollIntoView({ block: "nearest" });
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
	clearTimeout(nameTimer);
	nameTimer = setTimeout(() => api.storage.sync.set({ profileName: e.target.value.trim() }), 300);
});
$("profile-claims").addEventListener("change", (e) => {
	const claims = e.target.value.split("\n").map((c) => c.trim()).filter(Boolean);
	api.storage.sync.set({ profileClaims: claims });
});

refresh();
refreshProfiles();
// the shortcut may have just been set on Chrome's shortcuts page
api.runtime.sendMessage({ type: "checkShortcut" });
