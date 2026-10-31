// Builds the extension from src/ into dist/chrome, derives the Firefox copy in
// dist/firefox from it, then zips both browsers' packages for the stores.
//
// Each entry point is bundled on its own into one classic script (an IIFE):
// content scripts can't be modules, and media.js runs in the page's own
// world. Nothing is minified, so store reviewers can read what they get.
//
// Firefox gets Manifest V2. Under V3 it only lets an extension capture a tab
// it was invoked on (activeTab), however much host access it has, so
// thumbnails would only ever come from pressing the shortcut. V2's <all_urls>
// permission captures any tab, and even background ones (tabs.captureTab).
//
// Usage: bun run build
//   dist/chrome/                         unpacked Chrome build, for Load unpacked
//   dist/firefox/                        unpacked Firefox build, for about:debugging
//   dist/tabstack-<version>-chrome.zip   upload to the Chrome Web Store
//   dist/tabstack-<version>-firefox.zip  upload to addons.mozilla.org
//
// bun run dev (--watch) rebuilds dist/chrome and dist/firefox whenever src/
// changes, with inline source maps, and doesn't zip.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const root = join(import.meta.dir, "..");
const src = join(root, "src");
const dist = join(root, "dist");
const chrome = join(dist, "chrome");
const firefox = join(dist, "firefox");

// Each bundle in the package, by the name the manifest and the pages know it
// by, and the source it's built from.
const ENTRIES: Record<string, string> = {
	"background.js": "background/index.ts",
	"content.js": "content/index.ts",
	"relay.js": "content/relay.ts",
	"media.js": "content/media.ts",
	"settings.js": "pages/settings/index.ts",
	"setup.js": "pages/setup/index.ts",
	"switcher.js": "pages/switcher/index.ts",
};

// Each page's HTML, and its stylesheet when it has one, as the package names them.
const PAGES = ["settings", "setup", "switcher"];

// Working across profiles (the background's profiles module, setup.html and
// the helper's optional permissions) is Chrome only for now, and so is
// media.js. The Firefox background is built again without the profiles
// module (FIREFOX_BUILD).
const CHROME_ONLY = ["setup.html", "setup.js", "setup.css", "media.js"];

interface Manifest {
	version: string;
	content_scripts: { js: string[]; world?: string }[];
	permissions: string[];
	host_permissions: string[];
	commands: Record<string, unknown>;
	action: Record<string, unknown>;
	background: unknown;
	optional_permissions: unknown;
	[key: string]: unknown;
}

async function bundle(entry: string, { firefoxBuild = false, dev = false } = {}): Promise<string> {
	const result = await Bun.build({
		entrypoints: [join(src, entry)],
		target: "browser",
		format: "iife",
		minify: false,
		sourcemap: dev ? "inline" : "none",
		define: { FIREFOX_BUILD: String(firefoxBuild) },
	});
	const [output] = result.outputs;
	if (!result.success || !output) throw new AggregateError(result.logs, `couldn't bundle ${entry}`);
	return output.text();
}

