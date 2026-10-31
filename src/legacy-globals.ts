// TEMPORARY, while the rest of src/ is converted to TypeScript: the globals
// the not-yet-converted scripts share code through, made from the converted
// modules. The interim entry points import it ahead of the old script. Delete
// it once nothing reads TabstackShared, TabstackUI or TabstackIcons.

import { api, isFirefox, isMac } from "./shared/api";
import { ICONS } from "./shared/icons";
import { iconSvg, inkOn, lightness, markElement } from "./shared/marks";
import { DEFAULTS, loadSettings, onSettingsChange, watchLabel } from "./shared/settings";
import { format, fromEvent, keyName, matches } from "./shared/shortcuts";
import { rank, Switcher } from "./ui";

Object.assign(globalThis, {
	TabstackShared: {
		api,
		isMac,
		isFirefox,
		DEFAULTS,
		loadSettings,
		onSettingsChange,
		watchLabel,
		iconSvg,
		lightness,
		inkOn,
		markElement,
		matches,
		fromEvent,
		keyName,
		format,
	},
	TabstackUI: { Switcher, rank },
	TabstackIcons: ICONS,
});
