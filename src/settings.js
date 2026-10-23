// Toolbar popup: shortcuts and options.

const { api, isMac, DEFAULTS, loadSettings, fromEvent, format } = TabstackShared;
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
	if (!shortcut) return "Not set";
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
	$("switch-key").textContent = prettyCommand(switchKey);
	$("switch-key").classList.toggle("missing", !switchKey);
	$("find-key").textContent = prettyCommand(commands.find((c) => c.name === "search")?.shortcut);
	if (!switchKey && !recording && !$("note").textContent) {
		note("Another extension or the browser already uses this shortcut. Choose a different one.", true);
	}
	$("search-key").textContent = format(s.searchShortcut);
	$("search-reset").hidden = JSON.stringify(s.searchShortcut) === JSON.stringify(DEFAULTS.searchShortcut);
	$("auto-switch").checked = s.autoSwitch;
	$("include-closed").checked = s.includeClosed;
	$("this-window-only").checked = s.thisWindowOnly;
	$("show-timings").checked = s.showTimings;
}

refresh();
// the shortcut may have just been set on Chrome's shortcuts page
api.runtime.sendMessage({ type: "checkShortcut" });