async function buildChrome(dev: boolean): Promise<Manifest> {
	rmSync(chrome, { recursive: true, force: true });
	cpSync(join(src, "icons"), join(chrome, "icons"), { recursive: true });
	for (const page of PAGES) {
		cpSync(join(src, "pages", page, "index.html"), join(chrome, `${page}.html`));
		const css = join(src, "pages", page, "index.css");
		if (existsSync(css)) cpSync(css, join(chrome, `${page}.css`));
	}
	// what the settings and setup pages share
	cpSync(join(src, "pages", "page.css"), join(chrome, "page.css"));
	await Promise.all(
		Object.entries(ENTRIES).map(async ([name, entry]) =>
			writeFileSync(join(chrome, name), await bundle(entry, { dev })),
		),
	);
	const manifest: Manifest = JSON.parse(readFileSync(join(src, "manifest.json"), "utf8"));
	writeFileSync(join(chrome, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	return manifest;
}

async function buildFirefox(chromeManifest: Manifest, dev: boolean): Promise<void> {
	const { host_permissions, action, background, permissions, optional_permissions, commands, ...rest } = chromeManifest;

	const manifest = {
		...rest,
		manifest_version: 2,
		// an event page, in place of Chrome's service worker
		background: { scripts: ["background.js"], persistent: false },
		// Firefox files new extensions under the puzzle-piece menu; put the icon
		// on the toolbar so the red no-shortcut warning is visible
		browser_action: { ...action, default_area: "navbar" },
		// no _favicon service in Firefox, so no "favicon" permission
		permissions: [...permissions.filter((p) => p !== "favicon"), ...host_permissions],
		// working across profiles (the profiles module, and the helper's
		// optional permissions) is Chrome only for now, and so is the popup's
		// switcher
		commands: Object.fromEntries(
			Object.entries(commands).filter(([name]) => !name.startsWith("profile-") && name !== "_execute_action"),
		),
		// Manifest V2 can't run a script in the page's own world, which media.js
		// needs to see a call start; Firefox knows calls by their address alone
		content_scripts: rest.content_scripts.filter((script) => script.world !== "MAIN"),
		browser_specific_settings: {
			gecko: {
				id: "tabstack@alethi.dev",
				strict_min_version: "128.0",
				data_collection_permissions: { required: ["none"] },
			},
		},
	};

	rmSync(firefox, { recursive: true, force: true });
	cpSync(chrome, firefox, {
		recursive: true,
		filter: (path) => !basename(path).startsWith(".") && !CHROME_ONLY.includes(basename(path)),
	});
	writeFileSync(
		join(firefox, "background.js"),
		await bundle(ENTRIES["background.js"] ?? "", { firefoxBuild: true, dev }),
	);
	writeFileSync(join(firefox, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

// Every file a manifest names has to be in the package.
function checkManifest(folder: string): void {
	const manifest = JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8"));
	const named: string[] = [
		manifest.background?.service_worker,
		...(manifest.background?.scripts ?? []),
		...manifest.content_scripts.flatMap((s: { js: string[] }) => s.js),
		(manifest.action ?? manifest.browser_action)?.default_popup,
		...Object.values<string>(manifest.icons ?? {}),
		...Object.values<string>((manifest.action ?? manifest.browser_action)?.default_icon ?? {}),
	].filter(Boolean);
	const missing = named.filter((file) => !existsSync(join(folder, file)));
	if (missing.length) throw new Error(`${folder}/manifest.json names files that aren't there: ${missing.join(", ")}`);
}

async function build(dev: boolean): Promise<Manifest> {
	const manifest = await buildChrome(dev);
	await buildFirefox(manifest, dev);
	checkManifest(chrome);
	checkManifest(firefox);
	return manifest;
}

// Both stores want manifest.json at the root of the zip, so zip from inside
// each folder. -X drops macOS extra attributes; dotfiles stay out. zip adds to
// an archive that's already there, keeping files since removed, so a zip of
// the same name goes first. Earlier versions' zips stay, so the one a store
// is still reviewing is kept.
function zip(folder: string, name: string): string {
	rmSync(join(dist, name), { force: true });
	execFileSync("zip", ["-r", "-X", "-q", join(dist, name), ".", "-x", ".*", "*/.*"], { cwd: folder });
	return `dist/${name}`;
}

if (process.argv.includes("--watch")) {
	let queued: ReturnType<typeof setTimeout> | undefined;
	const rebuild = async () => {
		try {
			await build(true);
			console.log(`[${new Date().toLocaleTimeString()}] built dist/chrome and dist/firefox`);
		} catch (e) {
			console.error(e);
		}
	};
	await rebuild();
	watch(src, { recursive: true }, () => {
		clearTimeout(queued);
		queued = setTimeout(rebuild, 100);
	});
	console.log("watching src/ for changes");
} else {
	const { version } = await build(false);
	console.log("built dist/chrome");
	console.log("built dist/firefox");
	console.log(`built ${zip(chrome, `tabstack-${version}-chrome.zip`)}`);
	console.log(`built ${zip(firefox, `tabstack-${version}-firefox.zip`)}`);
}
