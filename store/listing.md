# Store listings

Copy for the Chrome Web Store and addons.mozilla.org (AMO). Each block in a
fence is pasted into a store form as-is. Chrome renders the description as
plain text, so the lists use hyphens rather than Markdown.

The short summary for Chrome is the manifest's `description`, so change it
in `src/manifest.json` rather than here.

## Shared fields

- **Name:** from the manifest, "tabstack: recent tab switcher"
- **Homepage:** https://tabstack.alethi.dev
- **Privacy policy:** https://tabstack.alethi.dev/privacy
- **Support email:** support@alethi.dev
- **Support URL:** https://github.com/grindlemire/tabstack/issues
- **Images** (1280x800, in this order):
  - Chrome: `screenshot-0-title.png`, `screenshot-1-cycle.png`, then `screenshot-chrome-2-search.png`, `screenshot-chrome-3-profiles.png` and `screenshot-chrome-4-settings.png`, which show working across profiles
  - Firefox: `screenshot-0-title.png`, `screenshot-1-cycle.png`, `screenshot-2-search.png`, `screenshot-3-dark.png` and `screenshot-4-settings.png`, without profiles, which Firefox doesn't have

## Chrome Web Store

**Category:** Productivity, then Tools
**Language:** English
**Store icon:** `src/icons/icon-128.png`
**Small promo tile:** `store/promo-tile-440x280.png`
**Marquee promo tile, promo video, official URL:** none
**Distribution:** free, public, all regions

### Description

```
tabstack keeps your tabs in the order you last used them and lets you move through that order from the keyboard, the way Arc's tab switcher works.

Tap Cmd+J (Ctrl+J on Windows and Linux) to jump back to the tab you were just on. Hold Cmd and press J again to go further back through your five most recent tabs, each shown as a thumbnail, then let go to switch. If you go one tab too far, Cmd+Shift+J steps forward again.

Press Cmd+Shift+Space (Ctrl+Shift+Space on Windows and Linux) on any page to search every open tab by title or address. Search matches loosely, so "gpr" finds a GitHub pull request and the typo "rainer" still finds Mount Rainier. When only one tab matches, tabstack switches to it right away. Turn on recently closed tabs in settings and they show up below your open ones, where pressing Enter on one reopens it.

While the switcher is open:
- Backspace or X closes the selected tab
- Esc cancels, and the arrow keys move the selection
- Clicking a thumbnail switches to that tab

tabstack takes a thumbnail when you visit a tab and refreshes it while you stay on that tab. Thumbnails are saved on your computer, so tabs restored after a restart still have one.

Click the toolbar icon to:
- change the switch and search shortcuts
- turn off switching when search finds a single tab
- include recently closed tabs in search
- cycle through the current window's tabs only

If you use more than one Chrome profile, an optional helper app connects tabstack in each of them. Ctrl+Cmd+Right and Left switch between profiles, search covers every profile's tabs, and links you list for a profile open there from any profile. Nothing changes unless you set it up; see https://tabstack.alethi.dev for how.

Privacy
tabstack has no servers of its own and never sends your tabs, history or settings anywhere. Your settings, tab order and thumbnails stay in the browser's extension storage on your computer, and there's no account or analytics. The optional profile helper only passes messages between tabstack in your profiles on the same computer.

Chrome doesn't let extensions draw on its own pages, such as settings, the new tab page and the Web Store. On those pages Cmd+J switches straight to your previous tab and the switcher opens there instead.
```

### Single purpose

```
Switch between recently used browser tabs from the keyboard, with thumbnails of each tab and a search over open tabs, including tabs in the user's other Chrome profiles.
```

### Permission justifications

**tabs**
```
Reads the title, address and icon of each open tab to show them in the switcher, and switches to or closes the tab the user picks.
```

**storage**
```
Saves the user's settings, the order the user last visited tabs in, and tab thumbnails, all in extension storage on the user's computer.
```

**scripting**
```
Adds the switcher to tabs that were already open when the extension is installed or updated. Chrome only runs content scripts in pages that load after installation, so without this the shortcut does nothing in those tabs until they're reloaded.
```

