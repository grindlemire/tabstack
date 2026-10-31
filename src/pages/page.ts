// Helpers the settings popup and the setup page share.

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// The keys of a shortcut as the browser shows it, one keycap each: "⇧⌘K"
// is ⇧ ⌘ K, and "Ctrl+Shift+K" is Ctrl Shift K.
export function keycaps(shortcut: string): string[] {
	if (!shortcut) return [];
	return shortcut.includes("+") ? shortcut.split("+") : (shortcut.match(/[⌃⌥⇧⌘]|[^⌃⌥⇧⌘]+/g) ?? []);
}

// A CSS time ("0.16s" or "160ms") in ms.
export function ms(time: string): number {
	const value = time.trim();
	return value.endsWith("ms") ? Number.parseFloat(value) : Number.parseFloat(value) * 1000;
}

// A duration the page's CSS sets as a custom property on :root, in ms, for a
// timer that waits out a transition, so the two can't drift apart.
export const cssTime = (name: string): number =>
	ms(getComputedStyle(document.documentElement).getPropertyValue(name)) || 0;
