package main

import (
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"slices"
	"strings"
	"sync"
	"time"
)

// writeTimeout keeps a helper that stopped reading from holding up the hub.
const writeTimeout = time.Second

// hub routes messages between the helpers of one browser's profiles; what
// they send it is in protocol.go.
type hub struct {
	lock *os.File // held while this helper is the hub; closing it would let another take over
	exe  string   // this helper's file, by a path that lasts: watched for a new build

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
	p := &peer{conn: conn, enc: newEncoder(conn)}
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
	for p := range h.peers {
		if p.profile != "" {
			list = append(list, peerInfo{Profile: p.profile, Windows: p.windows, Version: p.version, Info: profileInfo{raw: p.info}})
		}
	}
	// in a fixed order, which the extension cycles through
	slices.SortFunc(list, func(a, b peerInfo) int { return strings.Compare(a.Profile, b.Profile) })
	return message{Type: "peers", Version: version, Path: h.exe, Peers: list}
}

// forward passes a message on to the profile or watcher it's for, or to
// every profile but the sender's. Called with h.mu held.
func (h *hub) forward(from *peer, m message) {
	out := message{Type: "msg", From: cmp.Or(from.profile, from.cli), Body: m.Body}
	for p := range h.peers {
		if p == from {
			continue
		}
		if p.profile != "" && (m.To == "*" || m.To == p.profile) || p.cli != "" && p.cli == m.To {
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
	path := h.exe
	if path == "" {
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

// write sends a peer a message. One that fails can leave part of it on the
// connection, and whatever followed would be read as part of it, so the
// connection's closed instead: the peer's helper joins again, from scratch.
func (h *hub) write(p *peer, m message) {
	p.conn.SetWriteDeadline(time.Now().Add(writeTimeout))
	if err := p.enc.Encode(m); err != nil {
		log.Printf("hub: writing to %s: %v", cmp.Or(p.profile, p.cli), err)
		p.conn.Close()
	}
}
