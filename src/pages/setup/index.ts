// Connecting tabstack to the profile helper (the background's profiles module, cmd/tabstack/).
//
// tabstack install opens this page in each profile it finds tabstack in,
// saying which profile it is (where) and what the browser calls it (name):
// then it's one Allow button, since Chrome only grants the permission on a
// click. Opened from tabstack's popup instead, it explains how to get there.
// Opened once the profile's set up (as it is after the restart connecting can
// need), it shows its connection and settings.

import { api } from "../../shared/api";
import type { ProfilesStatus } from "../../shared/messages";
import { $, cssTime, keycaps } from "../page";
import { connectProfiles, linksEditor, nameEditor, PERMISSIONS, profilesStatus, turnOff } from "../profile";

const POLL = 1500; // ms; other profiles connect while this page is open
const CLOSE_AFTER = 1200; // ms after Done that the page closes itself
const COPIED_FOR = 1500; // ms that a Copy button says Copied
// After Done, how long the background has to pass it on, and how often that's checked
const DONE_WAIT = 3000; // ms
const DONE_CHECK = 200; // ms

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

// --- motion (the animations are in setup.html and page.css) ---

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
		}, COPIED_FOR);
	});
}

// Why connecting failed, kept until the next try: the page refreshes its
// status every POLL ms, which would otherwise wipe it.
let problem = "";
let autoConnected = false;
let connecting = false; // the poll waits while Allow or Reconnect is under way

// What the page shows: the helper's status, or null when there was none to
// be had (profile.ts), which reads as neither granted nor connected.
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
			for (const key of keycaps(k)) group.append(Object.assign(document.createElement("kbd"), { textContent: key }));
			return group;
		}),
	);
}

const profileName = nameEditor($("name"));
const profileLinks = linksEditor($("links"));

async function refresh() {
	if (connecting) return;
	let status = await profilesStatus();
	// allowed before, but the helper wasn't registered then: connect now
	if (fromCli && status?.granted && !status.connected && !autoConnected) {
		autoConnected = true;
		status = (await connectProfiles()) ?? status;
	}
	show(status);
	if (!status) return;
	profileName.show(status.name);
	$<HTMLInputElement>("name").placeholder = status.placeholder;
	profileLinks.show(status.claims.join("\n"));
}

// Allow and Reconnect: the button's busy, and the poll waits, until the
// background answers. With no answer (it's gone, or connecting threw), the
// page says so until the poll shows what it finds.
async function reconnect(button: HTMLButtonElement, line: HTMLElement, text: string) {
	connecting = true;
	busy(button, true);
	setStatus(line, "", text);
	const status = await connectProfiles();
	connecting = false;
	busy(button, false);
	if (status) {
		show(status);
		return;
	}
	problem = "tabstack's background didn't answer. Reload tabstack on chrome://extensions, then try again.";
	setStatus(line, "error", problem);
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
	await reconnect($("allow"), $("status"), "Connecting…");
}

$("allow").addEventListener("click", connect);
$("connect-here").addEventListener("click", () => {
	allowing = true;
	showPage(null);
	$("cli-lede").textContent = "Click Allow, then accept Chrome's prompt. Chrome asks once in each profile.";
	connect();
});

$("reconnect").addEventListener("click", () => reconnect($("reconnect"), $("manage-status"), "Reconnecting…"));

// as "Turn off profile features" in the popup, whose offer comes back; back
// to the setup steps
$("turn-off").addEventListener("click", async () => {
	await turnOff();
	refresh();
});

$("name").addEventListener("keydown", (e) => {
	if (e.key === "Enter" && run) finish();
});

// Saves what's on the page and tells tabstack install this profile is
// set up, so it moves on to the next one.
async function finish() {
	if ($<HTMLButtonElement>("done").disabled) return;
	busy($<HTMLButtonElement>("done"), true);
	await Promise.all([profileName.save(), profileLinks.save()]);
	await api.storage.local.set({ setupDone: run });
	// The background passes it on to install. This page is read from disk
	// fresh, but the background keeps running the code it started with, so
	// after an update it may not know to: check that it took.
	let took = false;
	for (let waited = 0; waited < DONE_WAIT && !took; waited += DONE_CHECK) {
		await new Promise((r) => setTimeout(r, DONE_CHECK));
		took = (await profilesStatus())?.done === run;
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
	setTimeout(() => document.body.classList.add("closing"), CLOSE_AFTER - cssTime("--closing"));
	// this page is a tab of its own, so getCurrent finds it
	setTimeout(async () => api.tabs.remove((await api.tabs.getCurrent())!.id!), CLOSE_AFTER);
}
$("done").addEventListener("click", finish);

$("shortcuts").addEventListener("click", () => api.tabs.create({ url: "chrome://extensions/shortcuts" }));

showKeys();
refresh();
setInterval(refresh, POLL);
