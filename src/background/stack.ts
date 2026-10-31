// The order of the most-recently-used tab stack, apart from the browser so
// it can be tested. Each takes the stack (tab ids, most recent first) and
// returns what replaces it.

// A cycle that started on a page without the overlay: it jumped from there
// to the previous tab (via), whose overlay carries it on. to is the tab that
// overlay commits to, when it's one past via.
export interface Jump {
	from: number;
	via: number;
	to?: number;
}

// ids, in this order, on top of the stack.
export const putFirst = (stack: readonly number[], ...ids: number[]): number[] => [
	...ids,
	...stack.filter((id) => !ids.includes(id)),
];

// tabId came to the front. When a jumped cycle went on past the tab it
// jumped to, the tab it started on is "previous", not the one it passed.
export function toFront(
	stack: readonly number[],
	tabId: number,
	jump: Jump | null,
): { stack: number[]; jump: Jump | null } {
	if (jump?.to === tabId) return { stack: putFirst(stack, tabId, jump.from), jump: null };
	return { stack: putFirst(stack, tabId), jump };
}

// The overlay on overlayTab committed to target.
export function committed(jump: Jump | null, overlayTab: number, target: number): Jump | null {
	if (jump?.via === overlayTab && target !== jump.via && target !== jump.from) return { ...jump, to: target };
	return jump;
}

// The overlay on tabId closed: a jump that stayed on it is over.
export const overlayClosed = (jump: Jump | null, tabId: number): Jump | null =>
	jump?.via === tabId && jump.to == null ? null : jump;

// The tabs a switcher lists, by id: those in view, in the stack's order and
// then the order given, with the current tab first.
export function order(
	stack: readonly number[],
	inView: readonly number[],
	currentId: number | null | undefined,
	limit = Number.POSITIVE_INFINITY,
): number[] {
	const view = new Set(inView);
	const known = new Set(stack);
	const ids = [...stack, ...inView.filter((id) => !known.has(id))].filter((id) => view.has(id));
	const at = currentId == null ? -1 : ids.indexOf(currentId);
	if (at > 0) ids.unshift(...ids.splice(at, 1));
	return ids.slice(0, limit);
}
