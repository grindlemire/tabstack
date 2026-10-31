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
	if _, err := os.Stat(b.manifest() + ".new"); err == nil {
		t.Error("left the new registration's temporary file")
	}
}
