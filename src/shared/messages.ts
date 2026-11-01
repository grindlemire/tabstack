// What tabstack's parts send each other, and the things they pass around.
//
// Content scripts and tabstack's own pages send the background a Message
// (runtime.sendMessage, or the switcher page's port), and get back an
// AnswerTo<that message>. The background sends the top frame's content script
// a PageMessage (tabs.sendMessage, frameId 0), and the switcher page a
// PortReply. The background's MESSAGES table says who may send each Message.

import { api } from "./api";

// --- what's passed around ---

// A profile's mark: an icon (by name, from icons.ts) or a letter, in a color,
// drawn on it (solid) or in it (clear). path is the icon's SVG path, filled in
// by the profile that sends it, so pages needn't load every icon.
export interface Mark {
	icon?: string;
	glyph?: string;
	color: string;
	style?: "solid" | "clear";
	path?: string;
}

// Another profile, numbered as the popup's Switch tab numbers them, which
// search switches to by its number. windows is how many it has open.
export interface SwitchTarget {
	n: number;
	profile: string;
	name: string;
	mark: Mark | null;
	windows: number;
}

// This profile's name over search and its mark (storage.local profileLabel),
// kept by the background's profiles module. A profile with neither has none.
export interface Label {
	name: string;
	mark: Mark | null;
	switchTo?: SwitchTarget[];
}

// An open tab, from the background's snapshot(). thumb is only sent for a
// cycle, and icon is a 32px PNG data URL. profile and profileName are set on
// another profile's tabs.
export interface TabItem {
	id: number;
	windowId: number;
	title?: string;
	url?: string;
	icon: string | null;
	audible: boolean;
	call: boolean;
	thumb: string | null;
	profile?: string;
	profileName?: string;
	closed?: undefined;
	profileSwitch?: undefined;
	subtitle?: undefined;
	sessionId?: undefined;
}

// A recently closed tab, which Enter reopens.
export interface ClosedItem {
	closed: true;
	sessionId?: string;
	title?: string;
	url?: string;
	icon: string | null;
	profile?: string;
	profileName?: string;
	id?: undefined;
	windowId?: undefined;
	audible?: undefined;
	call?: undefined;
	thumb?: undefined;
	profileSwitch?: undefined;
	subtitle?: undefined;
}

// Another profile itself, which search switches to by name.
export interface ProfileSwitchItem {
	profileSwitch: true;
	profile: string;
	title?: string;
	subtitle?: string;
	id?: undefined;
	windowId?: undefined;
	url?: undefined;
	icon?: undefined;
	audible?: undefined;
	call?: undefined;
	thumb?: undefined;
	closed?: undefined;
	sessionId?: undefined;
	profileName?: undefined;
}

// Anything the switcher lists.
export type Item = TabItem | ClosedItem | ProfileSwitchItem;

// Search's list of this profile's tabs.
export interface SearchTabs {
	tabs: TabItem[];
	closed: ClosedItem[];
}

// Other profiles' tabs, labeled with their profile, the profiles themselves,
// and each profile's mark, by profile.
export interface Elsewhere {
	tabs: TabItem[];
	closed: ClosedItem[];
	profiles: ProfileSwitchItem[];
	marks: Record<string, Mark>;
}

// Settings every profile shares (the background's profiles module).
export interface SharedSettings {
	searchAll: boolean;
	searchProfiles: boolean;
	stack: boolean;
	dupes: boolean;
	route: boolean;
}

// A connected profile, as the settings popup and the setup page list it.
export interface PeerRow {
	profile: string;
	name: string;
	mark: Mark | null;
	windows: number;
	self: boolean;
}

// What the settings popup and the setup page show of the profile helper.
export interface ProfilesStatus {
	granted: boolean;
	connected: boolean;
	error: string;
	peers: PeerRow[];
	name: string;
	placeholder: string;
	claims: string[];
	done: string;
	shared: SharedSettings;
}

// The key whose release ends a cycle.
export type Modifier = "Meta" | "Control" | "Alt" | "Shift";

