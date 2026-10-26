package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime/debug"
	"strings"
	"syscall"
)

// version is set when a release is built (-ldflags "-X main.version=1.2.0").
// Otherwise it's what go install recorded, or "dev" for a local build.
var version = ""

func init() {
	if version != "" {
		return
	}
	version = "dev"
	if info, ok := debug.ReadBuildInfo(); ok && info.Main.Version != "" && info.Main.Version != "(devel)" {
		version = strings.TrimPrefix(info.Main.Version, "v")
	}
}

// selfPath is this binary's own file, links followed.
func selfPath() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(exe)
}

// helperPath is where browsers should find this binary: by a path that
// lasts. Under Homebrew that's the opt link, which follows upgrades, rather
// than the versioned folder it runs from (…/Cellar/tabstack-host/1.2.0/bin),
// which goes when it upgrades.
func helperPath() (string, error) {
	exe, err := selfPath()
	if err != nil {
		return "", err
	}
	return lastingPath(exe), nil
}

func lastingPath(exe string) string {
	sep := string(filepath.Separator)
	cellar := sep + "Cellar" + sep
	i := strings.LastIndex(exe, cellar)
	if i < 0 {
		return exe
	}
	// <prefix>/Cellar/<formula>/<version>/<the rest>
	parts := strings.SplitN(exe[i+len(cellar):], sep, 3)
	if len(parts) < 3 {
		return exe
	}
	opt := filepath.Join(exe[:i], "opt", parts[0], parts[2])
	if sameFile(opt, exe) {
		return opt
	}
	return exe
}

func sameFile(a, b string) bool {
	fa, err := os.Stat(a)
	if err != nil {
		return false
	}
	fb, err := os.Stat(b)
	return err == nil && os.SameFile(fa, fb)
}

// fileID tells one build of the helper from another at the same path, since
// an upgrade puts a new file there: brew moves a link, go install renames
// over the old one. "" when there's no file.
func fileID(path string) string {
	info, err := os.Stat(path)
	if err != nil {
		return ""
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return ""
	}
	return fmt.Sprintf("%d:%d", st.Dev, st.Ino)
}
