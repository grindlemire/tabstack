// This profile's mark: an icon or letter in a color, as the toolbar icon.
//
// Picked on a page of its own over the settings. The mark shows large at the
// top; hovering a choice previews it there, and clicking keeps it.

import { api } from "../../shared/api";
import { ICONS } from "../../shared/icons";
import { firstGlyph, iconSvg, inkOn, markElement } from "../../shared/marks";
import type { Mark } from "../../shared/messages";
import { $ } from "../page";

// a spectrum, then the neutrals: two rows of eight
// biome-ignore format: a table, kept a few to a line
const MARK_COLORS: [string, string][] = [
	["Red", "#e5484d"], ["Orange", "#f2711c"], ["Amber", "#d99a06"], ["Lime", "#7fae1b"],
	["Green", "#30a46c"], ["Teal", "#0e9aa7"], ["Sky", "#1c9be6"], ["Blue", "#3b6cf6"],
	["Indigo", "#5b5bd6"], ["Violet", "#7c5cf0"], ["Purple", "#a34fd8"], ["Pink", "#d6409f"],
	["Brown", "#9e6a4f"], ["Gray", "#8e8e93"], ["Black", "#1d1d1f"], ["White", "#ffffff"],
];
const BLUE = "#3b6cf6";
const STYLE_NAMES: Record<string, string> = { solid: "Solid", clear: "Transparent" };

// What else each icon answers to in the picker's search, besides its name.
// biome-ignore format: a table, kept a few to a line
const ICON_WORDS: Record<string, string> = {
	house: "home personal", briefcase: "work job office business", buildings: "company office city",
	"graduation-cap": "school university study education", book: "read library study",
	chart: "graph trend stats analytics growth", dollar: "money finance bank pay",
	code: "dev developer programming brackets html", terminal: "cli shell prompt command console",
	bug: "debug beetle insect", cpu: "chip hardware computer", database: "data storage server",
	"git-branch": "github version source", "paint-brush": "art design", palette: "art design paint",
	"music-note": "song audio", flask: "science lab test experiment", lightbulb: "idea",
	"game-controller": "games gaming play", airplane: "travel flight", rocket: "launch startup space",
	lightning: "bolt fast power", fire: "flame hot", globe: "world earth web internet", planet: "space saturn",
	smiley: "happy face", chat: "message talk", envelope: "mail email", user: "person me account",
	"shopping-cart": "shop store buy", lock: "secure private", shield: "security safe",
};

// an icon's name from ICONS, which is never empty
const iconTitle = (icon: string) => icon[0]!.toUpperCase() + icon.slice(1).replaceAll("-", " ");
const colorName = (color: string) => MARK_COLORS.find(([, c]) => c === color)?.[0] ?? color;

export interface Picker {
	// Shows the stored mark, or tabstack's icon for null.
	show(mark: Mark | null): void;
	// The name changed: with no mark yet, its initial stands in.
	nameChanged(): void;
}

// The popup's part: the profile's name, for its initial, and how a page over
// the settings comes and goes.
interface Host {
	name(): string;
	openView(id: string, focus: string): void;
	closeView(id: string, opener: string): void;
}