// How long each step of a switch took (Settings → Show timings). The
// background starts it; the page fills in the rest.
export interface Timing {
	commandAt?: number;
	swAgeMs?: number;
	snapshotMs?: number;
	jumped?: boolean;
	pageAt?: number;
	paintMs?: number;
	searchTabsMs?: number;
	releasedBeforeMessage?: boolean;
}

// --- to the background ---

// What relay.js passes on from an iframe to the top frame.
export type RelayedMessage = { type: "search" } | { type: "modUp"; key: string };

// "page" ones come from content scripts or tabstack's own pages.
export type PageToBackground =
	| { type: "tabs"; search?: boolean }
	| { type: "tabsElsewhere" }
	| { type: "activate"; tabId: number; windowId: number; profile?: string }
	| { type: "restore"; sessionId?: string; profile?: string }
	| { type: "switchProfile"; profile: string }
	| { type: "closeTab"; tabId: number; profile?: string }
	| { type: "toastAction"; id: string }
	| { type: "media"; live: boolean }
	| { type: "open" }
	| { type: "close" }
	| { type: "relay"; message: RelayedMessage };

// "extension" ones only from tabstack's own pages.
export type ExtensionToBackground =
	| { type: "search"; currentId?: number }
	| { type: "profiles" }
	| { type: "profilesShared"; values: Partial<SharedSettings> }
	| { type: "profilesConnect" }
	| { type: "checkShortcut" };

export type Message = PageToBackground | ExtensionToBackground;
export type MessageType = Message["type"];
export type MessageOf<T extends MessageType> = Extract<Message, { type: T }>;

export type Ok = { ok: true };
export type Failed = { ok: false };
export type Done = { type: "done" };

// What each message's handler in the background settles with. undefined
// (and void) reach the sender as { ok: true }.
export interface Results {
	tabs: TabItem[] | SearchTabs;
	tabsElsewhere: Elsewhere;
	activate: Done;
	restore: Done;
	switchProfile: Done;
	closeTab: { tabs: TabItem[] } | undefined;
	toastAction: void;
	media: void;
	open: void;
	close: void;
	relay: void;
	search: MoreTabs | undefined;
	profiles: ProfilesStatus | undefined;
	profilesShared: void;
	profilesConnect: ProfilesStatus | undefined;
	checkShortcut: void;
}

// What the sender gets back: the handler's answer, { ok: true } for none, or
// { ok: false } when it isn't allowed to send it or the handler failed. A
// "tabs" message gets search's lists when it asks for search, or else a
// cycle's tabs.
export type AnswerTo<M extends Message> =
	| (M extends { type: "tabs"; search: true }
			? SearchTabs
			: M extends { type: "tabs" }
				? TabItem[]
				: Exclude<Results[M["type"]], undefined | void>)
	| (undefined extends Results[M["type"]] ? Ok : never)
	| Failed;

// --- from the background ---

// To the top frame's content script.
export type PageMessage =
	| {
			type: "cycle";
			timing: Timing;
			tabs?: TabItem[];
			modifier?: Modifier;
			switchCode?: string | null;
			// switched to mid-shortcut from a page tabstack can't run on
			jumped?: boolean;
			selected?: number;
	  }
	| { type: "search" }
	| { type: "modUp"; key: string }
	// a notice from the profiles module; mark is the other profile's
	| { type: "toast"; id: string; text: string; action: string; mark: Mark | null };

// To the switcher page, over its port ("switcher"). start's fields are
// missing when the page wasn't opened by the shortcut.
export type StartMessage = { type: "start"; tabs?: TabItem[]; modifier?: Modifier; switchCode?: string | null };
export type TabsReply = { type: "tabs" } & SearchTabs;
export type MoreTabs = { type: "moreTabs" } & Elsewhere;
export type PortReply = StartMessage | TabsReply | MoreTabs | Done;

// --- in the page ---

// From media.js, in the page's own world, to relay.js, by window.postMessage.
// Any script on the page can post it.
export interface MediaSignal {
	tabstack: "media";
	live: boolean;
}

// runtime.sendMessage, typed by what's sent. Like it, it throws at once
// when the extension was reloaded under a content script.
export const sendMessage = <M extends Message>(message: M): Promise<AnswerTo<M>> => api.runtime.sendMessage(message);