**favicon**
```
Shows each tab's icon in the switcher using Chrome's favicon cache, which also covers Chrome's own pages such as Settings.
```

**sessions**
```
Lists recently closed tabs in search and reopens the one the user picks. It's off until the user turns it on in the extension's settings.
```

**alarms**
```
Refreshes the thumbnail of the tab the user is looking at every 30 seconds, so the switcher shows the current state of pages that change, such as email and chat.
```

**idle**
```
Pauses the thumbnail refresh while the user is away from the computer, so the extension isn't woken up while nobody is using the browser.
```

**Host permission (all sites)**
```
The switcher is drawn over the page the user is on, which needs a content script on every site, since the user can press the shortcut anywhere. Capturing a thumbnail of the visible tab with tabs.captureVisibleTab also requires access to that page. Nothing is read from the page beyond the screenshot used for the thumbnail, and nothing leaves the user's computer.
```

**nativeMessaging** (optional)
```
Connects to an optional open-source helper app, the tabstack command, which the user installs to use tabstack across their Chrome profiles. Chrome keeps each profile's extensions apart, so the helper passes messages between tabstack in each profile, on the user's computer only. tabstack asks for this permission only when the user sets up the helper, and removes it when they turn the feature off.
```

**contextMenus** (optional)
```
Adds "Move this tab to" and "Open link in" another Chrome profile to the right-click menu. tabstack asks for it together with nativeMessaging, only when the user sets up working across profiles.
```

**Remote code:** "No, I am not using remote code." Every script ships in the
package.

### Data usage

Chrome counts data an extension keeps on the user's computer, even when it
never leaves it, so tick these two:

- **Web history:** the stack of tab titles and addresses, and recently
  closed tabs
- **Website content:** the screenshots used for thumbnails

Leave "User activity" unticked. tabstack watches for its own shortcut keys
and the modifier release but doesn't record keystrokes or clicks. The privacy
policy should say both kinds of data stay on the computer.

Tick all three certifications. tabstack doesn't sell data, doesn't use it
for anything besides switching tabs, and doesn't use it for credit or
lending decisions.

### Test instructions

```
Open a few tabs, then tap Cmd+J (Ctrl+J on Windows and Linux) to go back to the previous tab. Hold Cmd and press J repeatedly to cycle through recent tabs, and press Cmd+Shift+Space to search. No account or login is needed.

Working across Chrome profiles is optional and needs a separate helper app, the tabstack command (source: https://github.com/grindlemire/tabstack/tree/main/cmd/tabstack). Everything above works without it, and its permissions are only requested when the user sets it up.
```

## addons.mozilla.org

**Add-on URL:** `tabstack-recent-tab-switcher` (the `tabstack` address is taken)
**Category:** Tabs
**License:** MIT
**Platforms:** Firefox only, not Firefox for Android

### Summary

```
Tap Cmd+J to jump back to your last tab, hold it to flip through your recent tabs with thumbnails the way Arc does, and press Cmd+Shift+Space to search every open tab.
```

### Description

```
tabstack keeps your tabs in the order you last used them and lets you move through that order from the keyboard, the way Arc's tab switcher works.

Tap Cmd+J (Ctrl+J on Windows and Linux) to jump back to the tab you were just on. Hold Cmd and press J again to go further back through your five most recent tabs, each shown as a thumbnail, then let go to switch. If you go one tab too far, Cmd+Shift+J steps forward again.

Press Cmd+Shift+Space (Ctrl+Shift+Space on Windows and Linux) on any page to search every open tab by title or address. Search matches loosely, so "gpr" finds a GitHub pull request and the typo "rainer" still finds Mount Rainier. When only one tab matches, tabstack switches to it right away. Turn on recently closed tabs in settings and they show up below your open ones, where pressing Enter on one reopens it.

While the switcher is open:
- Backspace or X closes the selected tab
- Esc cancels, and the arrow keys move the selection
- Clicking a thumbnail switches to that tab

tabstack takes a thumbnail when you visit a tab and refreshes it while you stay on that tab. When Firefox starts, tabstack also captures any tabs that loaded in the background. Thumbnails are saved on your computer, so restored tabs still have one after a restart.

Click the toolbar icon to:
- change the switch and search shortcuts
- turn off switching when search finds a single tab
- include recently closed tabs in search
- cycle through the current window's tabs only

Privacy
tabstack has no servers of its own and never sends your tabs, history or settings anywhere. Your settings, tab order and thumbnails stay in the browser's extension storage on your computer, and there's no account or analytics.

Firefox doesn't let extensions draw on its own pages, such as about: pages and this site. On those pages Cmd+J switches straight to your previous tab and the switcher opens there instead.
```

