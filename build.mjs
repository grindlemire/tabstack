// Builds the Firefox copy of the extension into dist/firefox, then zips both
// browsers' packages for the stores. Chrome loads src/ directly.
//
// Firefox gets Manifest V2. Under V3 it only lets an extension capture a tab
// it was invoked on (activeTab), however much host access it has, so
// thumbnails would only ever come from pressing the shortcut. V2's <all_urls>
// permission captures any tab, and even background ones (tabs.captureTab).
//
// Usage: bun build.mjs (node build.mjs works too; it only uses built-ins)
//   dist/firefox/                     unpacked Firefox build, for about:debugging
//   dist/tabstack-<version>-chrome.zip   upload to the Chrome Web Store
//   dist/tabstack-<version>-firefox.zip  upload to addons.mozilla.org

import { execFileSync } from "node:child_process";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

// Plain string paths: Bun hands cpSync's filter URL objects when given URLs.
const root = fileURLToPath(new URL(".", import.meta.url));
const dist = join(root, "dist");
const src = join(root, "src");
const firefox = join(dist, "firefox");
const chromeManifest = JSON.parse(readFileSync(join(src, "manifest.json")));
const { host_permissions, action, background, permissions, optional_permissions, commands, ...rest } = chromeManifest;

const manifest = {
	...rest,
	manifest_version: 2,
	// Chrome's service worker pulls in shared.js with importScripts()
	background: { scripts: ["shared.js", "background.js"], persistent: false },
	// Firefox files new extensions under the puzzle-piece menu; put the icon
	// on the toolbar so the red no-shortcut warning is visible
	browser_action: { ...action, default_area: "navbar" },
	// no _favicon service in Firefox, so no "favicon" permission
	permissions: [...permissions.filter((p) => p !== "favicon"), ...host_permissions],
	// working across profiles (profiles.js, and the helper's optional
	// permissions) is Chrome only for now
	commands: Object.fromEntries(Object.entries(commands).filter(([name]) => !name.startsWith("profile-"))),
	browser_specific_settings: {
		gecko: {
			id: "tabstack@alethi.dev",
			strict_min_version: "128.0",
			data_collection_permissions: { required: ["none"] },
		},
	},
};

const CHROME_ONLY = ["profiles.js", "setup.html", "setup.js"];

rmSync(dist, { recursive: true, force: true });
cpSync(src, firefox, {
	recursive: true,
	filter: (path) => !basename(path).startsWith(".") && !CHROME_ONLY.includes(basename(path)),
});
writeFileSync(join(firefox, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

// Both stores want manifest.json at the root of the zip, so zip from inside
// each folder. -X drops macOS extra attributes; dotfiles stay out.
function zip(folder, name) {
	execFileSync("zip", ["-r", "-X", "-q", join(dist, name), ".", "-x", ".*", "*/.*"], { cwd: folder });
	return `dist/${name}`;
}

const { version } = chromeManifest;
console.log(`built dist/firefox`);
console.log(`built ${zip(src, `tabstack-${version}-chrome.zip`)}`);
console.log(`built ${zip(firefox, `tabstack-${version}-firefox.zip`)}`);
