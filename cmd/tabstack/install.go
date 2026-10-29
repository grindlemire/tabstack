package main

import (
	"cmp"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"time"
)

// hostName is the name browsers know the helper by.
const hostName = "dev.alethi.tabstack"

// waitFor bounds how long install waits for each profile to connect.
const waitFor = 3 * time.Minute

// prefsDelay is about how long a browser takes to save a change to its
// preferences, like an extension just installed.
const prefsDelay = 15 * time.Second

// browser is a Chromium browser the helper can register with. Each looks for
// native messaging manifests in a NativeMessagingHosts folder inside its user
// data directory, which also holds its profiles.
type browser struct {
	name    string
	dataDir string
	exe     string   // the browser's executable: a path on macOS, a command on Linux
	args    []string // to start it with, before the rest
}

func (b browser) manifest() string {
	return filepath.Join(b.dataDir, "NativeMessagingHosts", hostName+".json")
}

// installed reports whether the browser has been run on this machine.
func (b browser) installed() bool {
	info, err := os.Stat(b.dataDir)
	return err == nil && info.IsDir()
}

func knownBrowsers(home string) []browser {
	// "name;data dir;executable" stands in for them all, for end-to-end tests,
	// started on that data dir rather than the browser's own
	if spec := strings.SplitN(os.Getenv("TABSTACK_TEST_BROWSER"), ";", 3); len(spec) == 3 {
		return []browser{{spec[0], spec[1], spec[2], []string{"--user-data-dir=" + spec[1]}}}
	}
	switch runtime.GOOS {
	case "darwin":
		as := filepath.Join(home, "Library", "Application Support")
		app := func(name string) string { return filepath.Join(name+".app", "Contents", "MacOS", name) }
		return []browser{
			{"Google Chrome", filepath.Join(as, "Google", "Chrome"), app("Google Chrome"), nil},
			{"Google Chrome Beta", filepath.Join(as, "Google", "Chrome Beta"), app("Google Chrome Beta"), nil},
			{"Google Chrome Canary", filepath.Join(as, "Google", "Chrome Canary"), app("Google Chrome Canary"), nil},
			{"Brave", filepath.Join(as, "BraveSoftware", "Brave-Browser"), app("Brave Browser"), nil},
			{"Microsoft Edge", filepath.Join(as, "Microsoft Edge"), app("Microsoft Edge"), nil},
			{"Chromium", filepath.Join(as, "Chromium"), app("Chromium"), nil},
			{"Vivaldi", filepath.Join(as, "Vivaldi"), app("Vivaldi"), nil},
		}
	case "linux":
		cfg := filepath.Join(home, ".config")
		return []browser{
			{"Google Chrome", filepath.Join(cfg, "google-chrome"), "google-chrome", nil},
			{"Google Chrome Beta", filepath.Join(cfg, "google-chrome-beta"), "google-chrome-beta", nil},
			{"Brave", filepath.Join(cfg, "BraveSoftware", "Brave-Browser"), "brave-browser", nil},
			{"Microsoft Edge", filepath.Join(cfg, "microsoft-edge"), "microsoft-edge", nil},
			{"Chromium", filepath.Join(cfg, "chromium"), "chromium", nil},
			{"Vivaldi", filepath.Join(cfg, "vivaldi"), "vivaldi", nil},
		}
	}
	return nil
}

// profile is one of a browser's profiles.
type profile struct {
	dir     string // its folder in the user data directory, like "Profile 1"
	name    string // what the browser calls it
	id      string // tabstack's extension ID there, if it's installed
	granted bool   // tabstack has the helper's permission now
}

// key names a profile across browsers, matching what the extension reports
// once connected (the setup page passes it on).
func (b browser) key(p profile) string {
	return b.name + "/" + p.dir
}

// profiles lists the browser's profiles, and finds tabstack in each from its
// preferences. Their names are in the Local State file, which the browser
// saves some seconds after a change, so a profile folder it doesn't list yet
// still counts, named after its folder.
func profiles(b browser) ([]profile, error) {
	var state struct {
		Profile struct {
			InfoCache map[string]struct {
				Name string `json:"name"`
			} `json:"info_cache"`
		} `json:"profile"`
	}
	if raw, err := os.ReadFile(filepath.Join(b.dataDir, "Local State")); err == nil {
		if err := json.Unmarshal(raw, &state); err != nil {
			return nil, fmt.Errorf("reading %s's Local State: %w", b.name, err)
		}
	}
	names := map[string]string{}
	for dir, info := range state.Profile.InfoCache {
		names[dir] = info.Name
	}
	folders, _ := filepath.Glob(filepath.Join(b.dataDir, "*", "Preferences"))
	for _, prefs := range folders {
		dir := filepath.Base(filepath.Dir(prefs))
		if _, ok := names[dir]; !ok && (dir == "Default" || strings.HasPrefix(dir, "Profile ")) {
			names[dir] = dir
		}
	}

	var list []profile
	for dir, name := range names {
		p := profile{dir: dir, name: cmp.Or(name, dir)}
		p.id, p.granted = findTabstack(filepath.Join(b.dataDir, dir))
		list = append(list, p)
	}
	slices.SortFunc(list, func(a, b profile) int { return compareDirs(a.dir, b.dir) })
	return list, nil
}