### Release notes

The "Release notes" field when uploading a new version. Each version's covers
what changed since the one the store last had.

**1.2.0** (since 1.1.1):

```
- You can turn off Cmd+/ (search on web pages) in settings, for sites that use it themselves, like code editors. Cmd+Shift+Space still searches.
- Holding Cmd and pressing J again works when you're typing in an embedded editor, like Google Docs.
- The switcher works on pages that have a dialog open.
- Scrolling search results with the mouse reaches every result, not just the first 50.
- Screen readers announce search results.
- A web page can no longer set off tabstack's shortcuts by faking key presses, or turn tabstack off, and what you type in search no longer reaches the page.
- Thumbnails kept from earlier sessions are stored by page address without the query string.
- Chrome, across profiles: incognito tabs are never shared with other profiles, tabstack reconnects to the helper on its own, and links claimed by port or IPv6 address go to the right profile.
```

**1.1.1** (since 1.0.0):

```
- Search puts a tab that's on a call first, marked with a red microphone, then tabs playing sound. Type "call" or "sound" to find them. Firefox knows a call by its address: Google Meet, Zoom, Slack huddles and Jitsi Meet.
- Typing in search no longer sets off a site's own single-key shortcuts, like those on GitHub or YouTube.
- Search highlights the tab under the pointer, and its scrollbar matches the light or dark theme.
- Recently closed tabs no longer show up in search unless you turn them on in settings.
```

### Notes for reviewers

The first paragraph is about this version, so rewrite it for each upload; the
rest stays.

```
This update asks for no new permissions; the manifest's permissions are the same as 1.1.1's. What changed: the source is now TypeScript, bundled with Bun (source archive attached; build steps below). The content scripts ignore key and pointer events the page dispatches itself (event.isTrusted is false), and relay.js also runs in about:blank frames (match_about_blank) so a key released in an embedded editor reaches the overlay. Thumbnails kept between sessions moved from storage.local to the background's IndexedDB, keyed without query strings. A setting lets the user turn off the on-page search shortcut.

The source is TypeScript: https://github.com/grindlemire/tabstack. Each part (the background script, the content scripts and each page) is bundled into one plain script, with nothing minified and no third-party libraries; the only packages installed are build tools (TypeScript, Biome and type definitions), pinned in bun.lock. To reproduce the Firefox package, on macOS or Linux with Bun 1.3.6 and zip installed, run "bun install --frozen-lockfile" and then "bun run build" in the source folder. That writes the package to dist/firefox and zips it as dist/tabstack-<version>-firefox.zip. The build script (scripts/build.ts) builds the Chrome package in dist/chrome, copies it to dist/firefox, leaving out setup.html, setup.js and media.js, which only work in Chrome, bundles the background script again without the code for working across Chrome profiles, and rewrites manifest.json for Firefox (Manifest V2, an event-page background, and the gecko id).

To try it, open a few tabs, then tap Cmd+J (Ctrl+J on Windows and Linux) to go back to the previous tab. Hold Cmd and press J repeatedly to cycle through recent tabs, and press Cmd+Shift+Space to search. To see a call listed first, open https://meet.jit.si/any-name in a tab, then open search from another tab.

The extension uses Manifest V2 because under Manifest V3 Firefox only allows tabs.captureVisibleTab on a tab the extension was just invoked on (activeTab), even with host permissions granted. The thumbnails need captures of whichever tab the user is on, and captureTab for tabs that loaded in the background at startup.
```
