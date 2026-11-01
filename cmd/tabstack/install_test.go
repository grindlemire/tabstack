package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func writeJSON(t *testing.T, path string, v any) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(v)
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		t.Fatal(err)
	}
}

// A browser's data folder with three profiles: tabstack from the Web Store
// (allowed to reach the helper), tabstack unpacked but turned off, and an
// unpacked copy alongside another extension.
func TestProfiles(t *testing.T) {
	data := t.TempDir()
	unpacked := t.TempDir()
	writeJSON(t, filepath.Join(unpacked, "manifest.json"), map[string]any{"name": "tabstack: recent tab switcher"})
	writeJSON(t, filepath.Join(data, "Local State"), map[string]any{
		"profile": map[string]any{"info_cache": map[string]any{
			"Profile 10": map[string]any{"name": "Side"},
			"Default":    map[string]any{"name": "Personal"},
			"Profile 2":  map[string]any{"name": "Work"},
		}},
	})

	// Default: the Web Store build, under the profile's Extensions folder
	writeJSON(t, filepath.Join(data, "Default", "Extensions", storeID, "1.0.0_0", "manifest.json"), map[string]any{"name": "tabstack: recent tab switcher"})
	writeJSON(t, filepath.Join(data, "Default", "Secure Preferences"), map[string]any{"extensions": map[string]any{"settings": map[string]any{
		storeID: map[string]any{"path": storeID + "/1.0.0_0", "location": 1, "active_permissions": map[string]any{"api": []string{"tabs", "nativeMessaging"}}},
	}}})
	// Profile 2: unpacked but turned off, so it doesn't count
	writeJSON(t, filepath.Join(data, "Profile 2", "Secure Preferences"), map[string]any{"extensions": map[string]any{"settings": map[string]any{
		unpackedID: map[string]any{"path": unpacked, "location": locationUnpacked, "disable_reasons": []int{1}},
	}}})
	// Profile 10: tabstack unpacked beside another extension, in the older
	// Preferences file. It had the helper's permission once, which Chrome
	// keeps in granted_permissions after it's removed, but it isn't active,
	// so tabstack's found there but not granted.
	other := t.TempDir()
	writeJSON(t, filepath.Join(other, "manifest.json"), map[string]any{"name": "Some other extension"})
	writeJSON(t, filepath.Join(data, "Profile 10", "Preferences"), map[string]any{"extensions": map[string]any{"settings": map[string]any{
		"aaaother": map[string]any{"path": other},
		unpackedID: map[string]any{
			"path":                unpacked,
			"location":            locationUnpacked,
			"disable_reasons":     []int{},
			"granted_permissions": map[string]any{"api": []string{"nativeMessaging"}},
			"active_permissions":  map[string]any{"api": []string{"tabs"}},
		},
	}}})

	got, err := profiles(browser{name: "Test", dataDir: data})
	if err != nil {
		t.Fatal(err)
	}
	want := []profile{
		{dir: "Default", name: "Personal", id: storeID, granted: true},
		{dir: "Profile 2", name: "Work"},
		{dir: "Profile 10", name: "Side", id: unpackedID},
	}
	if !slices.Equal(got, want) {
		t.Errorf("profiles =\n  %+v\nwant\n  %+v", got, want)
	}
}

const (
	unpackedID  = "abcdefghijklmnopabcdefghijklmnop"
	lookalikeID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" // sorts before the others
)

// ext is an extension in a profile, as findTabstack sees it.
type ext struct {
	id       string
	name     string // in its manifest
	location int    // 1 from a store, 4 unpacked, 8 from --load-extension
	off      bool
	granted  bool
}

