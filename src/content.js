// Page side of tabstack, top frame only. Draws the switcher over the page, and
// watches the modifier key, because the commands API reports the shortcut
// being pressed but never the modifier being released. Iframes get the much
// smaller relay.js, which forwards their key events here.

(() => {
	const { api, isMac, DEFAULTS, loadSettings, onSettingsChange, matches } = TabstackShared;
	const MODIFIERS = { Meta: "metaKey", Control: "ctrlKey", Alt: "altKey", Shift: "shiftKey" };
	const SHOW_DELAY = 120; // a quick tap switches without flashing the UI

	// A newer copy of this script (extension reload, or injection into a tab
	// that was already open) tells older copies to stand down.
	const TAKEOVER = "tabstack:takeover";
	document.dispatchEvent(new CustomEvent(TAKEOVER));
	const controller = new AbortController();
	const listen = (target, type, fn, capture = true) =>
		target.addEventListener(type, fn, { capture, signal: controller.signal });
	let dead = false;
	let switcher = null;
	let hostEl = null;

	function teardown() {
		dead = true;
		controller.abort();
		switcher?.close();
		hostEl?.remove();
		try {
			api.runtime.onMessage.removeListener(onMessage);
		} catch {}
	}

	function alive() {
		if (!dead && !api.runtime?.id) teardown(); // orphaned by an extension reload
		return !dead;
	}

	function send(message) {
		try {
			return api.runtime.sendMessage(message).catch(() => {});
		} catch {
			teardown();
		}
	}

	listen(document, TAKEOVER, teardown, false);

	let settings = DEFAULTS;
	loadSettings().then((s) => (settings = s));
	onSettingsChange((s) => (settings = s));

	// --- modifier tracking ---

	// The modifier of the switch shortcut; the background sends the real one
	// with each cycle, since it can be rebound.
	let modifier = isMac ? "Meta" : "Control";
	const down = new Set();
	const held = () => down.has(modifier);
	const modDownAt = {};
	const modUpAt = {};

	function syncModifiers(e) {
		for (const [name, prop] of Object.entries(MODIFIERS)) {
			if (e[prop]) down.add(name);
			else down.delete(name);
		}
	}

	listen(window, "keydown", (e) => {
		if (!alive()) return;
		syncModifiers(e);
		if (e.key in MODIFIERS) modDownAt[e.key] = Date.now();

		const search = settings.searchShortcut;
		const searchKey =
			matches(e, search) ||
			// while cycling, the search key works with the switch modifier still held
			(switcher?.isOpen && switcher.mode === "cycle" && e.code === search.code);
		if (searchKey) {
			e.preventDefault();
			e.stopImmediatePropagation();
			openSearch();
			return;
		}

		if (switcher?.isOpen) {
			if (switcher.handleKey(e)) e.preventDefault();
			// keep page shortcuts from firing; typing still reaches the input
			e.stopImmediatePropagation();
		}
	});

	listen(window, "keyup", (e) => {
		if (!alive()) return;
		syncModifiers(e);
		if (e.key in MODIFIERS) {
			down.delete(e.key);
			modUpAt[e.key] = Date.now();
			onModUp(e.key);
		}
		if (switcher?.isOpen) e.stopImmediatePropagation();
	});

	// --- overlay ---

	let showTimer = 0;
	let timing = null;
	let prevFocus = null;

	function ensureSwitcher() {
		if (!switcher) {
			hostEl = document.createElement("tabstack-overlay");
			hostEl.tabIndex = -1;
			hostEl.style.outline = "none";
			switcher = new TabstackUI.Switcher(hostEl.attachShadow({ mode: "closed" }), {
				popover: true,
				onCommit: (item) =>
					send(
						item.closed
							? { type: "restore", sessionId: item.sessionId }
							: { type: "activate", tabId: item.id, windowId: item.windowId },
					),
				onCloseTab: (tab) => send({ type: "closeTab", tabId: tab.id }),
				onClose: hide,
			});
		}
		switcher.autoSwitch = settings.autoSwitch;
		if (!hostEl.isConnected) (document.body ?? document.documentElement).append(hostEl);
		return switcher;
	}

	// Keys typed while focus sits inside an iframe never reach this frame, so
	// pull focus up here while the switcher is open.
	function takeFocusFromIframe() {
		if (document.activeElement?.tagName !== "IFRAME") return;
		prevFocus = document.activeElement;
		hostEl.focus({ preventScroll: true });
	}

	function show() {
		clearTimeout(showTimer);
		if (!switcher.isOpen || switcher.panel.matches(":popover-open")) return;
		const shownAt = Date.now();
		switcher.panel.showPopover();
		requestAnimationFrame(() => report({ paintMs: Date.now() - shownAt }));
	}

	function hide() {
		clearTimeout(showTimer);
		try {
			switcher.panel.hidePopover();
		} catch {}
		send({ type: "close" });
		if (prevFocus?.isConnected) prevFocus.focus({ preventScroll: true });
		prevFocus = null;
	}

	async function onCycle(msg) {
		const s = ensureSwitcher();
		if (s.isOpen) {
			// pressed again while held: go further back, and show the UI now
			s.move(1);
			show();
			return;
		}

		if (msg.modifier) modifier = msg.modifier;
		s.switchCode = msg.switchCode ?? s.switchCode;
		timing = { ...msg.timing, pageAt: Date.now() };
		s.open("cycle", msg.tabs ?? (await send({ type: "tabs" })) ?? []);
		send({ type: "open" });

		// We were switched to mid-shortcut from a page tabstack can't run on,
		// so the modifier went down over there. Count it as held unless it
		// has already come up here.
		const stillHeld = msg.jumped ? !(modUpAt[modifier] >= msg.timing.commandAt) : held();
		if (!stillHeld) {
			// the modifier came up before this message arrived (or the page
			// never saw it go down): it was a quick tap, so just switch
			report({ releasedBeforeMessage: true });
			s.commit();
			return;
		}
		if (msg.jumped) down.add(modifier);
		takeFocusFromIframe();
		showTimer = setTimeout(show, SHOW_DELAY);
	}

	function onModUp(key) {
		if (key === modifier && switcher?.isOpen && switcher.mode === "cycle") switcher.commit();
	}

	async function openSearch() {
		const s = ensureSwitcher();
		const wasOpen = s.isOpen;
		if (!wasOpen) {
			prevFocus = document.activeElement;
			timing = { pageAt: Date.now() };
			s.open("search", []);
			send({ type: "open" });
		}
		show(); // first: the input can't take focus while the panel is hidden
		s.search();
		// search covers every window and recently closed tabs, which a cycle's
		// list may not have
		const result = await send({ type: "tabs", search: true });
		if (s.isOpen && result) s.setTabs(result.tabs, result.closed);
		if (!wasOpen) report({ searchTabsMs: Date.now() - timing.pageAt });
	}

	function onMessage(msg, sender, sendResponse) {
		if (!alive()) return;
		if (msg.type === "cycle") onCycle(msg);
		else if (msg.type === "modUp") onModUp(msg.key);
		else if (msg.type === "search") openSearch();
		sendResponse({ ok: true });
	}
	api.runtime.onMessage.addListener(onMessage);

	// Recover from a missed keyup: pointer events carry the modifier state.
	listen(window, "pointermove", (e) => {
		if (switcher?.isOpen && switcher.mode === "cycle" && !e[MODIFIERS[modifier]]) switcher.commit();
	});
	listen(window, "pointerdown", (e) => {
		if (switcher?.isOpen && !e.composedPath().includes(hostEl)) switcher.close();
	});
	listen(window, "blur", () => {
		// focus moving into an iframe also blurs the window, so check after
		setTimeout(() => {
			if (switcher?.isOpen && !document.hasFocus()) switcher.close();
		});
	});
	listen(document, "visibilitychange", () => {
		if (document.hidden) switcher?.close();
	});

	// --- timings (Settings → Show timings) ---

	function report(extra) {
		if (!timing) return;
		Object.assign(timing, extra);
		if (!settings.showTimings) return;
		const t = timing;
		const parts = [];
		if (t.swAgeMs != null) parts.push(`worker ${t.swAgeMs < 1000 ? "COLD" : "warm"} (age ${t.swAgeMs}ms)`);
		if (t.snapshotMs != null) parts.push(`snapshot ${t.snapshotMs}ms`);
		if (t.commandAt) parts.push(`worker→page ${t.pageAt - t.commandAt}ms`);
		const pressedAt = modDownAt[modifier];
		if (pressedAt && t.pageAt - pressedAt < 3000) parts.push(`modifier down→page ${t.pageAt - pressedAt}ms`);
		if (t.paintMs != null) parts.push(`paint ${t.paintMs}ms`);
		if (t.searchTabsMs != null) parts.push(`tabs loaded ${t.searchTabsMs}ms`);
		if (t.jumped) parts.push("jumped from restricted page");
		if (t.releasedBeforeMessage) parts.push("released before message");
		switcher?.setDebug(parts.join(" · "));
		console.log("[tabstack]", { ...t });
	}
})();
