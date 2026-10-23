# tabstack

Arc-style tab switching for Chrome and Firefox. Your tabs form a stack, most recently used first.

- **Cmd+J** (Ctrl+J elsewhere): a quick tap swaps to your last tab. Hold Cmd and press J again to go further back through your five most recent tabs (it wraps; older tabs are for search), **Cmd+Shift+J** to step forward again, then release Cmd to switch. Thumbnails of the stack appear if you hold for longer than 120 ms.
- **Cmd+Shift+Space**: search your tabs, from any page. **Cmd+/** also searches from a web page. Type to filter, Enter to switch. When only one tab matches, it switches automatically.
- While the switcher is open:
  - **Backspace** or **X** closes the selected tab (**Cmd+Backspace** while searching).
  - The search key turns cycling into search.
  - **Esc** cancels, arrows move, and clicking a card switches.
- **Click the toolbar icon** for settings. The icon turns red if the switch shortcut isn't set, which happens when another extension already has Cmd+J.

## Load it

**Chrome:** go to `chrome://extensions`, turn on Developer mode, click "Load unpacked" and pick `src/`.

**Firefox (128+):** run `bun build.mjs`, then go to `about:debugging#/runtime/this-firefox`, click "Load Temporary Add-on" and pick `dist/firefox/manifest.json`. Rerun the build after changing `src/`.

## Release

1. Bump `version` in `src/manifest.json`. Both stores refuse an upload whose version they've already seen.
2. Run `bun build.mjs`. Besides `dist/firefox/`, it writes `dist/tabstack-<version>-chrome.zip` for the Chrome Web Store and `dist/tabstack-<version>-firefox.zip` for addons.mozilla.org.
3. Upload each zip. The listing text, permission justifications and reviewer notes are in `store/listing.md`, and the images are in `store/`.

The Firefox build is Manifest V2. Under V3, Firefox only lets an extension capture a tab it was just invoked on, so thumbnails would only come from pressing the shortcut. V2's `<all_urls>` permission can capture any tab, even background ones.

## Search

Matching works in three tiers, and the first tier with any hits wins, so a precise query isn't buried under loose matches:

1. exact substrings
2. letters in order ("gpr" finds **G**itHub **P**ull **R**equest)
3. near misses ("githb", "reqeust")

Matched letters are highlighted, and tabs playing sound show a speaker. Recently closed tabs appear below the open ones once you type, and Enter reopens them. You can turn this off in settings.

## Settings

- **Switch shortcut:** in Firefox you record it right there. Chrome has no API for this, so the button opens `chrome://extensions/shortcuts`. Whichever modifier the shortcut uses is the one whose release ends a cycle.
- **Search shortcut:** a browser shortcut like the switch one, and set the same way.
- **Search from a page:** any combination with Cmd, Ctrl or Alt. tabstack handles this one itself rather than through the browser, so it only works while a web page has keyboard focus.
- **Switch when search finds one tab**, **include recently closed tabs in search**, **cycle through this window's tabs only** (search still covers every window), and **show timings**.

## Thumbnails

- Captured when you arrive on a tab, again just before you leave it with the shortcut, and every 30 seconds while you're active on it.
- Also saved by page URL in local storage (the last 100), so tabs restored after a restart show the picture from their last visit. Incognito tabs are never saved.
- Chrome can only capture the tab on screen. Firefox also captures loaded background tabs at startup.

## Pages extensions can't touch

`chrome://` pages, the new tab page, the extension stores and `about:` pages don't run extension scripts. On those, Cmd+J switches to the previous tab straight away, and that tab's overlay carries on the cycle. If the previous tab is one of those pages too, there's no overlay: each press switches one tab further back, as long as the presses come less than 0.7 seconds apart, and the first web page it reaches shows the overlay and carries on from there. Firefox doesn't tell a page about the modifier coming up when it went down on one of those pages, so after a jump there the overlay stays hidden and gives up after a 0.7 second pause unless you press again. Search opens in the toolbar popup on these pages, or in a small centered window if the popup won't open.

## How it works

- `background.js` holds the stack, the thumbnails, favicons (drawn into 32px PNGs; Chrome's `_favicon` service covers `chrome://` pages) and recently closed tabs. It routes the shortcut.
- `content.js` runs in the top frame. It watches the modifier itself, because the commands API reports the shortcut but never the release, and it draws the switcher (`ui.js`) as a Popover in a closed shadow root. Images are drawn on canvas and the DOM is built without `innerHTML`, so a page's CSP or Trusted Types can't break it.
- `relay.js` is the only script in iframes. It forwards the modifier release and the search shortcut to the top frame.
- `switcher.js` is search on pages the overlay can't run on, shown in the toolbar popup or a window. `settings.js` is the toolbar popup the rest of the time. `shared.js` holds the settings and shortcut helpers.
- `icons/*.svg` are the icon sources. The PNGs in `src/icons/` were rendered from them.

## Still to test by hand

1. **Cmd+Shift+J in Firefox.** On macOS it is also Firefox's Browser Console shortcut, and the page may not be able to stop it.
2. **Cold worker latency (Chrome).** Turn on "Show timings", stop the worker at `chrome://serviceworker-internals`, then hold Cmd+J.
3. **Two `chrome://` pages in a row.** A tap should switch to the previous one, and quick presses should step further back.

## License

MIT, see `LICENSE`.
