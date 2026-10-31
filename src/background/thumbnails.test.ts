import { describe, expect, test } from "bun:test";
import { savedKey } from "./thumbnails";

describe("savedKey", () => {
	test("a SHA-256 of the whole address, in hex", async () => {
		expect(await savedKey("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	});

	test("pages that differ only by their query or fragment each have their own", async () => {
		const keys = await Promise.all(
			[
				"https://youtube.com/watch?v=A",
				"https://youtube.com/watch?v=B",
				"https://youtube.com/watch",
				"https://youtube.com/watch#t",
			].map(savedKey),
		);
		expect(new Set(keys).size).toBe(4);
		expect(await savedKey("https://youtube.com/watch?v=A")).toBe(keys[0] ?? "");
	});

	test("a tab with no address has none", async () => {
		expect(await savedKey(undefined)).toBeNull();
		expect(await savedKey("")).toBeNull();
	});
});
