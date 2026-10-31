import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { covers, pageKey } from "./covers";

// The helper's covers (cmd/tabstack/tabs_test.go) runs the same cases.
interface Case {
	pattern: string;
	url: string;
	covers: boolean;
}
const cases: Case[] = await Bun.file(join(import.meta.dir, "../../testdata/covers.json")).json();

describe("covers", () => {
	test.each(cases)("%o", ({ pattern, url, covers: want }) => {
		expect(covers(pattern, new URL(url))).toBe(want);
	});

	// Any profile can claim links, and a claim of many *s that fails to match
	// takes no longer than one that matches.
	test("the longest claims fail fast", () => {
		const starA = "*a".repeat(2048);
		for (const [pattern, url] of [
			[starA, `https://${"a".repeat(60)}.example.com/`],
			[`corp.com/${starA}`.slice(0, 4096), `https://corp.com/${"ab".repeat(1000)}`],
			[`corp.com/${starA}`.slice(0, 4095), `https://corp.com/${"a".repeat(4000)}%0a`],
		] as const) {
			const start = performance.now();
			expect(covers(pattern, new URL(url))).toBe(false);
			expect(performance.now() - start).toBeLessThan(50);
		}
	});

	// A long claim takes about one read of a long link: one that nearly
	// matches at each place in it doesn't make covers try each.
	test("a long claim against a long link takes one read", () => {
		const link = new URL(`https://corp.com/${"a".repeat(16000)}`);
		for (const pattern of [`corp.com/*${"a".repeat(4085)}b`, `corp.com/*${"a".repeat(4084)}b*`]) {
			const start = performance.now();
			expect(covers(pattern, link)).toBe(false);
			expect(performance.now() - start).toBeLessThan(20);
		}
	});

	// covers matches as the RegExp it used to build, on claims short enough
	// for the RegExp to finish.
	test("agrees with the RegExp it replaced", () => {
		let seed = 1;
		const random = (n: number) => {
			seed = (seed * 1103515245 + 12345) % 2 ** 31;
			return seed % n;
		};
		const pick = (parts: string[], most: number) =>
			Array.from({ length: random(most + 1) }, () => parts[random(parts.length)]).join("");
		for (let i = 0; i < 5000; i++) {
			const pattern = pick(["a", "b", ".", "/", "*", "*", ":", "%0a", "%0d", "\n", "www.", "*."], 8);
			const url = new URL(
				`http://${pick(["a", "b", ".", "www."], 5) || "a"}/${pick(["a", "b", "/", ".", "%0a", "%0d", "%e2%80%a8"], 7)}`,
			);
			expect([pattern, url.href, covers(pattern, url)]).toEqual([pattern, url.href, regexpCovers(pattern, url)]);
		}
	});
});

// covers as it was, by RegExp, which backtracks exponentially over many *s;
// with the s flag, since a * now spans line breaks.
function regexpCovers(pattern: string, url: URL): boolean {
	const glob = (text: string, star: string) =>
		text
			.split("*")
			.map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
			.join(star);
	const decode = (path: string) => {
		try {
			return decodeURIComponent(path);
		} catch {
			return path;
		}
	};
	const [site = "", ...rest] = pattern
		.trim()
		.toLowerCase()
		.replace(/^https?:\/\//, "")
		.split("/");
	const parts = /^(\[[^\]]*\]|[^:]*)(?::([^:]*))?$/.exec(site);
	const [host, port] = parts ? [parts[1]!, parts[2]] : [`[${site}]`, undefined];
	if (!host) return false;
	const hostPattern = host.startsWith("*.")
		? `(?:[^/]*\\.)?${glob(host.slice(2), "[^/]*")}`
		: `(?:www\\.)?${glob(host, "[^/]*")}`;
	if (!new RegExp(`^${hostPattern}$`).test(url.hostname)) return false;
	const urlPort = url.port || (url.protocol === "https:" ? "443" : "80");
	if (port && !new RegExp(`^${glob(port, ".*")}$`, "s").test(urlPort)) return false;
	const path = decode(rest.join("/"))
		.toLowerCase()
		.replace(/\/\*?$/, "")
		.replace(/\/+$/, "");
	if (!path) return true;
	return new RegExp(`^/${glob(path, ".*")}(?:/.*)?$`, "s").test(decode(url.pathname).toLowerCase());
}

describe("pageKey", () => {
	test("leaves out the fragment and a trailing slash", () => {
		expect(pageKey("https://corp.com/a/#top")).toBe("https://corp.com/a");
		expect(pageKey("https://corp.com/")).toBe(pageKey("https://corp.com"));
	});

	test("a tab with no address, or not a URL, matches nothing", () => {
		expect(pageKey(undefined)).toBeNull();
		expect(pageKey("")).toBeNull();
		expect(pageKey("not a url")).toBeNull();
	});
});
