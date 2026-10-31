package main

import (
	"cmp"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/netip"
	"net/url"
	"os/exec"
	"regexp"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"
)

// askFor bounds how long the command line waits for profiles to answer.
const askFor = 2 * time.Second

// reloadHint is why a connected profile doesn't answer: a tabstack, or a
// helper running for it, from before the command line could ask.
const reloadHint = "If tabstack or the helper was updated, reload tabstack on chrome://extensions in each profile."

// tab is an open tab, as tabs lists it.
type tab struct {
	Profile      string  `json:"profile"`
	ProfileName  string  `json:"profileName"`
	ID           int     `json:"id"`
	WindowID     int     `json:"windowId"`
	Title        string  `json:"title"`
	URL          string  `json:"url"`
	LastAccessed float64 `json:"lastAccessed"`
}

// tabs lists every connected profile's tabs, most recently used first,
// keeping those whose title or address has every word given.
func tabs(w io.Writer, args []string) error {
	fs := flag.NewFlagSet("tabs", flag.ContinueOnError)
	asJSON := fs.Bool("json", false, "one JSON object per tab")
	if err := fs.Parse(args); err != nil {
		return err
	}
	s, err := openSession()
	if err != nil {
		return err
	}
	defer s.Close()

	names := map[string]string{}
	for _, e := range s.entries {
		if e.peer != nil {
			names[e.peer.Profile] = e.name()
		}
	}
	var all []tab
	asked, answered := 0, 0
	for _, c := range s.hubs {
		answers, err := c.ask("*", map[string]any{"kind": "tabs"}, askFor)
		if err != nil {
			return err
		}
		asked += len(c.peers)
		answered += len(answers)
		for _, a := range answers {
			var r struct{ Tabs []tab }
			if json.Unmarshal(a.Body, &r) != nil {
				continue
			}
			for _, t := range r.Tabs {
				t.Profile, t.ProfileName = a.From, names[a.From]
				all = append(all, t)
			}
		}
	}
	if len(s.hubs) == 0 {
		return errors.New("no profile is connected; is the browser open?")
	}
	if answered == 0 && asked > 0 {
		return errors.New("no profile answered. " + reloadHint)
	}
	words := strings.Fields(strings.ToLower(strings.Join(fs.Args(), " ")))
	all = slices.DeleteFunc(all, func(t tab) bool {
		text := strings.ToLower(t.Title + " " + t.URL)
		return slices.ContainsFunc(words, func(w string) bool { return !strings.Contains(text, w) })
	})
	slices.SortStableFunc(all, func(a, b tab) int { return cmp.Compare(b.LastAccessed, a.LastAccessed) })

	if *asJSON {
		enc := json.NewEncoder(w)
		for _, t := range all {
			enc.Encode(t)
		}
		return nil
	}
	// the profile, the tab's number for focus, and its title over its address
	nameW, idW := 0, 0
	for _, t := range all {
		nameW = max(nameW, len(t.ProfileName))
		idW = max(idW, len(strconv.Itoa(t.ID)))
	}
	for _, t := range all {
		fmt.Fprintf(w, "%-*s  %*d  %s\n%*s%s\n", nameW, t.ProfileName, idW, t.ID, t.Title, nameW+idW+4, "", t.URL)
	}
	return nil
}

// focus brings a profile forward, or one of its tabs, in its window.
func focus(w io.Writer, args []string) error {
	if len(args) < 1 || len(args) > 2 {
		return errors.New("tabstack focus <profile> [<tab>]")
	}
	s, err := openSession()
	if err != nil {
		return err
	}
	defer s.Close()
	e, err := s.find(args[0])
	if err != nil {
		return err
	}
	if e.peer == nil {
		return fmt.Errorf("%s isn't connected; is it open?", e.name())
	}
	body := map[string]any{"kind": "focus"}
	if len(args) == 2 {
		id, err := strconv.Atoi(args[1])
		if err != nil {
			return fmt.Errorf("%q isn't a tab; tabstack tabs lists them, with their numbers", args[1])
		}
		body["tabId"] = id
	}
	if err := s.request(e, body); err != nil {
		return err
	}
	s.activate(e)
	return nil
}

