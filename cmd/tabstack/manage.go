package main

import (
	"cmp"
	"errors"
	"fmt"
	"io"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"
)

// confirmFor bounds how long a command waits to see a profile do what it
// was told.
const confirmFor = 5 * time.Second

// entry is one profile, as list shows it: found in the browser's files, or
// connected, or both. Commands name it by its number, its name or its folder.
type entry struct {
	n    int
	b    browser
	p    profile   // empty for a connected profile install didn't set up
	peer *peerInfo // set while it's connected
}

func (e entry) name() string {
	if e.peer != nil && e.peer.Info.Name != "" {
		return e.peer.Info.Name
	}
	return cmp.Or(e.p.name, e.p.dir, "(unnamed)")
}

func (e entry) state() string {
	switch {
	case e.peer != nil:
		return "connected"
	case e.p.id == "":
		return "tabstack isn't installed"
	case e.p.granted:
		return "allowed, not connected (is it open?)"
	}
	return "not set up"
}

// session is every profile of every browser here, and the hubs of the
// running ones.
type session struct {
	home    string
	dir     string // where the hubs are
	entries []entry
	hubs    []*hubClient
}

func (s *session) Close() {
	for _, c := range s.hubs {
		c.Close()
	}
}

// until watches the profile id until done is satisfied with what it shows,
// or the time's up; done gets nil while it isn't connected. It asks the hubs
// afresh each time, since the hub can move: a profile told to go may be the
// one whose helper was the hub.
func (s *session) until(id string, done func(*peerInfo) bool) bool {
	for end := time.Now().Add(confirmFor); time.Now().Before(end); time.Sleep(200 * time.Millisecond) {
		var found *peerInfo
		for _, c := range liveHubs(s.dir) {
			if i := slices.IndexFunc(c.peers, func(p peerInfo) bool { return p.Profile == id }); i >= 0 {
				found = &c.peers[i]
			}
			c.Close()
		}
		if done(found) {
			return true
		}
	}
	return false
}

// errGone is a profile that left before it could be told something.
var errGone = errors.New("it isn't connected anymore")

// tell sends a profile a command through whichever hub has it now. That can
// have changed since the session started: the hub moves when the profile
// whose helper it was leaves, and for a moment, while the others join the
// next one, no hub has them.
func (s *session) tell(id string, body any) error {
	for end := time.Now().Add(confirmFor); time.Now().Before(end); time.Sleep(200 * time.Millisecond) {
		var err error = errGone
		for _, c := range liveHubs(s.dir) {
			if err == errGone && has(c.peers, id) {
				err = c.send(id, body)
			}
			c.Close()
		}
		if err != errGone {
			return err
		}
	}
	return errGone
}

// has reports whether a profile is among peers.
func has(peers []peerInfo, id string) bool {
	return slices.ContainsFunc(peers, func(p peerInfo) bool { return p.Profile == id })
}

func openSession() (*session, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	dir, err := hubDir()
	if err != nil {
		return nil, err
	}
	s := &session{home: home, dir: dir, hubs: liveHubs(dir)}

	// connected profiles by where they are, as install set them up
	byWhere := map[string]*peerInfo{}
	var connected []*peerInfo
	for _, c := range s.hubs {
		for i := range c.peers {
			p := &c.peers[i]
			connected = append(connected, p)
			if p.Info.Where != "" {
				byWhere[p.Info.Where] = p
			}
		}
	}
	placed := map[*peerInfo]bool{}

	for _, b := range knownBrowsers(home) {
		if !b.installed() {
			continue
		}
		list, err := profiles(b)
		if err != nil || !slices.ContainsFunc(list, func(p profile) bool { return p.id != "" }) {
			continue
		}
		for _, p := range list {
			e := entry{b: b, p: p}
			e.peer = byWhere[b.key(p)]
			placed[e.peer] = true
			s.entries = append(s.entries, e)
		}
	}
	// connected, but not to a profile found here: set up before install
	// said where profiles are, or in a browser it doesn't know
	for _, p := range connected {
		if !placed[p] {
			s.entries = append(s.entries, entry{peer: p})
		}
	}
	for i := range s.entries {
		s.entries[i].n = i + 1
	}
	return s, nil
}

// hubInfo is what a running browser's hub says about itself.
type hubInfo struct {
	version string
	path    string // its helper, where it watches for a new build
}

