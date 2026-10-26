// Search outside a page: on pages the overlay can't run on (chrome:// pages),
// the search shortcut opens the switcher in the toolbar popup
// (switcher.html?popup), or in its own window when the popup won't open.
//
// Cycling never opens here. A popup or window that opens while the modifier
// is held doesn't reliably hear it come up (see cycleWithoutOverlay in
// background.js), and searching doesn't need it to.

const { api, loadSettings, watchLabel } = TabstackShared;

// A popup sizes itself to the page, so the page sets the width, the same
// as the search panel's on web pages.
const inPopup = new URLSearchParams(location.search).has("popup");
if (inPopup) document.body.style.width = "560px";

const port = api.runtime.connect({ name: "switcher" });
let committing = false;

const shadow = document.getElementById("root").attachShadow({ mode: "open" });
const switcher = new TabstackUI.Switcher(shadow, {
	onCommit: (item) => {
		committing = true;
		// profile is set on another profile's tabs (profiles.js)
		port.postMessage(
			item.profileSwitch
				? { type: "switchProfile", profile: item.profile }
				: item.closed
					? { type: "restore", sessionId: item.sessionId, profile: item.profile }
					: { type: "activate", tabId: item.id, windowId: item.windowId, profile: item.profile },
		);
	},
	onCloseTab: (tab) => port.postMessage({ type: "closeTab", tabId: tab.id, profile: tab.profile }),
	onClose: () => {
		// after a commit, wait for the background to confirm (or give up) so
		// closing doesn't drop the message
		if (committing) setTimeout(() => window.close(), 300);
		else window.close();
	},
});

watchLabel((label) => switcher.setProfile(label));

// The rows' height is tied to the viewport, which a popup doesn't have until
// it has sized itself.
if (inPopup) shadow.append(Object.assign(document.createElement("style"), { textContent: ".rows, .panel.named .rows { max-height: 380px; }" }));

port.onMessage.addListener(async (msg) => {
	if (msg.type === "start") {
		const settings = await loadSettings();
		switcher.autoSwitch = settings.autoSwitch;
		switcher.open("search", msg.tabs ?? []);
		switcher.search();
		// every window and recently closed tabs, which a cycle's list doesn't have
		port.postMessage({ type: "search", currentId: switcher.tabs[0]?.id });
	} else if (msg.type === "tabs") {
		switcher.setTabs(msg.tabs, msg.closed);
	} else if (msg.type === "moreTabs") {
		switcher.addResults(msg.tabs, msg.closed, msg.profiles, msg.marks);
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
addEventListener("focus", () => (hadFocus = true));
addEventListener("blur", () => {
	if (hadFocus && !committing) window.close();
});
