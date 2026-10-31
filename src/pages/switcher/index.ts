// Search outside a page: on pages the overlay can't run on (chrome:// pages),
// the search shortcut opens the switcher in the toolbar popup
// (switcher.html?popup), or in its own window when the popup won't open.
//
// Cycling never opens here. A popup or window that opens while the modifier
// is held doesn't reliably hear it come up (see cycleWithoutOverlay in
// the background), and searching doesn't need it to.

import { api } from "../../shared/api";
import type { Elsewhere, Message, PortReply, SearchTabs } from "../../shared/messages";
import { loadSettings, watchLabel } from "../../shared/settings";
import { adoptStyle, Switcher } from "../../ui";

// After a commit, how long to wait for the background to confirm before
// closing anyway, so closing doesn't drop the message.
const COMMIT_WAIT = 300;

// A popup sizes itself to the page, so the page sets the width, the same
// as the search panel's on web pages.
const inPopup = new URLSearchParams(location.search).has("popup");
if (inPopup) document.body.style.width = "560px";

const port = api.runtime.connect({ name: "switcher" });
// The worker stopped, or tabstack was reloaded: nothing here works without it.
port.onDisconnect.addListener(() => window.close());
const post = (message: Message) => {
	try {
		port.postMessage(message);
	} catch {
		window.close(); // disconnected, and onDisconnect hasn't run yet
	}
};
let committing = false;

const shadow = document.getElementById("root")!.attachShadow({ mode: "open" });
const switcher = new Switcher(shadow, {
	onCommit: (message) => {
		committing = true;
		post(message);
	},
	onCloseTab: (message) => post(message),
	onClose: () => {
		if (committing) setTimeout(() => window.close(), COMMIT_WAIT);
		else window.close();
	},
});

watchLabel((label) => switcher.setProfile(label));

// The rows' height is tied to the viewport, which a popup doesn't have until
// it has sized itself. (Adopted after the switcher's own sheet, so it wins.)
if (inPopup) adoptStyle(shadow, ".rows, .panel.named .rows { max-height: 380px; }");

// The background answers search over the port: this profile's tabs, then
// other profiles', which only come when there are some.
let gotTabs: (lists: SearchTabs) => void = () => {};
let gotMore: (elsewhere: Elsewhere) => void = () => {};

port.onMessage.addListener(async (msg: PortReply) => {
	if (msg.type === "start") {
		const settings = await loadSettings();
		switcher.autoSwitch = settings.autoSwitch;
		switcher.open("search", msg.tabs ?? []);
		switcher.search();
		const tabs = new Promise<SearchTabs>((resolve) => (gotTabs = resolve));
		const elsewhere = new Promise<Elsewhere>((resolve) => (gotMore = resolve));
		// every window and recently closed tabs, which a cycle's list doesn't have
		post({ type: "search", currentId: switcher.tabs[0]?.id });
		switcher.load({ tabs: () => tabs, elsewhere: () => elsewhere });
	} else if (msg.type === "tabs") {
		gotTabs(msg);
	} else if (msg.type === "moreTabs") {
		gotMore(msg);
	} else if (msg.type === "done") {
		window.close();
	}
});

addEventListener("keydown", (e) => {
	if (switcher.isOpen && switcher.handleKey(e)) e.preventDefault();
});

// Close when focus leaves, but only once the window has actually had it:
// macOS sometimes opens it unfocused.
let hadFocus = document.hasFocus();
addEventListener("focus", () => {
	hadFocus = true;
});
addEventListener("blur", () => {
	if (hadFocus && !committing) window.close();
});
