package main

import (
	"bufio"
	"cmp"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// doctor checks each link between tabstack and the helper, since a broken
// one only shows as profiles missing from search: the browser says nothing
// when it can't start the helper. It fixes what it safely can, the
// registrations, and says how to fix the rest.
func doctor(w io.Writer) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	self, err := selfPath()
	if err != nil {
		return err
	}
	fmt.Fprintf(w, "tabstack %s, %s\n", version, lastingPath(self))

	problems := 0
	bad := func(format string, args ...any) {
		problems++
		fmt.Fprintf(w, "  ✗ "+format+"\n", args...)
	}
	good := func(format string, args ...any) { fmt.Fprintf(w, "  ✓ "+format+"\n", args...) }
	note := func(format string, args ...any) { fmt.Fprintf(w, "  · "+format+"\n", args...) }

	fixed, err := repair(home)
	if err != nil {
		bad("%v", err)
	}
	s, err := openSession()
	if err != nil {
		return err
	}
	defer s.Close()
	if len(s.entries) == 0 {
		fmt.Fprintln(w, "\ntabstack isn't installed in any profile here.")
	}

	hubs := s.hubsByBrowser()

	for _, b := range knownBrowsers(home) {
		var here []entry
		for _, e := range s.entries {
			if e.b.name == b.name {
				here = append(here, e)
			}
		}
		if len(here) == 0 {
			continue
		}
		fmt.Fprintf(w, "\n%s\n", b.name)

		m, err := readHostManifest(b)
		want := "" // the version of the helper it's registered at
		switch {
		case err != nil:
			bad("can't read the helper's registration: %v", err)
		case m == nil:
			bad("the helper isn't registered. Run tabstack install.")
		default:
			for _, r := range fixed {
				if r.browser == b.name {
					good("fixed the registration, which pointed at %s, now %s", r.was, r.now)
				}
			}
			switch {
			case !fileExists(m.Path):
				bad("registered at %s, which is gone. Run tabstack install.", m.Path)
			case !sameFile(m.Path, self):
				want = versionOf(m.Path)
				note("registered at %s (%s), not this copy, so profiles use that one. Run this copy's install to switch.", m.Path, cmp.Or(want, "an older version"))
			default:
				want = version
				good("registered at %s", m.Path)
			}
			// a copy of tabstack the registration doesn't let in can't reach the helper
			var added []string
			for _, e := range here {
				if e.p.id != "" && !slices.Contains(m.extensionIDs(), e.p.id) && !slices.Contains(added, e.p.id) {
					m.AllowedOrigins = append(m.AllowedOrigins, "chrome-extension://"+e.p.id+"/")
					added = append(added, e.p.id)
				}
			}
			if len(added) > 0 {
				if err := saveHostManifest(b, *m); err != nil {
					bad("couldn't let in tabstack %s: %v", strings.Join(added, ", "), err)
				} else {
					good("let in tabstack %s, which the registration didn't", strings.Join(added, ", "))
				}
			}
		}

		if h, ok := hubs[b.name]; ok && want != "" {
			if n := hubNote(b.name, h, m.Path, want); n != "" {
				note("%s", n)
			}
		}
		for _, e := range here {
			name := e.name()
			switch {
			case e.peer != nil && e.peer.Info.Done == nil:
				bad("%s: connected, but running an older tabstack. Reload it on chrome://extensions in that profile.", name)
			case e.peer != nil:
				good("%s: connected", name)
			case e.p.id == "":
				note("%s: tabstack isn't installed", name)
			case e.p.granted:
				note("%s: allowed, but not connected. It connects when the profile's open; if it is, reload tabstack on chrome://extensions there.", name)
			default:
				note("%s: not set up. Run tabstack connect %q.", name, e.p.dir)
			}
		}
	}
	if others := slices.DeleteFunc(slices.Clone(s.entries), func(e entry) bool { return e.b.name != "" }); len(others) > 0 {
		fmt.Fprintln(w, "\nOther connected profiles")
		for _, e := range others {
			note("%s: connected, but install didn't set it up, so it can't say which profile it is. Run tabstack install.", e.name())
		}
	}

	if dir, err := hubDir(); err == nil {
		logPath := filepath.Join(dir, "host.log")
		if lines := lastLines(logPath, 5); len(lines) > 0 {
			fmt.Fprintf(w, "\nThe end of %s\n", logPath)
			for _, l := range lines {
				fmt.Fprintf(w, "  %s\n", l)
			}
		}
	}

	switch problems {
	case 0:
	case 1:
		return fmt.Errorf("found a problem")
	default:
		return fmt.Errorf("found %d problems", problems)
	}
	fmt.Fprintln(w, "\nNo problems found.")
	return nil
}

// hubNote says how a browser's profiles get from the hub running for it to
// the helper registered at path, of version want: on their own when a new
// build turned up where the hub watches for one (watchExe), which is where
// it started from, or else once the browser's reopened.
func hubNote(browser string, h hubInfo, path, want string) string {
	switch {
	case h.version == want:
		return ""
	case h.version == "":
		return fmt.Sprintf("the helper running for it is older than this one. Quit and reopen %s to move to %s.", browser, want)
	case h.path != "" && sameFile(h.path, path):
		return fmt.Sprintf("the helper running for it is %s; profiles move to %s within a minute.", h.version, want)
	}
	return fmt.Sprintf("the helper running for it is %s. Quit and reopen %s to move to %s.", h.version, browser, want)
}

// versionOf asks another copy of the helper which version it is; "" when
// it can't say.
func versionOf(path string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, path, "version").Output()
	if err != nil {
		return ""
	}
	// "tabstack 1.2.0", or "tabstack-host 1.1.0" from before the rename
	f := strings.Fields(string(out))
	if len(f) == 0 {
		return ""
	}
	return f[len(f)-1]
}

func lastLines(path string, n int) []string {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	var lines []string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		lines = append(lines, sc.Text())
		if len(lines) > n {
			lines = lines[1:]
		}
	}
	return lines
}
