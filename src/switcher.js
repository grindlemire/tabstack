// The switcher outside a page: the fallback when neither the current tab nor
// the previous one can show the overlay (two chrome:// pages in a row). It
// opens in the toolbar popup (switcher.html?popup), or in its own window when
// the popup won't open. Either has keyboard focus, so it sees the modifier
// come up.

const { api, loadSettings, matches } = TabstackShared;
const MODIFIERS = { Meta: "metaKey", Control: "ctrlKey", Alt: "altKey", Shift: "shiftKey" };

// A popup sizes itself to the page, so the page sets the size. Chrome caps
// popups at 800x600.
const POPUP_WIDTH = 800;
const inPopup = new URLSearchParams(location.search).has("popup");
if (inPopup) document.body.style.width = `${POPUP_WIDTH}px`;

const port = api.runtime.connect({ name: "switcher" });
let modifier = "Meta";
let settings;
let committing = false;
let released = false; // the modifier came up before the tabs arrived

const shadow = document.getElementById("root").attachShadow({ mode: "open" });
const switcher = new TabstackUI.Switcher(shadow, {
	width: inPopup ? POPUP_WIDTH : null,
	onCommit: (item) => {
		committing = true;
		port.postMessage(
			item.closed
				? { type: "restore", sessionId: item.sessionId }
				: { type: "activate", tabId: item.id, windowId: item.windowId },
		);
	},
	onCloseTab: (tab) => port.postMessage({ type: "closeTab", tabId: tab.id, currentId: switcher.tabs[0]?.id }),
	onClose: () => {
		// after a commit, wait for the background to confirm (or give up) so
		// closing doesn't drop the message
		if (committing) setTimeout(() => window.close(), 300);
		else window.close();
	},
});

// The rows' height is tied to the viewport, which a popup doesn't have until
// it has sized itself.
if (inPopup) shadow.append(Object.assign(document.createElement("style"), { textContent: ".rows { max-height: 380px; }" }));

port.onMessage.addListener(async (msg) => {
	if (msg.type === "start") {
		settings = await loadSettings();
		switcher.autoSwitch = settings.autoSwitch;
		switcher.switchCode = msg.switchCode ?? null;
		modifier = msg.modifier ?? modifier;
		switcher.open("cycle", msg.tabs ?? []);
		if (released) switcher.commit();
	} else if (msg.type === "cycle") {
		switcher.move(1);
	} else if (msg.type === "more") {
		switcher.addTabs(msg.tabs);
	} else if (msg.type === "tabs") {
		switcher.setTabs(msg.tabs, msg.closed);
	} else if (msg.type === "done") {
		window.close();
	}
});

function openSearch() {
	switcher.search();
	// every window and recently closed tabs, which a cycle's list may not have
	port.postMessage({ type: "search", currentId: switcher.tabs[0]?.id });
}

addEventListener("keydown", (e) => {
	const search = settings?.searchShortcut;
	if (search && (matches(e, search) || (switcher.mode === "cycle" && e.code === search.code))) {
		e.preventDefault();
		openSearch();
		return;
	}
	if (switcher.isOpen && switcher.handleKey(e)) e.preventDefault();
});

addEventListener("keyup", (e) => {
	if (e.key !== modifier) return;
	if (switcher.mode === "cycle") switcher.commit();
	else if (!switcher.isOpen) released = true;
});

// Recover from a missed keyup: pointer events carry the modifier state.
addEventListener("pointermove", (e) => {
	if (switcher.isOpen && switcher.mode === "cycle" && !e[MODIFIERS[modifier]]) switcher.commit();
});

// Close when focus leaves, but only once the window has actually had it:
// macOS sometimes opens it unfocused.
let hadFocus = document.hasFocus();
addEventListener("focus", () => (hadFocus = true));
addEventListener("blur", () => {
	if (hadFocus && !committing) window.close();
});
