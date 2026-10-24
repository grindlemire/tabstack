// Connecting tabstack to the profile helper (profiles.js, tabstack-host/).
//
// tabstack-host install opens this page in each profile it finds tabstack in,
// saying which profile it is (where) and what the browser calls it (name):
// then it's one Allow button, since Chrome only grants the permission on a
// click. Opened from tabstack's popup instead, it explains how to get there,
// or once the profile's set up, shows its connection and settings.

const { api } = TabstackShared;
const $ = (id) => document.getElementById(id);
const PERMISSIONS = { permissions: ["nativeMessaging", "contextMenus"] };
const POLL = 1500; // ms; other profiles connect while this page is open

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
		"tabstack-host found tabstack in this profile. Click Allow, then accept Chrome's prompt " +
		'to let tabstack "communicate with cooperating native applications": that\'s the helper. Chrome asks once in each profile.';
	// saved now, so they survive the restart that connecting can need
	api.storage.local.set({ profileWhere: where, setupUrl: location.href });
	api.storage.sync.get("profileName").then(({ profileName }) => {
		if (!profileName && params.get("name")) api.storage.sync.set({ profileName: params.get("name") });
	});
}

for (const button of document.querySelectorAll("[data-copy]")) {
	button.addEventListener("click", async () => {
		await navigator.clipboard.writeText($(button.dataset.copy).textContent);
		button.textContent = "Copied";
		setTimeout(() => (button.textContent = "Copy"), 1500);
	});
}

// Why connecting failed, kept until the next try: the page refreshes its
// status every POLL ms, which would otherwise wipe it.
let problem = "";
let autoConnected = false;

// Which page this is: install's Allow page, the setup steps, or, once this
// profile is set up, its connection.
function showPage(status) {
	const page = allowing ? "allow" : status?.granted ? "manage" : "steps";
	$("from-cli").hidden = page !== "allow";
	$("manual").hidden = page !== "steps";
	$("manage").hidden = page !== "manage";
	if (page === "manage") $("title").textContent = "Profile connections";
	else if (page === "steps") $("title").textContent = "Work across your Chrome profiles";
	if (page !== "manage") return;
	const el = $("manage-status");
	if (status.connected) {
		const names = status.peers.map((p) => (p.self ? `${p.name} (this one)` : p.name));
		el.className = "status ok";
		el.textContent = `Connected. Profiles: ${names.join(", ")}`;
	} else {
		el.className = "status error";
		el.textContent = `This profile can't reach the helper${status.error ? ` (${status.error})` : ""}. Check that tabstack-host is installed, then reconnect.`;
	}
}

function show(status) {
	showPage(status);
	const el = $("status");
	el.className = "status";
	$("settings").hidden = !status?.connected;
	$("done-row").hidden = !run || !status?.connected;
	// install's pages end with Done, and the connection page needs no sign-off
	$("after").hidden = !!run || (!allowing && !!status?.granted);
	// the Allow instructions are done with
	$("cli-lede").hidden = !!status?.connected;
	$("connect-here").parentElement.hidden = !!status?.connected;
	if (!status?.granted) {
		el.classList.toggle("error", !!problem);
		el.textContent = problem;
		$("allow").hidden = false;
		return;
	}
	if (!status.connected) {
		el.classList.add("error");
		el.textContent = `tabstack can't reach the helper${status.error ? ` (${status.error})` : ""}. Run tabstack-host install, then try again.`;
		$("allow").hidden = false;
		$("allow").textContent = "Try again";
		return;
	}
	el.classList.add("ok");
	const names = status.peers.map((p) => (p.self ? `${p.name} (this one)` : p.name));
	el.textContent = `Connected. Profiles so far: ${names.join(", ")}`;
	if (run) el.textContent += ". Name this profile below, then click Done.";
	$("allow").hidden = true;
}

