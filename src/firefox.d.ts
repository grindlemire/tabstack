// What @types/chrome doesn't cover: Firefox's own APIs, which tabstack calls
// only after checking they're there, and the build's FIREFOX_BUILD flag.

// Firefox's promise-based API object; Chrome has only chrome.
declare var browser: typeof chrome | undefined;

// true in the Firefox build of the background (scripts/build.ts), false in
// Chrome's, so the bundler drops code only one of them runs.
declare const FIREFOX_BUILD: boolean;

declare namespace chrome.extensionTypes {
	interface ImageDetails {
		/** Firefox only: the scale to capture at, where 1 is the device's own pixels. */
		scale?: number;
	}
}

declare namespace chrome.tabs {
	/** Firefox only: captures a tab that isn't on screen, as long as it's loaded. */
	const captureTab: ((tabId?: number, options?: chrome.extensionTypes.ImageDetails) => Promise<string>) | undefined;
}

declare namespace chrome.commands {
	/** Firefox only: changes a command's shortcut. */
	const update: ((detail: { name: string; shortcut?: string; description?: string }) => Promise<void>) | undefined;
	/** Firefox only: a command's shortcut changed. */
	const onChanged:
		| chrome.events.Event<(changeInfo: { name: string; newShortcut: string; oldShortcut: string }) => void>
		| undefined;
}

declare namespace chrome.browserAction {
	/** Firefox's Manifest V2 build: opens the popup, while a user action is being handled. */
	const openPopup: (() => Promise<void>) | undefined;
}
