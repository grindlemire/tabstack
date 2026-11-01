<p align="center">
  <img src="docs/banner.png" alt="tabstack. Arc-style tab switching for Chrome and Firefox">
</p>

tabstack orders your tabs by when you last used them, so Cmd+J always takes you back to the tab you were just on. Hold Cmd to keep going back, or search every open tab from the keyboard. It works in Chrome and Firefox, and in Zen and other browsers built on Firefox.

<p align="center">
  <img src="store/screenshot-1-cycle.png" width="720" alt="The switcher over a Wikipedia page, showing thumbnail cards of five recent tabs with the second one selected">
</p>

Install it from the [Chrome Web Store](https://chromewebstore.google.com/detail/tabstack-recent-tab-switc/midaldjfdmomndckncoafagdheghjdkl) (Chrome, Brave, Edge and other Chromium browsers) or [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/tabstack-recent-tab-switcher/) (Firefox and Zen). More at [tabstack.alethi.dev](https://tabstack.alethi.dev).

## Shortcuts

On Windows and Linux, use Ctrl in place of Cmd.

| Keys | What it does |
| --- | --- |
| Cmd+J | Switch to your last tab |
| Hold Cmd, press J again | Go further back, then let go of Cmd to switch |
| Cmd+Shift+J | Step forward again, while Cmd is still held |
| Cmd+Shift+Space | Search your open tabs |
| Cmd+/ | Search too, but only on web pages |

<p align="center">
  <img src="docs/cycle.svg" width="660" alt="A cycle through five tabs. Holding Cmd and pressing J selects B, pressing J again selects C, and letting go of Cmd switches to C, which moves to the top of the stack.">
</p>

While the switcher is open:

- **Backspace** or **X** closes the selected tab (Cmd+Backspace while searching)
- **Esc** cancels
- **Arrow keys** and **Tab** move the selection, and clicking a card switches to it

## Search

Type to filter and press Enter to switch. Search matches a tab's title, site and address, and forgives typos, so "gpr" finds **G**itHub **P**ull **R**equest and "githb" still finds GitHub. When only one tab matches, tabstack switches to it on its own.

Before you type anything, a tab on a call comes first, marked with a red microphone, then tabs playing sound. Type "call" or "sound" to find them too. Chrome knows a call by the page using your microphone or camera; Firefox knows it by the address, such as Google Meet or Zoom.

Turn on recently closed tabs in settings and they show up below your open ones, where Enter reopens one.

<p align="center">
  <img src="store/screenshot-2-search.png" width="49%" alt="Search for &quot;rainer&quot;, listing two Mount Rainier tabs with the matched letters highlighted">
  <img src="store/screenshot-3-dark.png" width="49%" alt="The switcher in dark mode over an OpenStreetMap page">
</p>

## Settings

Click the toolbar icon to change the shortcuts and a few switches:

- switch straight to the tab when search finds only one
- include recently closed tabs in search
- cycle through the current window's tabs only (search still covers every window)
- show how long each step of a switch takes, for debugging

Chrome doesn't let an extension change its own shortcuts, so there Change opens `chrome://extensions/shortcuts`. In Firefox you record the new one right in the popup. The toolbar icon turns red when another extension already has Cmd+J.

Cmd+/, search on web pages, is tabstack's own, so you record a new one in the popup in either browser. Clear turns it off, for sites that want the key themselves, like code editors that comment out a line with it.

<p align="center">
  <img src="store/screenshot-4-settings.png" width="560" alt="The settings popup, with the shortcuts drawn as keycaps above four switches">
</p>

## Browser pages

Browsers don't let extensions draw on their own pages, like `chrome://` pages and the new tab page. On those pages:

- Cmd+J still switches, but no cards appear until you reach a web page.
- Search opens in the toolbar popup.

## Chrome profiles

Chrome keeps each profile's extensions apart, so on its own tabstack only sees the tabs in the profile it's in. If you keep more than one, like Work and Personal, an optional helper, the `tabstack` command, connects tabstack in all of them:

- **Ctrl+Cmd+Right** and **Ctrl+Cmd+Left** bring the next or previous profile's window to the front. The windows stay stacked in the same place and size, so it feels like flipping between them.
- Search covers every profile's tabs, and typing a profile's name switches to it.
- Links to sites you list for a profile open there, whichever profile you click them in.
- The right-click menu moves a tab, or opens a link, in another profile.
- Opening a page that's already open in another profile offers to go there instead.
- Each profile gets an icon and a color. It replaces tabstack's toolbar icon, sits over search, and marks that profile's tabs and notices in the others.

It works in Chrome, Brave, Edge, Chromium and Vivaldi, on macOS and Linux. On Linux the profile shortcuts are Alt+Shift+Right and Alt+Shift+Left. Nothing changes until you set it up:

```sh
brew install grindlemire/tap/tabstack
tabstack install
```

`install` finds tabstack in each of your profiles and opens a tab in each, where you click Allow, name the profile and click Done. Everything else is under Profiles in tabstack's popup. The helper runs only while the browser does and makes no network requests.

From the terminal:

| Command | What it does |
| --- | --- |
| `tabstack list` | Every profile, numbered, and how it's connected |
| `tabstack connect`, `disconnect`, `reset` | Connect a profile, stop it connecting, or clear its name and links |
| `tabstack rename <profile> <name>` | Change the name other profiles show |
| `tabstack links <profile> [add\|remove <pattern>]` | The links that open in a profile |
| `tabstack tabs [<words>]` | Every profile's tabs, most recent first |
| `tabstack focus <profile> [<tab>]` | Bring a profile forward, or one of its tabs |
| `tabstack open <link>` | Open a link in the profile it belongs to |
| `tabstack doctor` | Check the setup, and fix what it can |
| `tabstack uninstall` | Disconnect every profile and unregister the helper |

A profile is its number from `list`, its name, or its folder. `tabstack completion bash|zsh|fish` prints shell completion.

## Privacy

tabstack has no servers, accounts or analytics. Your settings, the order of your tabs and their thumbnails stay in your browser's own storage, and incognito tabs are never saved. The [privacy policy](https://tabstack.alethi.dev/privacy) has the details.

## How it works

The browser tells an extension when a shortcut is pressed, but not when Cmd comes up. So tabstack draws its overlay inside the page, where it can watch the keys.

<p align="center">
  <img src="docs/how-it-works.svg" width="660" alt="The browser sends the shortcut to background.js, which sends the tabs to content.js in the page. When Cmd comes up, content.js tells background.js which tab to switch to.">
</p>

Across profiles, the browser starts the helper over native messaging for each profile's tabstack. The first copy to start becomes the hub, and the others pass their messages through it.

The extension is TypeScript with no runtime dependencies, in `src/`:

| Path | Job |
| --- | --- |
| `background/index.ts` | Tab stack, thumbnails and shortcuts |
| `background/profiles.ts` | Working across profiles (Chrome) |
| `content/index.ts`, `ui/` | The overlay in each page |
| `content/relay.ts` | Passes keys from iframes to the overlay |
| `content/media.ts` | Notices a page turning on the microphone or camera, for calls in search (Chrome) |
| `pages/switcher/` | Search on browser pages |
| `pages/settings/` | The settings popup |
| `pages/setup/` | Setting up profiles (Chrome) |
| `shared/` | Settings, shortcuts and message types every part uses, and the icons a profile can pick, from [Phosphor](https://phosphoricons.com) |

The helper is Go, in `cmd/tabstack/`.

## Development

The extension is TypeScript, in `src/`, bundled with [Bun](https://bun.sh) into one plain script for each part (`scripts/build.ts`). It has no runtime dependencies; `bun install` only fetches the build tools. Install Bun, then:

```sh
bun install
bun run dev
```

`bun run dev` builds the extension into `dist/chrome/` and `dist/firefox/`, and builds them again whenever something in `src/` changes. To load your build in place of the store version:

- **Chrome.** Open `chrome://extensions`, turn on Developer mode, click "Load unpacked" and pick `dist/chrome/`. After a rebuild, click the reload button on tabstack's card.
- **Firefox and Zen** (128 or later). Open `about:debugging#/runtime/this-firefox`, click "Load Temporary Add-on" and pick `dist/firefox/manifest.json`. After a rebuild, click Reload.

Before sending a change:

| Command | What it does |
| --- | --- |
| `bun run check` | Type-checks with TypeScript |
| `bun run lint` | Lints and checks formatting with Biome; `bun run format` fixes the formatting |
| `bun run test` | Runs the tests |

To work on the helper, run `go test ./...` and `go build` in `cmd/tabstack/`, then `./tabstack install` to register your build.

### Releasing

- **Extension.** Bump `version` in `src/manifest.json` and run `bun run build`. It writes `tabstack-<version>-chrome.zip` and `tabstack-<version>-firefox.zip` to `dist/`; upload each to its store. The listing text is in `store/listing.md`.
- **Helper.** Run `cmd/tabstack/release.sh <version>`. It builds for macOS and Linux, publishes a release on [grindlemire/homebrew-tap](https://github.com/grindlemire/homebrew-tap), and points the formula at it. `-n` stops after building.

## License

MIT, see [LICENSE](LICENSE).
