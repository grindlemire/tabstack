// Settings used by every tabstack context.

import { api, isMac } from "./api";
import type { Label } from "./messages";
import type { Shortcut } from "./shortcuts";

// What's kept in storage.sync, with the defaults for what isn't there yet.
// searchShortcut is null once it's cleared in Settings, so pages keep the key
// (Cmd+/ toggles comments in most code editors).
export interface Settings {
	searchShortcut: Shortcut | null;
	autoSwitch: boolean;
	includeClosed: boolean;
	thisWindowOnly: boolean;
	showTimings: boolean;
}

export const DEFAULTS: Settings = {
	searchShortcut: { code: "Slash", key: "/", meta: isMac, ctrl: !isMac, alt: false, shift: false },
	autoSwitch: true,
	includeClosed: false,
	thisWindowOnly: false,
	showTimings: false,
};

export async function loadSettings(): Promise<Settings> {
	return { ...DEFAULTS, ...(await api.storage.sync.get(null)) };
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
