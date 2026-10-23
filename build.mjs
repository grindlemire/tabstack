// Builds the Firefox copy of the extension into dist/firefox. Chrome loads
// src/ directly.
//
// Firefox gets Manifest V2. Under V3 it only lets an extension capture a tab
// it was invoked on (activeTab), however much host access it has, so
// thumbnails would only ever come from pressing the shortcut. V2's <all_urls>
// permission captures any tab, and even background ones (tabs.captureTab).
// Usage: node build.mjs

import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const out = new URL("dist/firefox/", import.meta.url);
const { host_permissions, action, background, permissions, ...rest } = JSON.parse(
	readFileSync(new URL("src/manifest.json", import.meta.url)),
);

const manifest = {
	...rest,
	manifest_version: 2,
	// Chrome's service worker pulls in shared.js with importScripts()
	background: { scripts: ["shared.js", "background.js"], persistent: false },
	browser_action: action,
	// no _favicon service in Firefox, so no "favicon" permission
	permissions: [...permissions.filter((p) => p !== "favicon"), ...host_permissions],
	browser_specific_settings: {
		gecko: {
			id: "tabstack@alethi.dev",
			strict_min_version: "128.0",
			data_collection_permissions: { required: ["none"] },
		},
	},
};

rmSync(out, { recursive: true, force: true });
cpSync(new URL("src/", import.meta.url), out, {
	recursive: true,
	filter: (path) => !basename(path).startsWith("."),
});
writeFileSync(new URL("manifest.json", out), JSON.stringify(manifest, null, 2) + "\n");
console.log("built dist/firefox");
