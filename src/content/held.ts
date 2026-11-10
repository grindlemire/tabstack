// Whether the switch modifier is still held when a cycle opens on this page,
// apart from the page so it can be tested.

import type { Timing } from "../shared/messages";

export const COLD_WORKER = 1000; // ms: a service worker younger than this was just started for the shortcut
const WORKER_START = 1000; // ms the browser may take to start the worker once the shortcut is pressed

// "tap": the modifier is already up, so switch. "hold": it's down, so show
// the switcher. "listen": there's no telling, so wait, hidden, for the
// page's next input, which carries the modifier's state.
export type CycleStart = "tap" | "hold" | "listen";

export interface PageState {
	timing: Timing;
	// we were switched to mid-shortcut from a page tabstack can't run on
	jumped: boolean;
	// focus is in an iframe, whose keys go to its own document
	inIframe: boolean;
	isFirefox: boolean;
	// the modifier is down, as this frame's own key events have it
	held: boolean;
	// when this frame last heard the modifier come up, itself or from relay.ts
	releasedAt: number | undefined;
}

export function cycleStart({ timing, jumped, inIframe, isFirefox, held, releasedAt }: PageState): CycleStart {
	if (!jumped && !inIframe) return held ? "hold" : "tap";

	// This frame never saw the modifier go down, so only a release since the
	// shortcut was pressed tells it anything. A worker started for the
	// shortcut handled it well after the press: the release can have come
	// first, here or on the page we jumped from.
	const cold = timing.swAgeMs != null && timing.swAgeMs < COLD_WORKER;
	const { commandAt } = timing;
	if (commandAt != null && releasedAt != null) {
		const pressedBy = cold ? commandAt - timing.swAgeMs! - WORKER_START : commandAt;
		if (releasedAt >= pressedBy) return "tap";
	}
	// Unheard, the release may still be on its way, or have come where this
	// frame can't hear it. After a slow start it most likely has. Firefox
	// never tells a page we jumped to that the modifier came up, since it
	// went down over there.
	if (cold || (jumped && isFirefox)) return "listen";
	return "hold";
}