// hubsByBrowser is each running browser's hub, by browser.
func (s *session) hubsByBrowser() map[string]hubInfo {
	out := map[string]hubInfo{}
	for _, c := range s.hubs {
		for _, p := range c.peers {
			if b, _, ok := strings.Cut(p.Info.Where, "/"); ok {
				out[b] = hubInfo{c.version, c.path}
			}
		}
	}
	return out
}

// find resolves what the command line called a profile: its number in list,
// its name, its folder ("Profile 1"), or the ID tabs --json gives it.
func (s *session) find(arg string) (entry, error) {
	if n, err := strconv.Atoi(arg); err == nil {
		if n < 1 || n > len(s.entries) {
			return entry{}, fmt.Errorf("there's no profile %d; run tabstack list", n)
		}
		return s.entries[n-1], nil
	}
	var hits []entry
	for _, e := range s.entries {
		if strings.EqualFold(e.name(), arg) || strings.EqualFold(e.p.name, arg) || strings.EqualFold(e.p.dir, arg) ||
			(e.peer != nil && e.peer.Profile == arg) {
			hits = append(hits, e)
		}
	}
	switch len(hits) {
	case 0:
		return entry{}, fmt.Errorf("no profile called %q; run tabstack list", arg)
	case 1:
		return hits[0], nil
	}
	return entry{}, fmt.Errorf("%q could be profile %d or %d; use its number", arg, hits[0].n, hits[1].n)
}