async function showKeys() {
	const commands = await api.commands.getAll();
	const keys = ["profile-next", "profile-prev"].map((n) => commands.find((c) => c.name === n)?.shortcut).filter(Boolean);
	if (!keys.length) {
		$("keys").textContent = "No shortcut set";
		return;
	}
	// "⌃⌘→" is three keys
	$("keys").replaceChildren(
		...keys.map((k) => {
			const group = Object.assign(document.createElement("span"), { className: "keys" });
			for (const key of k.includes("+") ? k.split("+") : k.match(/[⌃⌥⇧⌘]|[^⌃⌥⇧⌘]+/g)) {
				group.append(Object.assign(document.createElement("kbd"), { textContent: key }));
			}
			return group;
		}),
	);
}

async function refresh() {
	const status = await api.runtime.sendMessage({ type: "profiles" }).catch(() => null);
	// allowed before, but the helper wasn't registered then: connect now
	if (fromCli && status?.granted && !status.connected && !autoConnected) {
		autoConnected = true;
		show(await api.runtime.sendMessage({ type: "profilesConnect" }));
		return;
	}
	show(status);
	if (status && document.activeElement !== $("name")) {
		$("name").value = status.name;
		$("name").placeholder = status.placeholder;
	}
	if (status?.claims && document.activeElement !== $("links")) $("links").value = status.claims.join("\n");
}

async function connect() {
	// fire and forget: Chrome only shows its prompt while handling the click,
	// so nothing can be awaited before asking
	api.storage.local.set({ setupUrl: location.href });
	const ok = await api.permissions.request(PERMISSIONS).catch((e) => e.message);
	if (ok !== true) {
		problem = ok ? `Chrome didn't ask: ${ok}` : "tabstack needs that permission to reach the helper.";
		show(null);
		return;
	}
	problem = "";
	$("status").className = "status";
	$("status").textContent = "Connecting…";
	show(await api.runtime.sendMessage({ type: "profilesConnect" }));
}

$("allow").addEventListener("click", connect);
$("connect-here").addEventListener("click", () => {
	allowing = true;
	showPage(null);
	$("cli-lede").textContent = "Click Allow, then accept Chrome's prompt. Chrome asks once in each profile.";
	connect();
});

$("reconnect").addEventListener("click", async () => {
	$("manage-status").className = "status";
	$("manage-status").textContent = "Reconnecting…";
	show(await api.runtime.sendMessage({ type: "profilesConnect" }));
});

// like "Turn off profile features" in the popup; back to the setup steps
$("turn-off").addEventListener("click", async () => {
	await api.permissions.remove(PERMISSIONS);
	await api.storage.sync.set({ profilesAdHidden: true });
	refresh();
});

const saveName = () => api.storage.sync.set({ profileName: $("name").value.trim() });
const saveLinks = () =>
	api.storage.sync.set({ profileClaims: $("links").value.split("\n").map((l) => l.trim()).filter(Boolean) });

let nameTimer = 0;
$("name").addEventListener("input", () => {
	clearTimeout(nameTimer);
	nameTimer = setTimeout(saveName, 300);
});
$("name").addEventListener("keydown", (e) => {
	if (e.key === "Enter" && run) finish();
});
$("links").addEventListener("change", saveLinks);

// Saves what's on the page and tells tabstack-host install this profile is
// set up, so it moves on to the next one.
async function finish() {
	clearTimeout(nameTimer);
	await Promise.all([saveName(), saveLinks()]);
	await api.storage.local.set({ setupDone: run });
	// The background passes it on to install. This page is read from disk
	// fresh, but the background keeps running the code it started with, so
	// after an update it may not know to: check that it took.
	let took = false;
	for (let i = 0; i < 15 && !took; i++) {
		await new Promise((r) => setTimeout(r, 200));
		const status = await api.runtime.sendMessage({ type: "profiles" }).catch(() => null);
		took = status?.done === run;
	}
	$("done-status").className = took ? "status ok" : "status error";
	$("done-status").textContent = took
		? "Saved. tabstack-host moves on to your next profile, if there is one. You can close this tab."
		: "Saved, but tabstack's background didn't pass it on. Reload tabstack on chrome://extensions, then click Done again.";
}
$("done").addEventListener("click", finish);

$("shortcuts").addEventListener("click", () => api.tabs.create({ url: "chrome://extensions/shortcuts" }));

showKeys();
refresh();
setInterval(refresh, POLL);
