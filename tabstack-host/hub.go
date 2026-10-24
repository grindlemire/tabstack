package main

import (
	"encoding/json"
	"log"
	"net"
	"os"
	"sort"
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
//	{"type":"state","profile":"<id>","windows":2,"info":{...}}  joined, or something about it changed
//	{"type":"send","to":"<id>","body":{...}}                     for one profile; "*" for every other one
//
// To a profile:
//
//	{"type":"peers","peers":[{"profile":"<id>","windows":2,"info":{...}}, ...]}  everyone connected, itself included
//	{"type":"msg","from":"<id>","body":{...}}
//
// peers goes out to everyone whenever a profile joins, leaves or changes.
//
// The command line (tabstack-host install, list and the rest) watches who's
// connected without joining, and can send profiles commands, which arrive
// from "cli":
//
//	{"type":"watch"}  answered with peers, now and on every change
type hub struct {
	lock *os.File // held while this helper is the hub; closing it would let another take over

	mu    sync.Mutex
	peers map[*peer]bool
}

type peer struct {
	conn    net.Conn
	enc     *json.Encoder
	watch   bool // only listening, for the command line
	profile string
	windows int
	info    json.RawMessage
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
}

type peerInfo struct {
	Profile string          `json:"profile"`
	Windows int             `json:"windows"`
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
		case "state":
			p.profile, p.windows, p.info = m.Profile, m.Windows, m.Info
			h.announce()
		case "watch":
			p.watch = true
			h.write(p, h.peerList())
		case "send":
			if p.profile != "" || p.watch {
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
		if p.profile != "" || p.watch {
			h.write(p, m)
		}
	}
}

func (h *hub) peerList() message {
	list := []peerInfo{}
	for _, p := range h.sorted() {
		list = append(list, peerInfo{Profile: p.profile, Windows: p.windows, Info: p.info})
	}
	return message{Type: "peers", Peers: list}
}

// forward passes a message on to the profile it's for, or to every profile
// but the sender's. Called with h.mu held.
func (h *hub) forward(from *peer, m message) {
	sender := from.profile
	if sender == "" {
		sender = "cli"
	}
	out := message{Type: "msg", From: sender, Body: m.Body}
	for _, p := range h.sorted() {
		if p != from && (m.To == "*" || m.To == p.profile) {
			h.write(p, out)
		}
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