// compareDirs puts "Default" first, then "Profile 2" before "Profile 10".
func compareDirs(a, b string) int {
	switch {
	case a == b:
		return 0
	case a == "Default":
		return -1
	case b == "Default":
		return 1
	case len(a) != len(b):
		return len(a) - len(b)
	}
	return strings.Compare(a, b)
}

type extensionSettings struct {
	Path          string          `json:"path"`
	State         *int            `json:"state"`
	DisableReason json.RawMessage `json:"disable_reasons"`
	// What the extension has now. Not granted_permissions: Chrome keeps a
	// permission there after it's removed, so asking again needs no prompt.
	Active struct {
		API []string `json:"api"`
	} `json:"active_permissions"`
}

// findTabstack looks for an enabled tabstack in a profile's preferences
// (Secure Preferences, or Preferences in older browsers), going by the name
// in its manifest, so the Web Store build and an unpacked copy both count.
func findTabstack(profileDir string) (id string, granted bool) {
	settings := map[string]extensionSettings{}
	for _, file := range []string{"Preferences", "Secure Preferences"} {
		raw, err := os.ReadFile(filepath.Join(profileDir, file))
		if err != nil {
			continue
		}
		var prefs struct {
			Extensions struct {
				Settings map[string]extensionSettings `json:"settings"`
			} `json:"extensions"`
		}
		if json.Unmarshal(raw, &prefs) == nil {
			for k, v := range prefs.Extensions.Settings {
				settings[k] = v
			}
		}
	}
	ids := make([]string, 0, len(settings))
	for k := range settings {
		ids = append(ids, k)
	}
	slices.Sort(ids)
	for _, k := range ids {
		s := settings[k]
		if s.Path == "" || disabled(s) {
			continue
		}
		dir := s.Path
		if !filepath.IsAbs(dir) {
			dir = filepath.Join(profileDir, "Extensions", dir)
		}
		raw, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
		if err != nil {
			continue
		}
		var m struct {
			Name string `json:"name"`
		}
		if json.Unmarshal(raw, &m) == nil && strings.HasPrefix(strings.ToLower(m.Name), "tabstack") {
			return k, slices.Contains(s.Active.API, "nativeMessaging")
		}
	}
	return "", false
}

// disabled reads both ways browsers have recorded it: a list of reasons, or
// a bitmask, in newer ones, and state 0 in older ones.
func disabled(s extensionSettings) bool {
	if s.State != nil && *s.State == 0 {
		return true
	}
	r := strings.TrimSpace(string(s.DisableReason))
	return r != "" && r != "null" && r != "[]" && r != "0"
}

type hostManifest struct {
	Name           string   `json:"name"`
	Description    string   `json:"description"`
	Path           string   `json:"path"`
	Type           string   `json:"type"`
	AllowedOrigins []string `json:"allowed_origins"`
}

func writeHostManifest(b browser, exe string, ids []string) error {
	m := hostManifest{
		Name:        hostName,
		Description: "tabstack: works across browser profiles",
		Path:        exe,
		Type:        "stdio",
	}
	for _, id := range ids {
		m.AllowedOrigins = append(m.AllowedOrigins, "chrome-extension://"+id+"/")
	}
	return saveHostManifest(b, m)
}

// saveHostManifest writes the manifest whole, by renaming a new file over
// the old one, since the browser can read it at any time.
func saveHostManifest(b browser, m hostManifest) error {
	raw, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(b.manifest()), 0o755); err != nil {
		return err
	}
	tmp := b.manifest() + ".new"
	if err := os.WriteFile(tmp, append(raw, '\n'), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, b.manifest())
}

// readHostManifest reads the helper's registration with a browser; nil when
// it isn't registered there.
func readHostManifest(b browser) (*hostManifest, error) {
	raw, err := os.ReadFile(b.manifest())
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var m hostManifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("%s: %w", b.manifest(), err)
	}
	return &m, nil
}