func (s *session) findAll(args []string) ([]entry, error) {
	var out []entry
	for _, arg := range args {
		e, err := s.find(arg)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, nil
}

// list shows every profile, numbered for the other commands.
func list(w io.Writer) error {
	s, err := openSession()
	if err != nil {
		return err
	}
	defer s.Close()
	if len(s.entries) == 0 {
		fmt.Fprintln(w, "tabstack isn't installed in any profile here.")
		return nil
	}
	hubs := s.hubsByBrowser()
	heading := ""
	for _, e := range s.entries {
		group := e.b.name
		if e.b.name == "" {
			group = "Other connected profiles"
		}
		if group != heading {
			heading = group
			if h, ok := hubs[group]; ok {
				fmt.Fprintf(w, "%s (helper %s)\n", heading, cmp.Or(h.version, "older"))
			} else {
				fmt.Fprintln(w, heading)
			}
		}
		fmt.Fprintf(w, "  %2d  %-26s %-12s %s\n", e.n, e.name(), e.p.dir, e.state())
		if e.peer != nil && len(e.peer.Info.Claims) > 0 {
			fmt.Fprintf(w, "      links: %s\n", strings.Join(e.peer.Info.Claims, ", "))
		}
	}
	return nil
}

// connect opens the setup page in each profile named, for one click there.
func connect(w io.Writer, args []string) error {
	s, err := openSession()
	if err != nil {
		return err
	}
	defer s.Close()
	targets, err := s.findAll(args)
	if err != nil {
		return err
	}
	var todo []target
	for _, e := range targets {
		switch {
		case e.peer != nil:
			fmt.Fprintf(w, "%s is already connected.\n", e.name())
		case e.p.id == "":
			fmt.Fprintf(w, "tabstack isn't installed in %s. Install it there first.\n", e.name())
		default:
			todo = append(todo, target{e.b, e.p})
		}
	}
	if len(todo) == 0 {
		return nil
	}
	return connectAll(w, s.home, todo)
}

// disconnect has each profile named drop the helper's permission, so it stops
// connecting until it's set up again. With all, every profile that has it.
// It returns how many still have it: those that aren't open can't be reached.
func disconnect(w io.Writer, args []string, all bool) (stillOn int, err error) {
	s, err := openSession()
	if err != nil {
		return 0, err
	}
	defer s.Close()
	targets, err := s.findAll(args)
	if err != nil {
		return 0, err
	}
	if all {
		targets = slices.DeleteFunc(slices.Clone(s.entries), func(e entry) bool { return e.peer == nil && !e.p.granted })
		if len(targets) == 0 {
			fmt.Fprintln(w, "Profile features are already off in every profile.")
		}
	}
	for _, e := range targets {
		if e.peer == nil {
			if !e.p.granted {
				fmt.Fprintf(w, "%s is already off.\n", e.name())
				continue
			}
			stillOn++
			fmt.Fprintf(w, "%s isn't open, so it can't be reached and keeps the permission. Open it, then in tabstack's popup, under Profiles, click Turn off profile features.\n", e.name())
			continue
		}
		id := e.peer.Profile
		err := s.tell(id, map[string]any{"kind": "forget"})
		if errors.Is(err, errGone) {
			// closed since the session started, still with the permission
			stillOn++
			fmt.Fprintf(w, "%s closed before it could be told, so it keeps the permission. Open it, then in tabstack's popup, under Profiles, click Turn off profile features.\n", e.name())
			continue
		}
		if err != nil {
			return stillOn, err
		}
		if s.until(id, func(p *peerInfo) bool { return p == nil }) {
			fmt.Fprintf(w, "Disconnected %s.\n", e.name())
		} else {
			fmt.Fprintf(w, "Asked %s to disconnect, but it hasn't yet.\n", e.name())
			stillOn++
		}
	}
	return stillOn, nil
}

// reset clears a profile's tabstack name and links, back to the browser's
// name for it and none, and has it connect afresh. One that isn't connected
// gets the setup page instead.
func reset(w io.Writer, args []string) error {
	s, err := openSession()
	if err != nil {
		return err
	}
	defer s.Close()
	targets, err := s.findAll(args)
	if err != nil {
		return err
	}
	var todo []target
	for _, e := range targets {
		if e.peer == nil {
			if e.p.id != "" {
				todo = append(todo, target{e.b, e.p})
			}
			continue
		}
		id, name := e.peer.Profile, e.p.name
		if err := s.tell(id, map[string]any{"kind": "reset", "name": name}); err != nil {
			return err
		}
		// it reconnects, under its new name and with no links
		back := s.until(id, func(p *peerInfo) bool { return p != nil && p.Info.Name == name && len(p.Info.Claims) == 0 })
		if back {
			fmt.Fprintf(w, "Reset %s.\n", cmp.Or(name, e.name()))
		} else {
			fmt.Fprintf(w, "Asked %s to reset, but it hasn't come back yet. Check tabstack list.\n", e.name())
		}
	}
	if len(todo) == 0 {
		return nil
	}
	return connectAll(w, s.home, todo)
}

func rename(w io.Writer, arg, name string) error {
	s, err := openSession()
	if err != nil {
		return err
	}
	defer s.Close()
	e, err := s.find(arg)
	if err != nil {
		return err
	}
	if e.peer == nil {
		return fmt.Errorf("%s isn't connected; open it in the browser, or connect it first", e.name())
	}
	id := e.peer.Profile
	if err := s.tell(id, map[string]any{"kind": "rename", "name": name}); err != nil {
		return err
	}
	if !s.until(id, func(p *peerInfo) bool { return p != nil && p.Info.Name == name }) {
		return fmt.Errorf("%s didn't take the name", e.name())
	}
	fmt.Fprintf(w, "Renamed %s to %s.\n", e.name(), name)
	return nil
}

// links lists, adds or removes the links that open in a profile.
func links(w io.Writer, args []string) error {
	if len(args) == 0 || len(args) == 2 {
		return usageError("links")
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
		return fmt.Errorf("%s isn't connected; open it in the browser, or connect it first", e.name())
	}
	current := e.peer.Info.Claims
	if len(args) == 1 {
		if len(current) == 0 {
			fmt.Fprintf(w, "No links open in %s.\n", e.name())
		}
		for _, c := range current {
			fmt.Fprintln(w, c)
		}
		return nil
	}
	next := slices.Clone(current)
	switch args[1] {
	case "add":
		for _, p := range args[2:] {
			if !slices.Contains(next, p) {
				next = append(next, p)
			}
		}
	case "remove":
		next = slices.DeleteFunc(next, func(c string) bool { return slices.Contains(args[2:], c) })
	default:
		return fmt.Errorf("links takes add or remove, not %q", args[1])
	}
	id := e.peer.Profile
	if err := s.tell(id, map[string]any{"kind": "links", "links": next}); err != nil {
		return err
	}
	if !s.until(id, func(p *peerInfo) bool { return p != nil && slices.Equal(p.Info.Claims, next) }) {
		return fmt.Errorf("%s didn't take the change", e.name())
	}
	fmt.Fprintf(w, "Links that open in %s: %s\n", e.name(), cmp.Or(strings.Join(next, ", "), "none"))
	return nil
}
