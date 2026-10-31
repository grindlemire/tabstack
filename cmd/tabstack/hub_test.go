package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"net"
	"slices"
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

// The peer list always has peers, even with no one connected, since the
// extension reads it as a list; other messages don't.
func TestPeersAlwaysListed(t *testing.T) {
	h := &hub{peers: map[*peer]bool{}}
	for _, c := range []struct {
		m    message
		want bool
	}{
		{h.peerList(), true},
		{message{Type: "msg", From: "1", Body: json.RawMessage(`{}`)}, false},
		{message{Type: "reconnect"}, false},
	} {
		raw, err := json.Marshal(c.m)
		if err != nil {
			t.Fatal(err)
		}
		var fields map[string]json.RawMessage
		json.Unmarshal(raw, &fields)
		if peers, ok := fields["peers"]; ok != c.want || ok && string(peers) != "[]" {
			t.Errorf("%s, want peers there: %v", raw, c.want)
		}
	}
}

// What a profile says about itself reaches the others as it said it, with
// whatever the command line doesn't read.
func TestInfoPassesThrough(t *testing.T) {
	h := &hub{peers: map[*peer]bool{}}
	info := `{"name":"Work","mark":"🦊 & <b>","claims":["corp.com"],"done":"x1"}`
	conn, toA := pipePeer(t, h, "1", false)
	if _, err := conn.Write([]byte(`{"type":"state","profile":"1","info":` + info + "}\n")); err != nil {
		t.Fatal(err)
	}
	var got message
	for deadline := time.After(time.Second); len(got.Peers) == 0 || got.Peers[0].Info.IsZero(); {
		select {
		case line := <-toA:
			if !bytes.Contains(line, []byte(info)) {
				continue
			}
			if err := json.Unmarshal(line, &got); err != nil {
				t.Fatal(err)
			}
		case <-deadline:
			t.Fatalf("no peer list with the info %s", info)
		}
	}
	p := got.Peers[0].Info
	if p.Name != "Work" || !slices.Equal(p.Claims, []string{"corp.com"}) || p.Done == nil || *p.Done != "x1" {
		t.Errorf("the command line reads %+v", p)
	}
	var out bytes.Buffer
	if newEncoder(&out).Encode(got.Peers[0]); !bytes.Contains(out.Bytes(), []byte(info)) {
		t.Errorf("passed on as %s, want the info as it came", &out)
	}

	// and a profile that hasn't said anything has no info
	var none peerInfo
	if err := json.Unmarshal([]byte(`{"profile":"2","info":null}`), &none); err != nil || !none.Info.IsZero() {
		t.Errorf("info null = %+v, %v", none.Info, err)
	}
	if raw, _ := json.Marshal(peerInfo{Profile: "2"}); string(raw) != `{"profile":"2","windows":0}` {
		t.Errorf("a profile with no info = %s", raw)
	}
}

// A message with a field of the wrong type is skipped, and the connection
// kept: dropping it would have the helper rejoin and send it again, over
// and over.
func TestHubSkipsBadlyTyped(t *testing.T) {
	h := &hub{peers: map[*peer]bool{}}
	conn, lines := pipePeer(t, h, "1", false)
	for _, m := range []string{
		`{"type":"state","profile":"1","windows":"2"}`,
		`{"type":"state","profile":"1","windows":1.5}`,
		`"state"`,
		`{"type":"state","profile":"1","windows":3}`,
	} {
		if _, err := conn.Write([]byte(m + "\n")); err != nil {
			t.Fatalf("writing %s: %v", m, err)
		}
	}
	for deadline := time.After(3 * time.Second); ; {
		select {
		case line, ok := <-lines:
			if !ok {
				t.Fatal("the hub dropped the connection")
			}
			if bytes.Contains(line, []byte(`"windows":3`)) {
				return
			}
			if bytes.Contains(line, []byte(`"windows":2`)) {
				t.Errorf("the hub took part of a bad message: %s", line)
			}
		case <-deadline:
			t.Fatal("the message after the bad ones was never announced")
		}
	}
}
