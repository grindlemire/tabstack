// TEMPORARY entry point, until background.js and profiles.js are converted:
// bundles them, in order, after the globals they read.
import "../legacy-globals";

declare const require: (path: string) => void;
// Working across profiles is Chrome only for now; the Firefox build leaves it out.
if (!FIREFOX_BUILD) require("../profiles.js");
require("../background.js");
