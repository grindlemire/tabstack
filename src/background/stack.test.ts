import { describe, expect, test } from "bun:test";
import { committed, type Jump, order, overlayClosed, putFirst, toFront } from "./stack";

// Tabs 1 to 5; the background's steps, in the order a cycle takes them.
const A = 1;
const B = 2;
const C = 3;
const D = 4;
const E = 5;

describe("order", () => {
	test("the stack's order, then tabs it hasn't seen, of those in view", () => {
		expect(order([C, A, B], [A, B, C, D], C)).toEqual([C, A, B, D]);
		expect(order([C, A, B], [B, C], C)).toEqual([C, B]);
	});

	test("the current tab first, and only as many as asked for", () => {
		expect(order([A, B, C, D, E], [A, B, C, D, E], C, 3)).toEqual([C, A, B]);
		expect(order([A, B, C], [A, B, C], null)).toEqual([A, B, C]);
	});

	test("a current tab out of view moves nothing", () => {
		expect(order([A, B, C], [B, C], A)).toEqual([B, C]);
	});
});

describe("a cycle", () => {
	test("tap on a web page: the overlay switches to the previous tab", () => {
		const { stack, jump } = toFront([A, B, C], B, null);
		expect(stack).toEqual([B, A, C]);
		expect(jump).toBeNull();
	});

	test("tap from a browser page: jump to the previous tab and stay", () => {
		const { stack, jump: jumped } = toFront([A, B, C], B, { from: A, via: B });
		let jump = committed(jumped, B, B); // the overlay on B commits B itself
		expect(jump).toEqual({ from: A, via: B });
		jump = overlayClosed(jump, B);
		expect(jump).toBeNull();
		expect(stack).toEqual([B, A, C]);
	});

	test("held from a browser page: past the tab jumped to, the start is previous", () => {
		let jump: Jump | null = { from: A, via: B };
		let stack: number[];
		({ stack, jump } = toFront([A, B, C, D], B, jump));
		jump = committed(jump, B, C); // stepped on to C in B's overlay
		expect(jump).toEqual({ from: A, via: B, to: C });
		jump = overlayClosed(jump, B); // still on its way to C
		({ stack, jump } = toFront(stack, C, jump));
		expect(stack).toEqual([C, A, B, D]);
		expect(jump).toBeNull();
	});

	test("held back round to the start: it's just a switch back", () => {
		let jump: Jump | null = { from: A, via: B };
		let stack: number[];
		({ stack, jump } = toFront([A, B, C], B, jump));
		jump = committed(jump, B, A);
		({ stack, jump } = toFront(stack, A, jump));
		expect(stack).toEqual([A, B, C]);
		expect(overlayClosed(jump, B)).toBeNull();
	});

	test("another tab's overlay doesn't touch the jump", () => {
		const jump: Jump = { from: A, via: B };
		expect(committed(jump, C, D)).toBe(jump);
		expect(overlayClosed(jump, C)).toBe(jump);
	});

	test("quick presses between browser pages: each step keeps the start second", () => {
		let stack = [A, B, C, D];
		stack = putFirst(stack, B, A);
		expect(stack).toEqual([B, A, C, D]);
		stack = putFirst(stack, C, A);
		expect(stack).toEqual([C, A, B, D]);
	});

	test("closing a tab mid-cycle: the one below takes its place", () => {
		const stack = [A, B, C, D, E, 6].filter((id) => id !== B);
		expect(order(stack, [A, C, D, E, 6], A, 5)).toEqual([A, C, D, E, 6]);
	});
});
