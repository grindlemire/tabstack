package main

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// doctor fixes a registration that points at a binary that's gone, and lets
// in a copy of tabstack the registration doesn't.
func TestDoctor(t *testing.T) {
	data := t.TempDir()
	ext := t.TempDir()
	writeJSON(t, filepath.Join(ext, "manifest.json"), map[string]any{"name": "tabstack: recent tab switcher"})
	writeJSON(t, filepath.Join(data, "Local State"), map[string]any{
		"profile": map[string]any{"info_cache": map[string]any{
			"Default":   map[string]any{"name": "Personal"},
			"Profile 1": map[string]any{"name": "Work"},
		}},
	})
	for dir, id := range map[string]string{"Default": storeID, "Profile 1": unpackedID} {
		writeJSON(t, filepath.Join(data, dir, "Secure Preferences"), map[string]any{"extensions": map[string]any{"settings": map[string]any{
			id: map[string]any{"path": ext, "location": locationUnpacked},
		}}})
	}
	b := browser{name: "Test", dataDir: data}
	if err := writeHostManifest(b, filepath.Join(data, "gone", "tabstack"), []string{storeID}); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TABSTACK_TEST_BROWSER", "Test;"+data+";chrome")
	t.Setenv("TABSTACK_HOST_DIR", t.TempDir())

	var out strings.Builder
	err := doctor(&out)
	if err != nil {
		t.Errorf("doctor: %v\n%s", err, &out)
	}
	for _, want := range []string{"fixed the registration", "let in tabstack " + unpackedID, "Personal: not set up", "Work: not set up"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("doctor said\n%s\nwant it to say %q", &out, want)
		}
	}
	self, _ := selfPath()
	m, _ := readHostManifest(b)
	if m == nil || m.Path != self || !slices.Equal(m.extensionIDs(), []string{storeID, unpackedID}) {
		t.Errorf("registration = %+v, want it at %s letting in both", m, self)
	}
	if left := otherFiles(t, b); len(left) > 0 {
		t.Errorf("left %v beside the registration", left)
	}
}

// otherFiles lists what's beside a browser's registration of the helper,
// like a temporary file a write left behind.
func otherFiles(t *testing.T, b browser) []string {
	t.Helper()
	entries, err := os.ReadDir(filepath.Dir(b.manifest()))
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		if e.Name() != filepath.Base(b.manifest()) {
			names = append(names, e.Name())
		}
	}
	return names
}

// doctor says profiles move to the registered helper on their own only when
// the hub watches where it's registered (watchExe).
func TestHubNote(t *testing.T) {
	dir := t.TempDir()
	registered, other := filepath.Join(dir, "tabstack"), filepath.Join(dir, "other")
	for _, f := range []string{registered, other} {
		if err := os.WriteFile(f, []byte(f), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	link := filepath.Join(dir, "link")
	if err := os.Symlink(registered, link); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		name string
		hub  hubInfo
		want string
	}{
		{"the same version", hubInfo{"1.2.0", other}, ""},
		{"too old to say", hubInfo{"", ""}, "older than this one. Quit and reopen Chrome to move to 1.2.0."},
		{"watching where it's registered", hubInfo{"1.1.0", registered}, "is 1.1.0; profiles move to 1.2.0 within a minute."},
		{"watching it by a link", hubInfo{"1.1.0", link}, "within a minute"},
		{"watching another copy", hubInfo{"1.1.0", other}, "is 1.1.0. Quit and reopen Chrome to move to 1.2.0."},
		{"watching a copy that's gone", hubInfo{"1.1.0", filepath.Join(dir, "gone")}, "Quit and reopen"},
		{"too old to say where", hubInfo{"1.1.0", ""}, "Quit and reopen"},
	} {
		t.Run(c.name, func(t *testing.T) {
			got := hubNote("Chrome", c.hub, registered, "1.2.0")
			if c.want == "" && got != "" || !strings.Contains(got, c.want) {
				t.Errorf("hubNote = %q, want %q", got, c.want)
			}
		})
	}
}
