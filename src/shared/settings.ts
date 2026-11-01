// Settings used by every tabstack context.

import { api, isMac } from "./api";
import type { Label } from "./messages";
import type { Shortcut } from "./shortcuts";

// What's kept in storage.sync, with the defaults for what isn't there yet.
// searchOnPage is false once the search key is cleared in Settings, so pages
// keep the key (Cmd+/ toggles comments in most code editors). It's a key of
// its own because storage.sync reaches devices still on 1.1.1, whose content
// scripts read searchShortcut on every key and throw on anything but a
// shortcut.
export interface Settings {
	searchShortcut: Shortcut;
	searchOnPage: boolean;
	autoSwitch: boolean;
	includeClosed: boolean;
	thisWindowOnly: boolean;
	showTimings: boolean;
}

export const DEFAULTS: Settings = {
	searchShortcut: { code: "Slash", key: "/", meta: isMac, ctrl: !isMac, alt: false, shift: false },
	searchOnPage: true,
	autoSwitch: true,
	includeClosed: false,
	thisWindowOnly: false,
	showTimings: false,
};

// Pre-release 1.2 builds stored a cleared search key as searchShortcut: null,
// which is the default key, turned off.
export function withDefaults(stored: Record<string, unknown>): Settings {
	const settings: Settings = { ...DEFAULTS, ...stored };
	return stored.searchShortcut === null
		? { ...settings, searchShortcut: DEFAULTS.searchShortcut, searchOnPage: false }
		: settings;
}

export async function loadSettings(): Promise<Settings> {
	const stored = await api.storage.sync.get(null);
	const settings = withDefaults(stored);
	// stored again as 1.1.1 can read it, on the devices this syncs to
	if (stored.searchShortcut === null) {
		const { searchShortcut, searchOnPage } = settings;
		api.storage.sync.set({ searchShortcut, searchOnPage }).catch(() => {});
	}
	return settings;
}

export function onSettingsChange(fn: (settings: Settings) => void): void {
	api.storage.onChanged.addListener((_changes, area) => {
		if (area === "sync") loadSettings().then(fn);
	});
}

// This profile's name and mark ({ name, mark }), or null, now and whenever
// it changes. The background's profiles module keeps it; the Firefox build
// never has one.
export function watchLabel(fn: (label: Label | null) => void): void {
	api.storage.local.get<{ profileLabel?: Label }>("profileLabel").then(({ profileLabel }) => fn(profileLabel ?? null));
	api.storage.onChanged.addListener((changes, area) => {
		if (area === "local" && changes.profileLabel) fn((changes.profileLabel.newValue as Label | undefined) ?? null);
	});
}