// activate brings a profile's browser to the front on macOS. Since macOS 14
// an app can't bring itself forward over the one you're using, as the
// browser does for its own window, but the app you're using can ask for it.
func (s *session) activate(e entry) {
	if runtime.GOOS != "darwin" || e.b.exe == "" {
		return
	}
	if exe, err := findExe(s.home, e.b.exe); err == nil {
		if app, _, ok := strings.Cut(exe, ".app/"); ok {
			start("open", "-a", app+".app")
		}
	}
}

// request asks a profile to do something and waits for it to say it has.
func (s *session) request(e entry, body map[string]any) error {
	for _, c := range s.hubs {
		if !has(c.peers, e.peer.Profile) {
			continue
		}
		answers, err := c.ask(e.peer.Profile, body, askFor)
		if err != nil {
			return err
		}
		if len(answers) == 0 {
			return fmt.Errorf("%s didn't answer. %s", e.name(), reloadHint)
		}
		var r struct{ Error string }
		json.Unmarshal(answers[0].Body, &r)
		if r.Error != "" {
			return fmt.Errorf("%s: %s", e.name(), r.Error)
		}
		return nil
	}
	return fmt.Errorf("%s isn't connected anymore", e.name())
}

// open opens each link in the profile it belongs to, by the links set to
// open there, or in the one named. Others go to the default browser, which
// opens them in the profile used last.
func open(w io.Writer, args []string) error {
	fs := flag.NewFlagSet("open", flag.ContinueOnError)
	in := fs.String("profile", "", "open them in this profile")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() == 0 {
		return errors.New("tabstack open [--profile <profile>] <link>...")
	}
	s, err := openSession()
	if err != nil {
		return err
	}
	defer s.Close()
	var named *entry
	if *in != "" {
		e, err := s.find(*in)
		if err != nil {
			return err
		}
		named = &e
	}
	for _, arg := range fs.Args() {
		link := arg
		if !strings.Contains(link, "://") {
			link = "https://" + link
		}
		u, err := url.Parse(link)
		if err != nil {
			return fmt.Errorf("%q isn't a link: %w", arg, err)
		}
		e := named
		if e == nil {
			e = s.owner(u)
		}
		if err := s.openIn(e, link); err != nil {
			return err
		}
	}
	return nil
}

// owner is the profile whose links cover u, nil when none's do.
func (s *session) owner(u *url.URL) *entry {
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil
	}
	for i, e := range s.entries {
		if e.peer != nil && slices.ContainsFunc(e.peer.Info.Claims, func(c string) bool { return covers(c, u) }) {
			return &s.entries[i]
		}
	}
	return nil
}

// openIn opens a link in a profile: by starting its browser there, which
// brings the browser forward, or failing that through tabstack in it.
func (s *session) openIn(e *entry, link string) error {
	if e == nil {
		return openDefault(link)
	}
	defer s.activate(*e)
	if e.p.dir != "" {
		exe, err := findExe(s.home, e.b.exe)
		if err == nil {
			return start(exe, append(e.b.args, "--profile-directory="+e.p.dir, link)...)
		}
	}
	if e.peer == nil {
		return fmt.Errorf("%s isn't connected, and its browser can't be found", e.name())
	}
	return s.request(*e, map[string]any{"kind": "open", "url": link})
}

func openDefault(link string) error {
	if runtime.GOOS == "darwin" {
		return start("open", link)
	}
	return start("xdg-open", link)
}

// start runs a program in a session of its own, so a browser it starts
// outlives this command and its terminal.
func start(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	go cmd.Wait()
	return nil
}