// extensionIDs are the copies of tabstack a registration lets in.
func (m hostManifest) extensionIDs() []string {
	var ids []string
	for _, o := range m.AllowedOrigins {
		ids = append(ids, strings.TrimSuffix(strings.TrimPrefix(o, "chrome-extension://"), "/"))
	}
	return ids
}

// repair points the helper's registration with each browser at this binary,
// by a path that lasts, where it points at one that's gone or at this one by
// a path that won't last (an older install from Homebrew's versioned
// folder). One pointing at another copy that's still there is left alone. It
// returns what it changed.
func repair(home string) ([]string, error) {
	self, err := selfPath()
	if err != nil {
		return nil, err
	}
	want := lastingPath(self)
	var fixed []string
	for _, b := range knownBrowsers(home) {
		m, err := readHostManifest(b)
		if err != nil || m == nil || m.Path == want {
			continue
		}
		if fileExists(m.Path) && !sameFile(m.Path, self) {
			continue
		}
		was := m.Path
		m.Path = want
		if err := saveHostManifest(b, *m); err != nil {
			return fixed, fmt.Errorf("registering with %s: %w", b.name, err)
		}
		fixed = append(fixed, fmt.Sprintf("%s: pointed at %s, now %s", b.name, was, want))
	}
	return fixed, nil
}

// target is a profile install sets up.
type target struct {
	b browser
	p profile
}

