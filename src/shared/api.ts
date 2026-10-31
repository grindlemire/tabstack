// The extension API, and which browser and platform it's running on, for every
// tabstack context.

// Firefox's browser.* and Chrome's chrome.* are the same API, and both return
// promises when called without a callback.
export const api: typeof chrome = globalThis.browser ?? globalThis.chrome;

export const isMac = /Mac/.test(navigator.platform);

// runtime.getBrowserInfo would tell, but page scripts don't get it
export const isFirefox = navigator.userAgent.includes("Firefox/");