export function initPicker(host: Host): Picker {
	// { icon or glyph, color, style: "solid" or "clear" }, or null for tabstack's own icon
	let mark: Mark | null = null;
	let previewing: Mark | null = null; // the choice under the pointer, shown at the top until it leaves

	const initial = () => firstGlyph(host.name()).toUpperCase() || "A";

	// The mark with one choice made: an icon or letter, a color, or a style.
	// With no mark yet, a color or style goes with the profile's initial.
	function withChoice(choice: Partial<Mark>): Mark {
		const base: Mark = mark ?? { glyph: initial(), color: BLUE, style: "solid" };
		const { color, style } = { ...base, ...choice };
		const shape = choice.icon || choice.glyph ? choice : base;
		return shape.icon ? { icon: shape.icon, color, style } : { glyph: shape.glyph, color, style };
	}

	// Every choice previews on hover or focus, and is kept on click.
	function choice(button: HTMLElement, pick: () => Partial<Mark>) {
		const preview = (on: boolean) => {
			previewing = on ? withChoice(pick()) : null;
			showHero();
		};
		button.addEventListener("pointerenter", () => preview(true));
		button.addEventListener("pointerleave", () => preview(false));
		button.addEventListener("focus", () => preview(true));
		button.addEventListener("blur", () => preview(false));
		button.addEventListener("click", () => {
			previewing = null;
			saveMark(withChoice(pick()));
		});
	}

	// Built once, and filtered by the search: a letter, when one's typed, then
	// every icon.
	const letterChoice = document.createElement("button");
	choice(letterChoice, () => ({ glyph: letterChoice.textContent }));
	const iconChoices = Object.entries(ICONS).map(([icon, path]) => {
		const button = document.createElement("button");
		button.title = icon.replaceAll("-", " ");
		button.setAttribute("aria-label", button.title);
		button.append(iconSvg(path));
		choice(button, () => ({ icon }));
		return { icon, button, words: `${button.title} ${ICON_WORDS[icon] ?? ""}`.split(/\s+/).filter(Boolean) };
	});
	$("mark-glyphs").append(letterChoice, ...iconChoices.map((c) => c.button));

	const swatches = MARK_COLORS.map(([name, color]) => {
		const button = document.createElement("button");
		button.style.setProperty("--swatch", color);
		button.title = name;
		button.setAttribute("aria-label", name);
		choice(button, () => ({ color }));
		return [color, button] as const;
	});
	$("mark-colors").append(...swatches.map(([, button]) => button));

	for (const button of document.querySelectorAll<HTMLElement>("[data-style]"))
		choice(button, () => ({ style: button.dataset.style as Mark["style"] }));

	// The top of the picker: what's under the pointer, or what's picked. It's
	// redrawn, and pops, only when that changes.
	let heroShown: string | undefined;
	function showHero() {
		const shown = previewing ?? mark;
		const key = JSON.stringify(shown);
		if (key === heroShown) return;
		heroShown = key;
		if (!shown) {
			$("mark-big").replaceChildren(
				Object.assign(document.createElement("img"), { src: "icons/icon-48.png", alt: "" }),
			);
			$("mark-title").textContent = "tabstack's icon";
			$("mark-subtitle").textContent = "Pick an icon or a color below";
			return;
		}
		$("mark-big").replaceChildren(markElement(shown, ICONS[shown.icon ?? ""]));
		$("mark-title").textContent = shown.icon ? iconTitle(shown.icon) : `Letter ${shown.glyph}`;
		$("mark-subtitle").textContent = `${STYLE_NAMES[shown.style ?? ""] ?? "Solid"} · ${colorName(shown.color)}`;
	}

	function showMark() {
		$("mark-preview").replaceChildren(
			mark
				? markElement(mark, ICONS[mark.icon ?? ""])
				: Object.assign(document.createElement("span"), { className: "mark empty", textContent: initial() }),
		);
		$("mark-remove").hidden = !mark;
		showHero();

		const style = mark?.style === "clear" ? "clear" : "solid";
		for (const button of document.querySelectorAll<HTMLElement>("[data-style]")) {
			button.setAttribute("aria-checked", String(!!mark && button.dataset.style === style));
		}
		const grid = $("mark-glyphs");
		grid.className = `glyphs ${style}`;
		if (mark) {
			grid.style.setProperty("--mark", mark.color);
			grid.style.setProperty("--ink", inkOn(mark.color));
		}
		letterChoice.setAttribute("aria-pressed", String(!!mark?.glyph && letterChoice.textContent === mark.glyph));
		for (const { icon, button } of iconChoices) button.setAttribute("aria-pressed", String(icon === mark?.icon));
		for (const [color, button] of swatches) button.setAttribute("aria-pressed", String(color === mark?.color));
	}

	function saveMark(next: Mark | null) {
		mark = next;
		showMark();
		if (next) api.storage.sync.set({ profileMark: next });
		else api.storage.sync.remove("profileMark");
	}

	// Every word typed has to start a word of an icon's name, or of the words it
	// answers to. A single letter or number can be the mark itself; an emoji
	// can't, since it doesn't draw cleanly at toolbar size.
	function filterIcons() {
		const query = $<HTMLInputElement>("mark-search").value.trim();
		const words = query.toLowerCase().split(/\s+/).filter(Boolean);
		let shown = 0;
		for (const { button, words: theirs } of iconChoices) {
			button.hidden = !words.every((w) => theirs.some((t) => t.startsWith(w)));
			if (!button.hidden) shown++;
		}
		const glyph = firstGlyph(query);
		const isLetter = !!query && glyph === query && !/\p{Extended_Pictographic}/u.test(glyph);
		letterChoice.hidden = !isLetter;
		if (isLetter) {
			letterChoice.textContent = glyph;
			letterChoice.setAttribute("aria-label", `Letter ${glyph}`);
		}
		$("mark-empty").hidden = shown > 0 || isLetter;
		showMark();
	}

	function openPicker() {
		$<HTMLInputElement>("mark-search").value = "";
		filterIcons();
		host.openView("mark-view", "mark-search");
	}

	function closePicker() {
		previewing = null;
		host.closeView("mark-view", "mark-open");
	}

	$("mark-open").addEventListener("click", openPicker);
	$("mark-back").addEventListener("click", closePicker);
	$("mark-remove").addEventListener("click", () => saveMark(null));
	$("mark-search").addEventListener("input", filterIcons);
	$("mark-search").addEventListener("keydown", (e) => {
		if (e.key !== "Enter") return;
		// the first match: the letter, when one's typed, or the first icon
		$("mark-glyphs").querySelector<HTMLButtonElement>("button:not([hidden])")?.click();
	});
	$("mark-view").addEventListener("keydown", (e) => {
		if (e.key !== "Escape") return;
		e.preventDefault();
		if ($<HTMLInputElement>("mark-search").value) {
			$<HTMLInputElement>("mark-search").value = "";
			filterIcons();
		} else {
			closePicker();
		}
	});

	return {
		show(next) {
			mark = next;
			showMark();
		},
		nameChanged() {
			if (!mark) showMark();
		},
	};
}