// Only the Web Store build, by its ID, and copies loaded unpacked, by their
// name, are tabstack. Anything else could be anyone's, and what's found gets
// to read and close tabs in every profile.
func TestFindTabstack(t *testing.T) {
	for _, c := range []struct {
		name        string
		exts        []ext
		want        string
		wantGranted bool
	}{
		{"the store build", []ext{{id: storeID, name: extensionName, location: 1, granted: true}}, storeID, true},
		{"the store build, whatever it's called", []ext{{id: storeID, name: "__MSG_name__", location: 1}}, storeID, false},
		{"unpacked", []ext{{id: unpackedID, name: extensionName, location: 4, granted: true}}, unpackedID, true},
		{"from --load-extension", []ext{{id: unpackedID, name: extensionName, location: 8}}, unpackedID, false},
		{"turned off", []ext{{id: storeID, name: extensionName, location: 1, off: true}}, "", false},
		{"a lookalike from a store", []ext{{id: lookalikeID, name: "TabStack Pro", location: 1}}, "", false},
		{"tabstack's name, from a store", []ext{{id: lookalikeID, name: extensionName, location: 1}}, "", false},
		{"unpacked, named like tabstack", []ext{{id: lookalikeID, name: "tabstack: recent tab switcher pro", location: 4}}, "", false},
		{"unpacked, with no location", []ext{{id: unpackedID, name: extensionName}}, "", false},
		{"unpacked, under an ID that isn't one", []ext{{id: "unpackedid", name: extensionName, location: 4}}, "", false},
		{"a lookalike sorted first doesn't shadow it", []ext{
			{id: lookalikeID, name: "TabStack Pro", location: 1, granted: true},
			{id: storeID, name: extensionName, location: 1},
		}, storeID, false},
		{"unpacked beside the store's", []ext{
			{id: storeID, name: extensionName, location: 1, granted: true},
			{id: unpackedID, name: extensionName, location: 4},
		}, unpackedID, false},
		{"unpacked but off, beside the store's", []ext{
			{id: storeID, name: extensionName, location: 1, granted: true},
			{id: unpackedID, name: extensionName, location: 4, off: true},
		}, storeID, true},
	} {
		t.Run(c.name, func(t *testing.T) {
			dir := t.TempDir()
			settings := map[string]any{}
			for _, e := range c.exts {
				// a store's under the profile's Extensions folder, by a path
				// relative to it; an unpacked one wherever it was loaded from
				path := e.id + "/1.0.0_0"
				manifest := filepath.Join(dir, "Extensions", path, "manifest.json")
				if e.location != 1 {
					path = filepath.Join(t.TempDir(), "src")
					manifest = filepath.Join(path, "manifest.json")
				}
				writeJSON(t, manifest, map[string]any{"name": e.name})
				s := map[string]any{"path": path}
				if e.location != 0 {
					s["location"] = e.location
				}
				if e.off {
					s["disable_reasons"] = []int{1}
				}
				if e.granted {
					s["active_permissions"] = map[string]any{"api": []string{"nativeMessaging"}}
				}
				settings[e.id] = s
			}
			writeJSON(t, filepath.Join(dir, "Secure Preferences"), map[string]any{"extensions": map[string]any{"settings": settings}})
			if id, granted := findTabstack(dir); id != c.want || granted != c.wantGranted {
				t.Errorf("findTabstack = %q, %v; want %q, %v", id, granted, c.want, c.wantGranted)
			}
		})
	}
}

// An unpacked copy is known by the name in tabstack's manifest.
func TestExtensionName(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "src", "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	var m struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	if m.Name != extensionName {
		t.Errorf("src/manifest.json names tabstack %q, but install looks for %q", m.Name, extensionName)
	}
}

// install lets in an ID it's given only if it's one.
func TestExtensionIDFlag(t *testing.T) {
	for _, id := range []string{
		"",
		"abc",
		"abcdefghijklmnopabcdefghijklmno",   // 31
		"abcdefghijklmnopabcdefghijklmnopa", // 33
		"qbcdefghijklmnopabcdefghijklmnop",  // q is past p
		"ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP",
		"chrome-extension://" + storeID + "/",
		storeID + "/",
		storeID + "\n",
	} {
		err := run([]string{"install", "--extension-id", id}, io.Discard)
		if err == nil || !strings.Contains(err.Error(), "32 letters from a to p") {
			t.Errorf("install --extension-id %q: %v, want it refused", id, err)
		}
	}
	for _, id := range []string{storeID, unpackedID} {
		if err := checkExtensionID(id); err != nil {
			t.Errorf("checkExtensionID(%q) = %v", id, err)
		}
	}
}

