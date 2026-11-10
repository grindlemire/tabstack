import { describe, expect, test } from "bun:test";
import { cycleStart, type PageState } from "./held";

const AT = 1_000_000; // when the worker handled the shortcut
const warm = { commandAt: AT, swAgeMs: 60_000 };
const cold = { commandAt: AT, swAgeMs: 40 }; // started for this shortcut

const page = (state: Partial<PageState>): PageState => ({
	timing: warm,
	jumped: false,
	inIframe: false,
	isFirefox: false,
	held: true,
	releasedAt: undefined,
	...state,
});

describe("cycleStart", () => {
	test("a page that saw the press goes by its own key state, warm or cold", () => {
		expect(cycleStart(page({ held: true }))).toBe("hold");
		expect(cycleStart(page({ held: false }))).toBe("tap");
		expect(cycleStart(page({ timing: cold, held: true }))).toBe("hold");
		expect(cycleStart(page({ timing: cold, held: false }))).toBe("tap");
	});

	test("warm, in an iframe: held until a release since the shortcut", () => {
		expect(cycleStart(page({ inIframe: true }))).toBe("hold");
		expect(cycleStart(page({ inIframe: true, releasedAt: AT - 50 }))).toBe("hold"); // an earlier press's
		expect(cycleStart(page({ inIframe: true, releasedAt: AT + 5 }))).toBe("tap");
	});

	test("cold, in an iframe: a release before the worker started counts", () => {
		expect(cycleStart(page({ timing: cold, inIframe: true, releasedAt: AT - 300 }))).toBe("tap");
		expect(cycleStart(page({ timing: cold, inIframe: true, releasedAt: AT + 5 }))).toBe("tap");
	});

	test("cold, in an iframe, no release heard: wait for the next input", () => {
		expect(cycleStart(page({ timing: cold, inIframe: true }))).toBe("listen");
		expect(cycleStart(page({ timing: cold, inIframe: true, releasedAt: AT - 10_000 }))).toBe("listen");
	});

	test("jumped: Chrome holds when warm, waits when cold; Firefox always waits", () => {
		expect(cycleStart(page({ jumped: true }))).toBe("hold");
		expect(cycleStart(page({ jumped: true, timing: cold }))).toBe("listen");
		expect(cycleStart(page({ jumped: true, isFirefox: true }))).toBe("listen");
		expect(cycleStart(page({ jumped: true, releasedAt: AT + 5 }))).toBe("tap");
	});

	test("timing without the worker's age (a blind step) counts as warm", () => {
		expect(cycleStart(page({ jumped: true, timing: { commandAt: AT } }))).toBe("hold");
		expect(cycleStart(page({ inIframe: true, timing: {} }))).toBe("hold");
	});
});
