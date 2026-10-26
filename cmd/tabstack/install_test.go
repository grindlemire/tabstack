package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
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
	writeJSON(t, filepath.Join(data, "Default", "Extensions", "storeid", "1.0.0_0", "manifest.json"), map[string]any{"name": "tabstack: recent tab switcher"})
	writeJSON(t, filepath.Join(data, "Default", "Secure Preferences"), map[string]any{"extensions": map[string]any{"settings": map[string]any{
		"storeid": map[string]any{"path": "storeid/1.0.0_0", "active_permissions": map[string]any{"api": []string{"tabs", "nativeMessaging"}}},
	}}})
	// Profile 2: unpacked but turned off, so it doesn't count
	writeJSON(t, filepath.Join(data, "Profile 2", "Secure Preferences"), map[string]any{"extensions": map[string]any{"settings": map[string]any{
		"unpackedid": map[string]any{"path": unpacked, "disable_reasons": []int{1}},
	}}})
	// Profile 10 had the permission once: Chrome keeps it in granted_permissions
	// after it's removed, but it's not active, so it doesn't count
	// Profile 10: another extension, and tabstack unpacked, in the older Preferences file
	other := t.TempDir()
	writeJSON(t, filepath.Join(other, "manifest.json"), map[string]any{"name": "Some other extension"})
	writeJSON(t, filepath.Join(data, "Profile 10", "Preferences"), map[string]any{"extensions": map[string]any{"settings": map[string]any{
		"aaaother": map[string]any{"path": other},
		"unpackedid": map[string]any{
			"path":                unpacked,
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
		{dir: "Default", name: "Personal", id: "storeid", granted: true},
		{dir: "Profile 2", name: "Work"},
		{dir: "Profile 10", name: "Side", id: "unpackedid"},
	}
	if !slices.Equal(got, want) {
		t.Errorf("profiles =\n  %+v\nwant\n  %+v", got, want)
	}
}

// The command line can see who's connected without joining in.
func TestWatch(t *testing.T) {
	exe, dir := buildHelper(t)
	a, b := startHelper(t, exe, dir), startHelper(t, exe, dir)
	a.send(t, map[string]any{"type": "state", "profile": "1", "windows": 1, "info": map[string]any{"name": "Personal", "where": "Chrome/Default"}})
	b.send(t, map[string]any{"type": "state", "profile": "2", "windows": 1, "info": map[string]any{"name": "Work"}})
	a.expectPeers(t, "1", "2")

	var got map[string]hubPeer
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
