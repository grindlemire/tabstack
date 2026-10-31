// Connecting tabstack to the profile helper (the background's profiles module, cmd/tabstack/).
//
// tabstack install opens this page in each profile it finds tabstack in,
// saying which profile it is (where) and what the browser calls it (name):
// then it's one Allow button, since Chrome only grants the permission on a
// click. Opened from tabstack's popup instead, it explains how to get there.
// Opened once the profile's set up (as it is after the restart connecting can
// need), it shows its connection and settings.

import { api } from "../../shared/api";
import { type ProfilesStatus, sendMessage } from "../../shared/messages";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const PERMISSIONS: chrome.permissions.Permissions = { permissions: ["nativeMessaging", "contextMenus"] };
const POLL = 1500; // ms; other profiles connect while this page is open
const CLOSE_AFTER = 1200; // ms after Done that the page closes itself

const params = new URLSearchParams(location.search);
const where = params.get("where");
const fromCli = !!where;
const run = params.get("run"); // install waits for Done with this before moving on

// The Allow page: from install, or once "Connect this profile" is clicked.
let allowing = fromCli;

if (fromCli) {
	const name = params.get("name") || "this profile";
	$("title").textContent = `Connect ${name}`;
	$("cli-lede").textContent =
		"tabstack install found tabstack in this profile. Click Allow, then accept Chrome's prompt " +
		'to let tabstack "communicate with cooperating native applications": that\'s the helper. Chrome asks once in each profile.';
	// saved now, so they survive the restart that connecting can need
	api.storage.local.set({ profileWhere: where, setupUrl: location.href });
	api.storage.sync.get<{ profileName?: string }>("profileName").then(({ profileName }) => {
		if (!profileName && params.get("name")) api.storage.sync.set({ profileName: params.get("name") });
	});
}

// --- motion (the animations are in setup.html) ---

// Plays an animation on an element from the start, and takes it off once it ends.
function play(el: HTMLElement, name: string) {
	el.classList.remove(name);
	void el.offsetWidth; // restarts the animation
	el.classList.add(name);
	el.addEventListener("animationend", () => el.classList.remove(name), { once: true });
}

// A status line, whose words fade in when they change, or shake when
// something went wrong. The page redraws it every POLL ms, so it only moves
// when it says something new.
function setStatus(el: HTMLElement, kind: string, text: string) {
	const changed = el.textContent !== text;
	el.className = kind ? `status ${kind}` : "status";
	el.textContent = text;
	if (changed && text) play(el, kind === "error" ? "shake" : "appear");
}

// A button's working state: a spinner, and no second click.
function busy(button: HTMLButtonElement, on: boolean) {
	button.classList.toggle("busy", on);
	button.disabled = on;
}

for (const button of document.querySelectorAll<HTMLElement>("[data-copy]")) {
	button.addEventListener("click", async () => {
		await navigator.clipboard.writeText($(button.dataset.copy!).textContent);
		button.textContent = "Copied";
		button.classList.add("copied");
		play(button, "pop");
		setTimeout(() => {
			button.textContent = "Copy";
			button.classList.remove("copied");
		}, 1500);
	});
}

// Why connecting failed, kept until the next try: the page refreshes its
// status every POLL ms, which would otherwise wipe it.
let problem = "";
let autoConnected = false;
let connecting = false; // the poll waits while Allow or Reconnect is under way

// What the page shows: the "profiles" or "profilesConnect" answer, or null
// when sending failed. An { ok } answer (no status, or a failed handler) is
// passed on as it is, as before, and reads as neither granted nor connected.
type Shown = ProfilesStatus | null;

