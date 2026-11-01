// Which pages the overlay can be drawn on.

// The stores keep extensions' scripts out of their pages.
const STORES = /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore|addons\.mozilla\.org)\//;

// Content scripts run on web pages only: not on the browser's own pages,
// whatever it calls them (chrome://, brave://, about:), nor on files, data:
// URLs or the stores.
export const overlayCanRun = (url: string | undefined): boolean =>
	!!url && /^https?:\/\//.test(url) && !STORES.test(url);
