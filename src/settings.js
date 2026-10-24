// Toolbar popup: shortcuts and options.

const { api, isMac, isFirefox, DEFAULTS, loadSettings, fromEvent, format } = TabstackShared;
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
