package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"net"
	"testing"
	"time"
)

// pipePeer joins h over a pipe as profile, and returns once the hub's
// announced it, with its end of the pipe and every line the hub sends it
// after that. A stalled one stops reading after the announcement.
func pipePeer(t *testing.T, h *hub, profile string, stalled bool) (net.Conn, chan []byte) {
	t.Helper()
	conn, theirs := net.Pipe()
	t.Cleanup(func() { conn.Close() })
	go h.handle(theirs)
	lines := make(chan []byte, 100)
	go func() {
		defer close(lines)
		r := bufio.NewReader(conn)
		for {
			line, err := r.ReadBytes('\n')
			if err != nil {
				return
			}
			lines <- line
			if stalled {
				return
			}
		}
	}()
	if _, err := conn.Write([]byte(`{"type":"state","profile":"` + profile + `"}` + "\n")); err != nil {
		t.Fatal(err)
	}
	select {
	case <-lines:
	case <-time.After(3 * time.Second):
		t.Fatal("never announced")
	}
	return conn, lines
}

// A body reaches the profile it's for as it was sent, not escaped for HTML,
// which would make it longer.
func TestHubPassesBodiesThrough(t *testing.T) {
	h := &hub{peers: map[*peer]bool{}}
	a, _ := pipePeer(t, h, "1", false)
	_, toB := pipePeer(t, h, "2", false)
	for _, body := range []string{
		`{"title":"Q&A <b>here</b> -> there"}`,
		`{"url":"https://example.com/?a=1&b=2"}`,
		`"<script>&amp;</script>"`,
	} {
		if _, err := a.Write([]byte(`{"type":"send","to":"2","body":` + body + "}\n")); err != nil {
			t.Fatal(err)
		}
		var got struct {
			Type string          `json:"type"`
			Body json.RawMessage `json:"body"`
		}
		for deadline := time.After(time.Second); got.Type != "msg"; {
			select {
			case line := <-toB:
				json.Unmarshal(line, &got)
			case <-deadline:
				t.Fatalf("no message for %s", body)
			}
		}
		if !bytes.Equal(got.Body, []byte(body)) {
			t.Errorf("body = %s, want %s", got.Body, body)
		}
	}
}

// A profile whose helper stopped reading is disconnected once a write to it
// times out, rather than sent the rest after a message cut off part way, and
// the others are told it's gone.
func TestHubDropsStalledPeer(t *testing.T) {
	h := &hub{peers: map[*peer]bool{}}
	pipePeer(t, h, "1", true)
	_, toB := pipePeer(t, h, "2", false) // announcing it writes to the stalled one
	for deadline := time.After(3 * time.Second); ; {
		select {
		case line := <-toB:
			if bytes.Contains(line, []byte(`"peers":[{"profile":"2"`)) {
				return
			}
		case <-deadline:
			t.Fatal("the others weren't told it left")
		}
	}
}
