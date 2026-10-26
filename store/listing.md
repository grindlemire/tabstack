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
- **Images:** `store/screenshot-1-cycle.png` through `screenshot-4-settings.png` (1280x800)

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

**Add-on URL:** `tabstack-switcher` (the `tabstack` address is taken)
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

### Notes for reviewers

```
The source is plain JavaScript with no bundler or minifier. The Firefox package is built by build.mjs, which copies src/ and rewrites manifest.json for Firefox (Manifest V2, an event-page background, and the gecko id). It doesn't transform any code. Source: https://github.com/grindlemire/tabstack

To try it, open a few tabs, then tap Cmd+J (Ctrl+J on Windows and Linux) to go back to the previous tab. Hold Cmd and press J repeatedly to cycle through recent tabs, and press Cmd+Shift+Space to search.

The extension uses Manifest V2 because under Manifest V3 Firefox only allows tabs.captureVisibleTab on a tab the extension was just invoked on (activeTab), even with host permissions granted. The thumbnails need captures of whichever tab the user is on, and captureTab for tabs that loaded in the background at startup.
```
