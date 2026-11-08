// The extension API, and which browser and platform it's running on, for every
// tabstack context.

// Firefox's browser.* and Chrome's chrome.* are the same API, and both return
// promises when called without a callback.
//
// Chrome has no browser global, so in a content script `browser` falls
// through to the page's elements by id: on a page with id="browser" it's that
// element (or a collection of them, or a cross-origin frame that throws when
// touched). Only the real API has a runtime that sends messages.
export function extensionApi(g: { browser?: unknown; chrome?: typeof chrome } = globalThis): typeof chrome {
	try {
		const b = g.browser as typeof chrome | undefined;
		if (typeof b?.runtime?.sendMessage === "function") return b;
	} catch {}
	return g.chrome!;
}

export const api: typeof chrome = extensionApi();

export const isMac = /Mac/.test(navigator.platform);

// runtime.getBrowserInfo would tell, but page scripts don't get it
export const isFirefox = navigator.userAgent.includes("Firefox/");