// The command line can see who's connected without joining in.
func TestWatch(t *testing.T) {
	exe, dir := buildHelper(t)
	a, b := startHelper(t, exe, dir), startHelper(t, exe, dir)
	a.send(t, map[string]any{"type": "state", "profile": "1", "windows": 1, "info": map[string]any{"name": "Personal", "where": "Chrome/Default"}})
	b.send(t, map[string]any{"type": "state", "profile": "2", "windows": 1, "info": map[string]any{"name": "Work"}})
	a.expectPeers(t, "1", "2")

	var got map[string]peerInfo
	for end := time.Now().Add(3 * time.Second); time.Now().Before(end); time.Sleep(50 * time.Millisecond) {
		if got = connectedProfiles(dir); len(got) == 1 {
			break
		}
	}
	// only profiles set up by install say where they are
	if got["Chrome/Default"].Info.Name != "Personal" || len(got) != 1 {
		t.Errorf("connectedProfiles = %v", got)
	}
	// and the watcher isn't listed as a profile
	a.expectNothing(t)
	if live := liveHubs(dir); len(live) != 1 || len(live[0].peers) != 2 {
		t.Errorf("liveHubs = %d hubs, want one with two profiles", len(live))
	} else {
		live[0].Close()
	}
}

// Homebrew runs the helper from a versioned folder that goes when it
// upgrades; browsers get the opt link, which follows the upgrade.
func TestLastingPath(t *testing.T) {
	prefix := t.TempDir()
	exe := filepath.Join(prefix, "Cellar", "tabstack", "1.2.0", "bin", "tabstack")
	if err := os.MkdirAll(filepath.Dir(exe), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(exe, nil, 0o755); err != nil {
		t.Fatal(err)
	}
	if got := lastingPath(exe); got != exe {
		t.Errorf("without an opt link, lastingPath = %s, want the path itself", got)
	}
	if err := os.MkdirAll(filepath.Join(prefix, "opt"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../Cellar/tabstack/1.2.0", filepath.Join(prefix, "opt", "tabstack")); err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(prefix, "opt", "tabstack", "bin", "tabstack")
	if got := lastingPath(exe); got != want {
		t.Errorf("lastingPath = %s, want %s", got, want)
	}
	other := filepath.Join(t.TempDir(), "tabstack")
	if got := lastingPath(other); got != other {
		t.Errorf("outside Homebrew, lastingPath = %s, want the path itself", got)
	}
}

// Starting the helper fixes a registration that points at a binary that's
// gone, and leaves one pointing at another copy that's still there.
func TestRepair(t *testing.T) {
	exe, dir := buildHelper(t)
	gone := browser{name: "Gone", dataDir: filepath.Join(dir, "gone")}
	other := browser{name: "Other", dataDir: filepath.Join(dir, "other")}
	elsewhere := filepath.Join(dir, "elsewhere")
	if err := os.WriteFile(elsewhere, nil, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := writeHostManifest(gone, filepath.Join(dir, "missing"), []string{"abc"}); err != nil {
		t.Fatal(err)
	}
	if err := writeHostManifest(other, elsewhere, []string{"abc"}); err != nil {
		t.Fatal(err)
	}

	for _, b := range []browser{gone, other} {
		t.Setenv("TABSTACK_TEST_BROWSER", b.name+";"+b.dataDir+";chrome")
		h := startHelper(t, exe, dir)
		h.send(t, state("1", 1))
		h.expectPeers(t, "1")
		h.in.Close()
		h.cmd.Wait()
	}
	exe, _ = filepath.EvalSymlinks(exe) // the helper registers itself with links followed
	if m, _ := readHostManifest(gone); m == nil || m.Path != exe || !slices.Equal(m.extensionIDs(), []string{"abc"}) {
		t.Errorf("the registration pointing at a missing binary is %+v, want it at %s", m, exe)
	}
	if m, _ := readHostManifest(other); m == nil || m.Path != elsewhere {
		t.Errorf("the registration pointing at another copy is %+v, want it left alone", m)
	}
}

// Browsers have recorded a turned-off extension as state 0, and as a list of
// reasons or a bitmask of them.
func TestDisabled(t *testing.T) {
	zero, one := 0, 1
	for _, c := range []struct {
		name    string
		state   *int
		reasons string
		want    bool
	}{
		{"nothing recorded", nil, "", false},
		{"state 0", &zero, "", true},
		{"state 1", &one, "", false},
		{"no reasons", nil, "[]", false},
		{"a reason", nil, "[1]", true},
		{"a bitmask of none", nil, "0", false},
		{"a bitmask", nil, "4", true},
		{"null", nil, "null", false},
		{"state 1, with a reason", &one, "[1]", true},
		{"state 0, with no reasons", &zero, "[]", true},
	} {
		t.Run(c.name, func(t *testing.T) {
			s := extensionSettings{State: c.state, DisableReason: json.RawMessage(c.reasons)}
			if got := disabled(s); got != c.want {
				t.Errorf("disabled = %v, want %v", got, c.want)
			}
		})
	}
}

// register lets in each copy of tabstack it finds, once, then the IDs it was
// given; and registers with a browser without tabstack only for those.
func TestRegister(t *testing.T) {
	const extraID = "ponmlkjihgfedcbaponmlkjihgfedcba"
	unpacked := t.TempDir()
	writeJSON(t, filepath.Join(unpacked, "manifest.json"), map[string]any{"name": extensionName})
	newBrowser := func(name string, ids map[string]string) browser {
		data := t.TempDir()
		names := map[string]any{}
		for dir, id := range ids {
			names[dir] = map[string]any{"name": dir}
			settings := map[string]any{}
			switch id {
			case storeID:
				settings[id] = map[string]any{"path": id + "/1.0.0_0", "location": 1}
			case unpackedID:
				settings[id] = map[string]any{"path": unpacked, "location": locationUnpacked}
			}
			writeJSON(t, filepath.Join(data, dir, "Secure Preferences"), map[string]any{"extensions": map[string]any{"settings": settings}})
		}
		writeJSON(t, filepath.Join(data, "Local State"), map[string]any{"profile": map[string]any{"info_cache": names}})
		return browser{name: name, dataDir: data}
	}

	for _, c := range []struct {
		name  string
		extra []string
		want  map[string][]string // the IDs let in, by browser; nil for none
	}{
		{"found", nil, map[string][]string{"Has": {storeID, unpackedID}}},
		{"found, and given", []string{extraID}, map[string][]string{"Has": {storeID, unpackedID, extraID}, "Hasn't": {extraID}}},
	} {
		t.Run(c.name, func(t *testing.T) {
			has := newBrowser("Has", map[string]string{"Default": storeID, "Profile 1": storeID, "Profile 2": unpackedID, "Profile 3": ""})
			hasnt := newBrowser("Hasn't", map[string]string{"Default": ""})
			gone := browser{name: "Gone", dataDir: filepath.Join(t.TempDir(), "never run")}
			found, err := register([]browser{has, hasnt, gone}, "/bin/tabstack", c.extra)
			if err != nil {
				t.Fatal(err)
			}
			if len(found) != len(c.want) {
				t.Errorf("register found %d browsers, want %d", len(found), len(c.want))
			}
			for _, b := range []browser{has, hasnt, gone} {
				m, err := readHostManifest(b)
				if err != nil {
					t.Fatal(err)
				}
				var ids []string
				if m != nil {
					ids = m.extensionIDs()
				}
				if !slices.Equal(ids, c.want[b.name]) {
					t.Errorf("%s lets in %v, want %v", b.name, ids, c.want[b.name])
				}
			}
			// Profile 3, and with IDs given the other browser's profile
			targets, missing := printFound(io.Discard, found)
			if len(targets) != 3 || len(missing) != len(c.want) {
				t.Errorf("register found tabstack in %d profiles and not in %d, want 3 and %d", len(targets), len(missing), len(c.want))
			}
		})
	}
}

// Helpers starting together, one per profile, all repair the registration
// at once; each write is whole, and leaves nothing behind.
func TestSaveHostManifestConcurrently(t *testing.T) {
	b := browser{name: "Test", dataDir: t.TempDir()}
	const n = 20
	errs := make(chan error, n)
	for i := range n {
		go func() { errs <- writeHostManifest(b, fmt.Sprintf("/bin/tabstack-%d", i), []string{storeID}) }()
	}
	for range n {
		if err := <-errs; err != nil {
			t.Error(err)
		}
	}
	m, err := readHostManifest(b)
	if err != nil || m == nil || !strings.HasPrefix(m.Path, "/bin/tabstack-") {
		t.Errorf("registration = %+v, %v", m, err)
	}
	if left := otherFiles(t, b); len(left) > 0 {
		t.Errorf("left %v beside the registration", left)
	}
	if info, err := os.Stat(b.manifest()); err != nil {
		t.Error(err)
	} else if info.Mode().Perm() != 0o644 {
		t.Errorf("registration's mode = %v, want 0644, for the browser to read", info.Mode())
	}
}

// Chrome writes some permissions as objects (a settings override, say). One
// in another extension's list, or tabstack's own, or any other entry this
// can't read, doesn't hide tabstack.
func TestFindTabstackOddEntries(t *testing.T) {
	dir := t.TempDir()
	writeJSON(t, filepath.Join(dir, "Extensions", storeID, "1.0.0_0", "manifest.json"), map[string]any{"name": extensionName})
	override := map[string]any{"settings_override": map[string]any{"homepage": "https://example.com"}}
	writeJSON(t, filepath.Join(dir, "Secure Preferences"), map[string]any{"extensions": map[string]any{"settings": map[string]any{
		lookalikeID:                        map[string]any{"path": "x", "location": 1, "active_permissions": map[string]any{"api": []any{"tabs", override}}},
		"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": map[string]any{"location": "unpacked", "state": []int{1}},
		"cccccccccccccccccccccccccccccccc": "not an object",
		storeID: map[string]any{"path": storeID + "/1.0.0_0", "location": 1,
			"active_permissions": map[string]any{"api": []any{override, "nativeMessaging", 5}}},
	}}})
	if id, granted := findTabstack(dir); id != storeID || !granted {
		t.Errorf("findTabstack = %q, %v; want %q, true", id, granted, storeID)
	}
}

// A profile the browser recorded in an unexpected shape in Local State
// keeps its folder's name, and doesn't hide the browser's other profiles.
func TestProfilesOddLocalState(t *testing.T) {
	for _, c := range []struct {
		name  string
		state string
		want  []profile
	}{
		{"a name of the wrong type", `{"profile":{"info_cache":{"Default":{"name":5},"Profile 1":{"name":"Work"}}}}`,
			[]profile{{dir: "Default", name: "Default"}, {dir: "Profile 1", name: "Work"}}},
		{"an entry that isn't an object", `{"profile":{"info_cache":{"Default":"Me","Profile 1":{"name":"Work"}}}}`,
			[]profile{{dir: "Default", name: "Default"}, {dir: "Profile 1", name: "Work"}}},
		{"no list of them", `{"profile":{"info_cache":[]}}`,
			[]profile{{dir: "Default", name: "Default"}, {dir: "Profile 1", name: "Profile 1"}}},
		{"no profile section", `{"profile":5}`,
			[]profile{{dir: "Default", name: "Default"}, {dir: "Profile 1", name: "Profile 1"}}},
	} {
		t.Run(c.name, func(t *testing.T) {
			data := t.TempDir()
			for _, dir := range []string{"Default", "Profile 1"} {
				writeJSON(t, filepath.Join(data, dir, "Preferences"), map[string]any{})
			}
			if err := os.WriteFile(filepath.Join(data, "Local State"), []byte(c.state), 0o644); err != nil {
				t.Fatal(err)
			}
			got, err := profiles(browser{name: "Test", dataDir: data})
			if err != nil || !slices.Equal(got, c.want) {
				t.Errorf("profiles = %+v, %v; want %+v", got, err, c.want)
			}
		})
	}
	// Local State that isn't JSON at all still says so
	data := t.TempDir()
	if err := os.WriteFile(filepath.Join(data, "Local State"), []byte(`{"profile":`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := profiles(browser{name: "Test", dataDir: data}); err == nil {
		t.Error("profiles read a Local State that's cut off")
	}
}
