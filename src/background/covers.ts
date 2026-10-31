// How profiles (profiles.ts) compare addresses: whether a link belongs to a
// profile, and whether two tabs are on the same page. The helper's covers
// (cmd/tabstack/tabs.go) has to agree with this one, so both are tested on
// the same cases (testdata/covers.json).

// Whether a pattern from "Links that open in this profile" covers a URL.
// "corp.com" is that site (and www.corp.com), "*.corp.com" adds its
// subdomains, and a path covers everything under it: "github.com/acme" is
// /acme and /acme/…. A * matches anything, so "github.com/g*" covers every
// path starting with /g, and "github.com/*/issues" every repo's issues.
// A port ("localhost:3000") has to match too; without one, any port does.
export function covers(pattern: string, url: URL): boolean {
	const [site = "", ...rest] = pattern
		.trim()
		.toLowerCase()
		.replace(/^https?:\/\//, "")
		.split("/");
	const [host, port] = hostAndPort(site);
	if (!host) return false;
	const hostPattern = host.startsWith("*.")
		? `(?:[^/]*\\.)?${glob(host.slice(2), "[^/]*")}`
		: `(?:www\\.)?${glob(host, "[^/]*")}`;
	// hostname is lowercase, and an IPv6 address comes bracketed and shortened
	if (!new RegExp(`^${hostPattern}$`).test(url.hostname)) return false;
	// "localhost:80" is http://localhost/ too, which has no port of its own
	const urlPort = url.port || (url.protocol === "https:" ? "443" : "80");
	if (port && !new RegExp(`^${glob(port, ".*")}$`).test(urlPort)) return false;
	const path = decode(rest.join("/"))
		.toLowerCase()
		.replace(/\/\*?$/, "")
		.replace(/\/+$/, "");
	if (!path) return true;
	return new RegExp(`^/${glob(path, ".*")}(?:/.*)?$`).test(decode(url.pathname).toLowerCase());
}

// A site's host and port. An IPv6 address is bracketed when it has a port, as
// in a link ("[::1]:3000"), and may be bare when it hasn't ("::1").
function hostAndPort(site: string): [host: string, port: string | undefined] {
	const parts = /^(\[[^\]]*\]|[^:]*)(?::([^:]*))?$/.exec(site);
	return parts ? [parts[1]!, parts[2]] : [`[${site}]`, undefined];
}

// A pattern made a regular expression, its *s matching star.
function glob(text: string, star: string) {
	return text
		.split("*")
		.map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join(star);
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
