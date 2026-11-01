// Drawing a profile's mark, and the colors around it, in any tabstack page.

import type { Mark } from "./messages";

// An icon from icons.ts, by its path, in the color of the text around it.
export function iconSvg(path: string): SVGSVGElement {
	const ns = "http://www.w3.org/2000/svg";
	const svg = document.createElementNS(ns, "svg");
	svg.setAttribute("viewBox", "0 0 256 256");
	const p = document.createElementNS(ns, "path");
	p.setAttribute("d", path);
	p.setAttribute("fill", "currentColor");
	svg.append(p);
	return svg;
}

// How light a #rrggbb color looks, from 0 (black) to 1 (white).
export function lightness(color: string): number {
	const [r = 0, g = 0, b = 0] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255);
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// What's drawn on a solid mark: white, or near black on a pale color.
export const inkOn = (color: string): string => (lightness(color) > 0.7 ? "#1d1d1f" : "#fff");

// A profile's mark ({ icon or glyph, color, style }) as an element, for
// the page to size: its icon, or its letter. A solid mark is drawn on its
// color, and a clear one in it.
export function markElement(mark: Mark, path: string | null | undefined, className = ""): HTMLSpanElement {
	const node = document.createElement("span");
	node.className = `mark ${mark.style === "clear" ? "clear" : "solid"} ${className}`.trim();
	node.style.setProperty("--mark", mark.color);
	node.style.setProperty("--ink", inkOn(mark.color));
	if (path) node.append(iconSvg(path));
	else node.textContent = mark.glyph ?? "";
	return node;
}