// Which page this is: install's Allow page, the setup steps, or, once this
// profile is set up, its connection.
function showPage(status: Shown) {
	const page = allowing ? "allow" : status?.granted ? "manage" : "steps";
	$("from-cli").hidden = page !== "allow";
	$("manual").hidden = page !== "steps";
	$("manage").hidden = page !== "manage";
	if (page === "manage") $("title").textContent = "Profile connections";
	else if (page === "steps") $("title").textContent = "Work across your Chrome profiles";
	if (page !== "manage") return;
	// page is "manage" only when status?.granted
	if (status!.connected) {
		const names = status!.peers.map((p) => (p.self ? `${p.name} (this one)` : p.name));
		setStatus($("manage-status"), "ok", `Connected. Profiles: ${names.join(", ")}`);
	} else {
		const why = status!.error ? ` (${status!.error})` : "";
		setStatus(
			$("manage-status"),
			"error",
			`This profile can't reach the helper${why}. Check that the tabstack command is installed, then reconnect.`,
		);
	}
}

function show(status: Shown) {
	showPage(status);
	const el = $("status");
	$("settings").hidden = !status?.connected;
	$("done-row").hidden = !run || !status?.connected;
	// install's pages end with Done, and the connection page needs no sign-off
	$("after").hidden = !!run || (!allowing && !!status?.granted);
	// the Allow instructions are done with
	$("cli-lede").hidden = !!status?.connected;
	$("connect-here").parentElement!.hidden = !!status?.connected;
	if (!status?.granted) {
		setStatus(el, problem ? "error" : "", problem);
		$("allow").hidden = false;
		return;
	}
	if (!status.connected) {
		const why = status.error ? ` (${status.error})` : "";
		setStatus(el, "error", `tabstack can't reach the helper${why}. Run tabstack install, then try again.`);
		$("allow").hidden = false;
		$("allow").textContent = "Try again";
		return;
	}
	const names = status.peers.map((p) => (p.self ? `${p.name} (this one)` : p.name));
	let text = `Connected. Profiles so far: ${names.join(", ")}`;
	if (run) text += ". Name this profile below, then click Done.";
	setStatus(el, "ok", text);
	$("allow").hidden = true;
}

async function showKeys() {
	const commands = await api.commands.getAll();
	const keys = ["profile-next", "profile-prev"]
		.map((n) => commands.find((c) => c.name === n)?.shortcut)
		.filter(Boolean) as string[];
	// setup.html says ⌃⌘→ and ⌃⌘←, the keys on a Mac
	if (keys.length) $("shortcut-text").textContent = keys.join(" and ");
	if (!keys.length) {
		$("keys").textContent = "No shortcut set";
		return;
	}
	// "⌃⌘→" is three keys
	$("keys").replaceChildren(
		...keys.map((k) => {
			const group = Object.assign(document.createElement("span"), { className: "keys" });
			// a shortcut without + is one or more characters, so match finds something
			for (const key of k.includes("+") ? k.split("+") : k.match(/[⌃⌥⇧⌘]|[^⌃⌥⇧⌘]+/g)!) {
				group.append(Object.assign(document.createElement("kbd"), { textContent: key }));
			}
			return group;
		}),
	);
}

async function refresh() {
	if (connecting) return;
	const status = (await sendMessage({ type: "profiles" }).catch(() => null)) as Shown;
	// allowed before, but the helper wasn't registered then: connect now
	if (fromCli && status?.granted && !status.connected && !autoConnected) {
		autoConnected = true;
		show((await sendMessage({ type: "profilesConnect" })) as Shown);
		return;
	}
	show(status);
	if (status && document.activeElement !== $("name")) {
		$<HTMLInputElement>("name").value = status.name;
		$<HTMLInputElement>("name").placeholder = status.placeholder;
	}
	if (status?.claims && document.activeElement !== $("links"))
		$<HTMLTextAreaElement>("links").value = status.claims.join("\n");
}

