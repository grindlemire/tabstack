// This profile's name and links, and turning profile features off, as the
// settings popup and the setup page both do them. The background's profiles
// module reads what they store.

import { api } from "../shared/api";
import { type AnswerTo, type ProfilesStatus, sendMessage } from "../shared/messages";

// What profile features need: the helper, and the right-click menu.
export const PERMISSIONS: chrome.permissions.Permissions = { permissions: ["nativeMessaging", "contextMenus"] };

// The helper's status, or null when there's none to show: sending failed, or
// the answer was { ok } (the handler failed, or had nothing to say), or
// nothing at all (no listener answered).
const statusOf = (answer: AnswerTo<{ type: "profiles" | "profilesConnect" }>): ProfilesStatus | null =>
	answer && typeof answer === "object" && "granted" in answer ? answer : null;

export const profilesStatus = (): Promise<ProfilesStatus | null> =>
	sendMessage({ type: "profiles" }).then(statusOf, () => null);

export const connectProfiles = (): Promise<ProfilesStatus | null> =>
	sendMessage({ type: "profilesConnect" }).then(statusOf, () => null);

// Turns profile features off in this profile. The popup's offer to set them
// up comes back, to turn them on again from there.
export async function turnOff(): Promise<void> {
	await api.permissions.remove(PERMISSIONS);
	await api.storage.sync.set({ profilesAdHidden: false });
}

// --- the name and links, edited in place ---

const SAVE_AFTER = 300; // ms after the last change, so typing doesn't save every key

export interface Editor {
	// Shows the stored value, unless it's being edited.
	show(value: string): void;
	// Saves what's in the box now.
	save(): Promise<void>;
}

const pending = new Set<() => Promise<void>>();

// Chrome ends a closing popup's timers with it, so an edit still waiting to
// be saved is saved as the page goes.
const flush = () => {
	for (const save of pending) save();
};
addEventListener("pagehide", flush);
document.addEventListener("visibilitychange", () => {
	if (document.visibilityState === "hidden") flush();
});

// Saved a moment after each change, or at once when the box loses focus or
// the page goes. saved runs once it's stored.
function editor(
	box: HTMLInputElement | HTMLTextAreaElement,
	store: (value: string) => Promise<void>,
	saved?: () => void,
): Editor {
	let timer: ReturnType<typeof setTimeout> | 0 = 0;
	async function save() {
		clearTimeout(timer);
		timer = 0;
		pending.delete(save);
		await store(box.value);
		saved?.();
	}
	box.addEventListener("input", () => {
		clearTimeout(timer);
		timer = setTimeout(save, SAVE_AFTER);
		pending.add(save);
	});
	box.addEventListener("blur", () => {
		if (timer) save();
	});
	return {
		show(value) {
			if (document.activeElement !== box && !timer) box.value = value;
		},
		save,
	};
}

// The name other profiles show this one by.
export const nameEditor = (input: HTMLInputElement, saved?: () => void): Editor =>
	editor(input, (value) => api.storage.sync.set({ profileName: value.trim() }), saved);

// The links that open in this profile, one per line.
export const linksEditor = (textarea: HTMLTextAreaElement, saved?: () => void): Editor =>
	editor(
		textarea,
		(value) =>
			api.storage.sync.set({
				profileClaims: value
					.split("\n")
					.map((line) => line.trim())
					.filter(Boolean),
			}),
		saved,
	);
