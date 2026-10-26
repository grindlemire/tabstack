package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"time"
)

// writeTimeout keeps a helper that stopped reading from holding up the hub.
const writeTimeout = time.Second

// hub routes messages between the helpers of one browser's profiles, one
// connection per profile. It knows nothing about what the profiles say to
// each other; it only tracks who's connected and forwards. Messages are JSON
// values, one per line.
//
// From a profile:
//
//	{"type":"hello","version":"1.2.0","binary":"<file>"}         the helper passing its messages on, first thing
//	{"type":"state","profile":"<id>","windows":2,"info":{...}}  joined, or something about it changed
//	{"type":"send","to":"<id>","body":{...}}                     for one profile; "*" for every other one
//
// To a profile:
//
//	{"type":"peers","version":"1.2.0","peers":[{"profile":"<id>","windows":2,"version":"1.2.0","info":{...}}, ...]}
//	    everyone connected, itself included, and the hub's version
//	{"type":"msg","from":"<id>","body":{...}}
//	{"type":"reconnect"}  a new helper is installed: connect again, so the browser starts it
//
// peers goes out to everyone whenever a profile joins, leaves or changes.
//
// The command line (tabstack install, list and the rest) watches who's
// connected without joining, and can send profiles commands, which arrive
// from "cli-<n>", where answers to it go:
//
//	{"type":"watch"}  answered with peers, now and on every change
type hub struct {
	lock *os.File // held while this helper is the hub; closing it would let another take over

	mu    sync.Mutex
	peers map[*peer]bool
	clis  int // watchers so far, to give each an address
}

type peer struct {
	conn    net.Conn
	enc     *json.Encoder
	cli     string // a watcher's address, for the command line
	profile string
	windows int
	info    json.RawMessage
	version string // of its helper
	binary  string // its helper's file (fileID)
	asked   string // the file it was last asked to move to
}

type message struct {
	Type    string          `json:"type"`
	Profile string          `json:"profile,omitempty"`
	Windows int             `json:"windows,omitempty"`
	Info    json.RawMessage `json:"info,omitempty"`
	To      string          `json:"to,omitempty"`
	From    string          `json:"from,omitempty"`
	Body    json.RawMessage `json:"body,omitempty"`
	Peers   []peerInfo      `json:"peers,omitempty"`
	Version string          `json:"version,omitempty"`
	Binary  string          `json:"binary,omitempty"`
}

type peerInfo struct {
	Profile string          `json:"profile"`
	Windows int             `json:"windows"`
	Version string          `json:"version,omitempty"`
	Info    json.RawMessage `json:"info,omitempty"`
}

func (h *hub) serve(ln net.Listener) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			log.Printf("hub: accept: %v", err)
			time.Sleep(100 * time.Millisecond)
			continue
		}
		go h.handle(conn)
	}
}

func (h *hub) handle(conn net.Conn) {
	p := &peer{conn: conn, enc: json.NewEncoder(conn)}
	h.mu.Lock()
	h.peers[p] = true
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.peers, p)
		if p.profile != "" {
			h.announce()
		}
		h.mu.Unlock()
		conn.Close()
	}()

	dec := json.NewDecoder(conn)
	for {
		var m message
		if err := dec.Decode(&m); err != nil {
			return
		}
		h.mu.Lock()
		switch m.Type {
		case "hello":
			p.version, p.binary = m.Version, m.Binary
		case "state":
			p.profile, p.windows, p.info = m.Profile, m.Windows, m.Info
			h.announce()
		case "watch":
			h.clis++
			p.cli = fmt.Sprintf("cli-%d", h.clis)
			h.write(p, h.peerList())
		case "send":
			if p.profile != "" || p.cli != "" {
				h.forward(p, m)
			}
		}
		h.mu.Unlock()
	}
}

// announce tells every profile, and anyone watching, who's connected.
// Called with h.mu held.
func (h *hub) announce() {
	m := h.peerList()
	for p := range h.peers {
		if p.profile != "" || p.cli != "" {
			h.write(p, m)
		}
	}
}

func (h *hub) peerList() message {
	list := []peerInfo{}
	for _, p := range h.sorted() {
		list = append(list, peerInfo{Profile: p.profile, Windows: p.windows, Version: p.version, Info: p.info})
	}
	return message{Type: "peers", Version: version, Peers: list}
}

// forward passes a message on to the profile or watcher it's for, or to
// every profile but the sender's. Called with h.mu held.
func (h *hub) forward(from *peer, m message) {
	out := message{Type: "msg", From: from.profile, Body: m.Body}
	if from.profile == "" {
		out.From = from.cli
	}
	for _, p := range h.sorted() {
		if p != from && (m.To == "*" || m.To == p.profile) {
			h.write(p, out)
		}
	}
	for p := range h.peers {
		if p.cli != "" && p.cli == m.To {
			h.write(p, out)
		}
	}
}

// exeCheck is how often the hub looks for a new helper installed where
// browsers start this one.
var exeCheck = 30 * time.Second

// watchExe moves every profile to a new helper once one's installed in this
// one's place (by brew upgrade, or go install), rather than leaving them on
// this one until the browser restarts. Each profile whose helper is another
// build is asked, once, to connect again, and the browser starts the new one
// for it. The profile whose helper is the hub goes too, so the hub moves.
func (h *hub) watchExe() {
	path, err := helperPath()
	if err != nil {
		return
	}
	if d, err := time.ParseDuration(os.Getenv("TABSTACK_TEST_EXE_CHECK")); err == nil {
		exeCheck = d
	}
	runs := map[string]bool{} // builds found at path that answered
	for range time.Tick(exeCheck) {
		id := fileID(path)
		if id == "" {
			continue
		}
		h.mu.Lock()
		var stale []*peer
		for p := range h.peers {
			if p.profile != "" && p.binary != id && p.asked != id {
				stale = append(stale, p)
			}
		}
		h.mu.Unlock()
		if len(stale) == 0 {
			continue
		}
		if !runs[id] {
			// one still being written doesn't run yet
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			out, err := exec.CommandContext(ctx, path, "version").Output()
			cancel()
			if err != nil {
				continue
			}
			runs[id] = true
			log.Printf("hub: %s is now %s; moving profiles to it", path, strings.TrimSpace(string(out)))
		}
		h.mu.Lock()
		for _, p := range stale {
			if h.peers[p] {
				p.asked = id
				h.write(p, message{Type: "reconnect"})
			}
		}
		h.mu.Unlock()
	}
}

func (h *hub) write(p *peer, m message) {
	p.conn.SetWriteDeadline(time.Now().Add(writeTimeout))
	if err := p.enc.Encode(m); err != nil {
		log.Printf("hub: writing to %s: %v", p.profile, err)
	}
}

// sorted lists the profiles that have said who they are, in a fixed order.
func (h *hub) sorted() []*peer {
	var list []*peer
	for p := range h.peers {
		if p.profile != "" {
			list = append(list, p)
		}
	}
	sort.Slice(list, func(i, j int) bool { return list[i].profile < list[j].profile })
	return list
}
