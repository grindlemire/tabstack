// How profiles (profiles.ts) compare addresses: whether a link belongs to a
// profile, and whether two tabs are on the same page. The helper's covers
// (cmd/tabstack/tabs.go) has to agree with this one, so both are tested on
// the same cases (testdata/covers.json).

// Longer claims never match, as in the helper (its maxPattern, in UTF-8 bytes): any profile can make one.
const maxPattern = 4096;
const utf8 = new TextEncoder();

// Whether a pattern from "Links that open in this profile" covers a URL.
// "corp.com" is that site (and www.corp.com), "*.corp.com" adds its
// subdomains, and a path covers everything under it: "github.com/acme" is
// /acme and /acme/…. A * matches anything, so "github.com/g*" covers every
// path starting with /g, and "github.com/*/issues" every repo's issues.
// A port ("localhost:3000") has to match too; without one, any port does.
export function covers(pattern: string, url: URL): boolean {
	if (utf8.encode(pattern).length > maxPattern) return false;
	const [site = "", ...rest] = pattern
		.trim()
		.toLowerCase()
		.replace(/^https?:\/\//, "")
		.split("/");
	const [host, port] = hostAndPort(site);
	if (!host) return false;
	// hostname is lowercase, and an IPv6 address comes bracketed and shortened
	const hostname = url.hostname;
	// a * in it can't reach past the host
	const hostMatches = host.startsWith("*.")
		? glob(host.slice(2), hostname, "/") || glob(host, hostname, "/") // "*.corp.com" is corp.com too
		: glob(host, hostname, "/") || (hostname.startsWith("www.") && glob(host, hostname.slice(4), "/"));
	if (!hostMatches) return false;
	// "localhost:80" is http://localhost/ too, which has no port of its own
	const urlPort = url.port || (url.protocol === "https:" ? "443" : "80");
	if (port && !glob(port, urlPort)) return false;
	const path = decode(rest.join("/"))
		.toLowerCase()
		.replace(/\/\*?$/, "")
		.replace(/\/+$/, "");
	if (!path) return true;
	// the path, or anything under it
	const urlPath = decode(url.pathname).toLowerCase();
	if (!urlPath.startsWith("/")) return false;
	return glob(path, urlPath.slice(1)) || glob(`${path}/*`, urlPath.slice(1));
}

// A site's host and port. An IPv6 address is bracketed when it has a port, as
// in a link ("[::1]:3000"), and may be bare when it hasn't ("::1").
function hostAndPort(site: string): [host: string, port: string | undefined] {
	const parts = /^(\[[^\]]*\]|[^:]*)(?::([^:]*))?$/.exec(site);
	return parts ? [parts[1]!, parts[2]] : [`[${site}]`, undefined];
}

// Whether text matches pattern, each * in it any run of characters but
// wall. The pieces between the *s are found in turn, each where it first
// turns up, the first at the start and the last at the end, so it reads the
// text about once: a RegExp backtracks exponentially over a claim of many
// *s, and any profile can make one.
//
// The first place a piece turns up is enough: one further on leaves the *
// before it more to cover, and the * after it no less.
function glob(pattern: string, text: string, wall?: string): boolean {
	const pieces = pattern.split("*");
	const first = pieces[0]!;
	if (pieces.length === 1) return pattern === text;
	const last = pieces[pieces.length - 1]!;
	const end = text.length - last.length; // where the last piece starts
	if (end < first.length || !text.startsWith(first) || !text.endsWith(last)) return false;
	const spans = (from: number, to: number) => wall === undefined || !text.slice(from, to).includes(wall);
	let at = first.length;
	for (const piece of pieces.slice(1, -1)) {
		const found = text.indexOf(piece, at);
		if (found < 0 || found + piece.length > end || !spans(at, found)) return false;
		at = found + piece.length;
	}
	return spans(at, end);
}

// Paths are compared decoded, so "/caf%C3%A9" is "/café" however either was
// written. Left as is when the escapes aren't UTF-8.
function decode(path: string) {
	try {
		return decodeURIComponent(path);
	} catch {
		return path;
	}
}

// A page's address without its fragment or a trailing slash, to find the
// same page open in another profile. Nothing for a tab with no address, so
// it matches nothing.
export function pageKey(href: string | undefined): string | null {
	if (!href) return null;
	try {
		const url = new URL(href);
		url.hash = "";
		return url.href.replace(/\/$/, "");
	} catch {
		return null;
	}
}