// install finds tabstack in every profile of every browser here, registers
// the helper for it, and opens tabstack's setup page in each profile that
// isn't connected yet, where one click allows it. Then it waits for them.
// extraIDs are allowed too, for a copy of tabstack it can't find.
func install(w io.Writer, extraIDs []string) error {
	exe, err := helperPath()
	if err != nil {
		return err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	browsers := knownBrowsers(home)
	if browsers == nil {
		return fmt.Errorf("the helper doesn't run on %s yet", runtime.GOOS)
	}

	targets, missing, err := register(w, browsers, exe, extraIDs)
	if err != nil {
		return err
	}
	if len(targets) == 0 {
		// tabstack installed a moment ago isn't in the browser's preferences
		// until it saves them, some seconds later
		fmt.Fprintln(w, "Looking for tabstack…")
		for end := time.Now().Add(prefsDelay); len(targets) == 0 && time.Now().Before(end); {
			time.Sleep(time.Second)
			if targets, missing, err = register(io.Discard, browsers, exe, extraIDs); err != nil {
				return err
			}
		}
		if len(targets) > 0 {
			register(w, browsers, exe, extraIDs)
		}
	}
	if len(targets) == 0 {
		return errors.New("tabstack isn't installed in any profile. Install it in each profile you use, then run this again")
	}
	err = connectAll(w, home, targets)
	for _, t := range missing {
		fmt.Fprintf(w, "tabstack isn't installed in %s. Install it there, then run tabstack connect %q.\n", t.p.name, t.p.dir)
	}
	return err
}

// register finds tabstack in each browser's profiles, registers the helper
// with every browser that has it, and lists what it found: the profiles with
// tabstack, and those without it in a browser that has it somewhere.
func register(w io.Writer, browsers []browser, exe string, extraIDs []string) (targets, missing []target, err error) {
	for _, b := range browsers {
		if !b.installed() {
			continue
		}
		list, err := profiles(b)
		if err != nil {
			fmt.Fprintf(w, "%s: %v\n", b.name, err)
			continue
		}
		var ids []string
		for _, p := range list {
			if p.id != "" && !slices.Contains(ids, p.id) {
				ids = append(ids, p.id)
			}
		}
		if len(ids) == 0 && len(extraIDs) == 0 {
			continue
		}
		if err := writeHostManifest(b, exe, append(ids, extraIDs...)); err != nil {
			return nil, nil, fmt.Errorf("registering with %s: %w", b.name, err)
		}
		fmt.Fprintf(w, "%s\n", b.name)
		for _, p := range list {
			note := "tabstack isn't installed here"
			if p.id != "" {
				note = "found tabstack"
				targets = append(targets, target{b, p})
			} else {
				missing = append(missing, target{b, p})
			}
			fmt.Fprintf(w, "  %-28s %s\n", p.name, note)
		}
	}
	return targets, missing, nil
}

// connectAll sets up each profile that isn't connected yet, one at a time:
// it opens tabstack's setup page in a profile, which brings that profile's
// window forward, and waits there for Allow (unless it's allowed already) and
// then Done, once the profile's been named, before moving on to the next.
func connectAll(w io.Writer, home string, targets []target) error {
	dir, err := hubDir()
	if err != nil {
		return err
	}
	connected := connectedProfiles(dir)
	var waiting []target
	for _, t := range targets {
		if _, ok := connected[t.b.key(t.p)]; !ok {
			waiting = append(waiting, t)
		}
	}
	if len(waiting) == 0 {
		fmt.Fprintln(w, "\nEvery profile with tabstack is already connected.")
		return nil
	}

	// tells this run's Done apart from an earlier one's
	run := rand.Text()
	fmt.Fprintln(w, "\nSetting up each profile in turn. In the tab that opens, click Allow and accept Chrome's prompt, then name the profile and click Done.")
	var missed []target
	for _, t := range waiting {
		key := t.b.key(t.p)
		if err := openSetup(home, t, run); err != nil {
			fmt.Fprintf(w, "  couldn't open %s: %v\n  open tabstack's setup page there yourself: click its toolbar icon, then Set up\n", t.p.name, err)
			missed = append(missed, t)
			continue
		}
		fmt.Fprintf(w, "  %s: waiting for Allow…\n", t.p.name)
		peer, ok := waitForPeer(dir, key, func(hubPeer) bool { return true })
		if !ok {
			fmt.Fprintf(w, "  %s didn't connect; moving on.\n", t.p.name)
			missed = append(missed, t)
			continue
		}
		fmt.Fprintf(w, "  %s: connected, waiting for Done…\n", cmp.Or(peer.Info.Name, t.p.name))
		if peer.Info.Done == nil {
			// Chrome keeps running the background code tabstack started with,
			// until it's reloaded, and that code predates Done
			fmt.Fprintf(w, "  %s is running an older tabstack that can't report Done. Reload it on chrome://extensions in that profile.\n", t.p.name)
		}
		peer, ok = waitForPeer(dir, key, func(p hubPeer) bool { return p.Info.Done != nil && *p.Info.Done == run })
		if !ok {
			fmt.Fprintf(w, "  %s is connected, but Done wasn't clicked; moving on.\n", t.p.name)
			continue
		}
		fmt.Fprintf(w, "  ✓ %s\n", cmp.Or(peer.Info.Name, t.p.name))
	}
	if len(missed) > 0 {
		for _, t := range missed {
			fmt.Fprintf(w, "%s isn't connected. Run tabstack connect %q to try again.\n", t.p.name, t.p.dir)
		}
		return errors.New("not every profile connected")
	}
	keys := "⌃⌘→ and ⌃⌘←"
	if runtime.GOOS != "darwin" {
		keys = "Alt+Shift+→ and Alt+Shift+←"
	}
	fmt.Fprintf(w, "\nAll set. Switch profiles with %s, and find the rest under Profiles in tabstack's toolbar popup.\n", keys)
	return nil
}

// waitForPeer waits until the profile at key is connected and ready says
// it's what install is waiting for, or the time's up.
func waitForPeer(dir, key string, ready func(hubPeer) bool) (hubPeer, bool) {
	for end := time.Now().Add(waitFor); time.Now().Before(end); time.Sleep(300 * time.Millisecond) {
		if p, ok := connectedProfiles(dir)[key]; ok && ready(p) {
			return p, true
		}
	}
	return hubPeer{}, false
}

// openSetup opens tabstack's setup page in one profile, telling it which
// profile it's in and what the browser calls it.
func openSetup(home string, t target, run string) error {
	q := url.Values{"where": {t.b.key(t.p)}, "name": {t.p.name}, "run": {run}}
	page := fmt.Sprintf("chrome-extension://%s/setup.html?%s", t.p.id, q.Encode())
	exe, err := findExe(home, t.b.exe)
	if err != nil {
		return err
	}
	return start(exe, append(t.b.args, "--profile-directory="+t.p.dir, page)...)
}

func findExe(home, exe string) (string, error) {
	if filepath.IsAbs(exe) {
		return exe, nil
	}
	if runtime.GOOS != "darwin" {
		return exec.LookPath(exe)
	}
	for _, apps := range []string{"/Applications", filepath.Join(home, "Applications")} {
		if path := filepath.Join(apps, exe); fileExists(path) {
			return path, nil
		}
	}
	return "", fmt.Errorf("can't find %s", exe)
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// uninstall disconnects every profile it can reach, then unregisters the
// helper from every browser.
func uninstall(w io.Writer) error {
	stillOn, err := disconnect(w, nil, true)
	if err != nil {
		return err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	for _, b := range knownBrowsers(home) {
		if err := os.Remove(b.manifest()); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	fmt.Fprintln(w, "The helper is unregistered.")
	if stillOn == 0 {
		fmt.Fprintln(w, "Profile features are off in every profile.")
	}
	return nil
}