async function connect() {
	// fire and forget: Chrome only shows its prompt while handling the click,
	// so nothing can be awaited before asking
	api.storage.local.set({ setupUrl: location.href });
	const ok: boolean | string = await api.permissions.request(PERMISSIONS).catch((e: Error) => e.message);
	if (ok !== true) {
		problem = ok ? `Chrome didn't ask: ${ok}` : "tabstack needs that permission to reach the helper.";
		show(null);
		return;
	}
	problem = "";
	connecting = true;
	busy($<HTMLButtonElement>("allow"), true);
	setStatus($("status"), "", "Connecting…");
	const status = (await sendMessage({ type: "profilesConnect" })) as Shown;
	connecting = false;
	busy($<HTMLButtonElement>("allow"), false);
	show(status);
}

$("allow").addEventListener("click", connect);
$("connect-here").addEventListener("click", () => {
	allowing = true;
	showPage(null);
	$("cli-lede").textContent = "Click Allow, then accept Chrome's prompt. Chrome asks once in each profile.";
	connect();
});

$("reconnect").addEventListener("click", async () => {
	connecting = true;
	busy($<HTMLButtonElement>("reconnect"), true);
	setStatus($("manage-status"), "", "Reconnecting…");
	const status = (await sendMessage({ type: "profilesConnect" })) as Shown;
	connecting = false;
	busy($<HTMLButtonElement>("reconnect"), false);
	show(status);
});

// like "Turn off profile features" in the popup; back to the setup steps
$("turn-off").addEventListener("click", async () => {
	await api.permissions.remove(PERMISSIONS);
	await api.storage.sync.set({ profilesAdHidden: true });
	refresh();
});

const saveName = () => api.storage.sync.set({ profileName: $<HTMLInputElement>("name").value.trim() });
const saveLinks = () =>
	api.storage.sync.set({
		profileClaims: $<HTMLTextAreaElement>("links")
			.value.split("\n")
			.map((l) => l.trim())
			.filter(Boolean),
	});

let nameTimer: ReturnType<typeof setTimeout> | 0 = 0;
$("name").addEventListener("input", () => {
	clearTimeout(nameTimer);
	nameTimer = setTimeout(saveName, 300);
});
$("name").addEventListener("keydown", (e) => {
	if (e.key === "Enter" && run) finish();
});
$("links").addEventListener("change", saveLinks);

// Saves what's on the page and tells tabstack install this profile is
// set up, so it moves on to the next one.
async function finish() {
	if ($<HTMLButtonElement>("done").disabled) return;
	clearTimeout(nameTimer);
	busy($<HTMLButtonElement>("done"), true);
	await Promise.all([saveName(), saveLinks()]);
	await api.storage.local.set({ setupDone: run });
	// The background passes it on to install. This page is read from disk
	// fresh, but the background keeps running the code it started with, so
	// after an update it may not know to: check that it took.
	let took = false;
	for (let i = 0; i < 15 && !took; i++) {
		await new Promise((r) => setTimeout(r, 200));
		const status = (await sendMessage({ type: "profiles" }).catch(() => null)) as Shown;
		took = status?.done === run;
	}
	busy($<HTMLButtonElement>("done"), false);
	setStatus(
		$("done-status"),
		took ? "ok" : "error",
		took
			? "Saved. tabstack install moves on to your next profile, if there is one."
			: "Saved, but tabstack's background didn't pass it on. Reload tabstack on chrome://extensions, then click Done again.",
	);
	if (!took) return;
	// this tab's work is done: a moment to read that it saved, then it fades
	// and goes
	$("done").classList.add("success");
	$("done").textContent = "Saved";
	$<HTMLButtonElement>("done").disabled = true;
	setTimeout(() => document.body.classList.add("closing"), CLOSE_AFTER - 300);
	// this page is a tab of its own, so getCurrent finds it
	setTimeout(async () => api.tabs.remove((await api.tabs.getCurrent())!.id!), CLOSE_AFTER);
}
$("done").addEventListener("click", finish);

$("shortcuts").addEventListener("click", () => api.tabs.create({ url: "chrome://extensions/shortcuts" }));

showKeys();
refresh();
setInterval(refresh, POLL);
