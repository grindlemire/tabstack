package main

import (
	"encoding/json"
	"io"
	"slices"
)

// The hub routes messages between the helpers of one browser's profiles, one
// connection per profile (hub.go). It knows nothing about what the profiles
// say to each other; it only tracks who's connected and forwards. Messages
// are JSON values, one per line.
//
// From a profile:
//
//	{"type":"hello","version":"1.2.0","binary":"<file>"}         the helper passing its messages on, first thing
//	{"type":"state","profile":"<id>","windows":2,"info":{...}}  joined, or something about it changed
//	{"type":"send","to":"<id>","body":{...}}                     for one profile; "*" for every other one
//
// To a profile:
//
//	{"type":"peers","version":"1.2.0","path":"<file>","peers":[{"profile":"<id>","windows":2,"version":"1.2.0","info":{...}}, ...]}
//	    everyone connected, itself included, and the hub's version and
//	    helper (where it watches for a new build)
//	{"type":"msg","from":"<id>","body":{...}}
//	{"type":"reconnect"}  a new helper is installed: connect again, so the browser starts it
//
// peers goes out to everyone whenever a profile joins, leaves or changes.
//
// The command line (tabstack install, list and the rest; client.go) watches
// who's connected without joining, and can send profiles commands, which
// arrive from "cli-<n>", where answers to it go:
//
//	{"type":"watch"}  answered with peers, now and on every change

// message is any of the above.
type message struct {
	Type    string          `json:"type"`
	Profile string          `json:"profile,omitempty"`
	Windows int             `json:"windows,omitempty"`
	Info    json.RawMessage `json:"info,omitempty"`
	To      string          `json:"to,omitempty"`
	From    string          `json:"from,omitempty"`
	Body    json.RawMessage `json:"body,omitempty"`
	// Always there in a peers message, even empty, since the extension
	// reads it as a list: omitzero leaves out only a nil one.
	Peers   []peerInfo `json:"peers,omitzero"`
	Version string     `json:"version,omitempty"`
	Binary  string     `json:"binary,omitempty"`
	Path    string     `json:"path,omitempty"`
}

// peerInfo is a connected profile, as the hub lists it.
type peerInfo struct {
	Profile string      `json:"profile"`
	Windows int         `json:"windows"`
	Version string      `json:"version,omitempty"` // of the helper passing its messages on
	Info    profileInfo `json:"info,omitzero"`
}

// profileInfo is what a profile says about itself. What's in it is up to
// the extension, so the hub passes it on as it came; the command line reads
// these fields.
type profileInfo struct {
	Name   string   `json:"name"`
	Where  string   `json:"where"` // browser/profile folder, once set up by install
	Claims []string `json:"claims"`
	// the install run whose setup page was last finished with Done; missing
	// altogether from a tabstack too old to say
	Done *string `json:"done"`

	raw json.RawMessage // all of it, which is what's sent: the fields above are only read
}

func (i profileInfo) IsZero() bool { return len(i.raw) == 0 }

func (i profileInfo) MarshalJSON() ([]byte, error) {
	if len(i.raw) == 0 {
		return []byte("null"), nil
	}
	return i.raw, nil
}

// UnmarshalJSON reads each field on its own, and leaves out one of the wrong
// type, rather than failing: info comes from any build of the extension, or
// anything else that joins the hub, and one profile's odd field would
// otherwise hide the whole hub from the command line.
func (i *profileInfo) UnmarshalJSON(b []byte) error {
	*i = profileInfo{}
	if string(b) == "null" {
		return nil
	}
	var f struct{ Name, Where, Claims, Done json.RawMessage }
	json.Unmarshal(b, &f) // a value that isn't an object has no fields
	field(f.Name, &i.Name)
	field(f.Where, &i.Where)
	field(f.Claims, &i.Claims)
	field(f.Done, &i.Done)
	i.raw = slices.Clone(b) // b is the decoder's, and reused
	return nil
}

// field reads raw into to, leaving it as it was when raw is missing or
// isn't a T.
func field[T any](raw json.RawMessage, to *T) {
	var v T
	if json.Unmarshal(raw, &v) == nil {
		*to = v
	}
}

// newEncoder writes messages as they came. By default an encoder escapes
// &, < and > in bodies, making them up to six times longer, and a reply the
// extension sized to fit the browser's limit would no longer fit.
func newEncoder(w io.Writer) *json.Encoder {
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	return enc
}