// covers reports whether a pattern from "Links that open in this profile"
// covers a link, the same way tabstack does (covers in
// src/background/covers.ts; testdata/covers.json holds both to the same
// cases). "corp.com" is that site (and www.corp.com), "*.corp.com" adds its
// subdomains, and a path covers everything under it. A * matches anything.
// A port ("localhost:3000") has to match too; without one, any port does.
func covers(pattern string, u *url.URL) bool {
	p := strings.ToLower(strings.TrimSpace(pattern))
	p = strings.TrimPrefix(strings.TrimPrefix(p, "http://"), "https://")
	site, path, _ := strings.Cut(p, "/")
	// an IPv6 address is bracketed when it has a port, and may be bare when it hasn't
	host, port := "["+site+"]", ""
	if m := siteParts.FindStringSubmatch(site); m != nil {
		host, port = m[1], m[2]
	}
	if host == "" {
		return false
	}
	glob := func(text, star string) string {
		parts := strings.Split(text, "*")
		for i, part := range parts {
			parts[i] = regexp.QuoteMeta(part)
		}
		return strings.Join(parts, star)
	}
	var hostPattern string
	if rest, ok := strings.CutPrefix(host, "*."); ok {
		hostPattern = `(?:[^/]*\.)?` + glob(rest, "[^/]*")
	} else {
		hostPattern = `(?:www\.)?` + glob(host, "[^/]*")
	}
	if !regexp.MustCompile(`^` + hostPattern + `$`).MatchString(browserHost(u)) {
		return false
	}
	// "localhost:80" is http://localhost/ too, which a browser writes without the port
	linkPort := u.Port()
	if linkPort == "" && u.Scheme == "https" {
		linkPort = "443"
	} else if linkPort == "" {
		linkPort = "80"
	}
	if port != "" && !regexp.MustCompile(`^`+glob(port, ".*")+`$`).MatchString(linkPort) {
		return false
	}
	path = unescape(path)
	if trimmed, ok := strings.CutSuffix(path, "/*"); ok {
		path = trimmed
	}
	path = strings.TrimRight(strings.ToLower(path), "/")
	if path == "" {
		return true
	}
	linkPath := strings.ToLower(unescape(dotless(u.EscapedPath())))
	return regexp.MustCompile(`^/` + glob(path, ".*") + `(?:/.*)?$`).MatchString(linkPath)
}

// siteParts splits a pattern's site into its host and port.
var siteParts = regexp.MustCompile(`^(\[[^\]]*\]|[^:]*)(?::([^:]*))?$`)

// browserHost is u's host as a browser has it, for covers: lowercase, and an
// IPv6 address bracketed and shortened, with no dotted IPv4 in it.
func browserHost(u *url.URL) string {
	h := strings.ToLower(u.Hostname())
	a, err := netip.ParseAddr(h)
	if err != nil || !a.Is6() {
		return h
	}
	if a.Is4In6() {
		b := a.As16()
		return fmt.Sprintf("[::ffff:%x:%x]", uint16(b[12])<<8|uint16(b[13]), uint16(b[14])<<8|uint16(b[15]))
	}
	return "[" + a.String() + "]"
}

// dotless resolves a path's . and .. segments, escaped or not, as a browser
// does before it loads the page.
func dotless(path string) string {
	segs := strings.Split(strings.TrimPrefix(path, "/"), "/")
	out := make([]string, 0, len(segs))
	for i, s := range segs {
		last := i == len(segs)-1
		switch strings.ToLower(s) {
		case "..", ".%2e", "%2e.", "%2e%2e":
			if len(out) > 0 {
				out = out[:len(out)-1]
			}
			if last {
				out = append(out, "")
			}
		case ".", "%2e":
			if last {
				out = append(out, "")
			}
		default:
			out = append(out, s)
		}
	}
	return "/" + strings.Join(out, "/")
}

// unescape decodes a path's escapes, so "/caf%C3%A9" is "/café" however
// either was written. It's left as is when they aren't UTF-8, as
// decodeURIComponent leaves it in tabstack.
func unescape(path string) string {
	d, err := url.PathUnescape(path)
	if err != nil || !utf8.ValidString(d) {
		return path
	}
	return d
}
