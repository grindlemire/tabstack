package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// pipeClient watches h over a pipe, as the command line does.
func pipeClient(t *testing.T, h *hub) *hubClient {
	t.Helper()
	conn, theirs := net.Pipe()
	go h.handle(theirs)
	c, err := watchHub(conn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}

// ask gives up on a profile that doesn't answer once the time's up, and
// keeps the answers it got.
func TestAskTimesOut(t *testing.T) {
	h := &hub{peers: map[*peer]bool{}}
	one, toOne := pipePeer(t, h, "1", false)
	pipePeer(t, h, "2", false) // never answers
	c := pipeClient(t, h)
	if len(c.peers) != 2 {
		t.Fatalf("the client sees %d profiles, want 2", len(c.peers))
	}

	go func() {
		for line := range toOne {
			var m message
			var req struct {
				Rid string `json:"rid"`
			}
			if json.Unmarshal(line, &m) != nil || m.Type != "msg" || json.Unmarshal(m.Body, &req) != nil {
				continue
			}
			// an answer to some other request first, which doesn't count
			for _, rid := range []string{"another", req.Rid} {
				body, _ := json.Marshal(map[string]any{"kind": "reply", "rid": rid})
				out, _ := json.Marshal(message{Type: "send", To: m.From, Body: body})
				one.Write(append(out, '\n'))
			}
			return
		}
	}()
	const timeout = 300 * time.Millisecond
	start := time.Now()
	got, err := c.ask("*", map[string]any{"kind": "tabs"}, timeout)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].From != "1" {
		t.Errorf("ask = %v, want the answer from 1", got)
	}
	if took := time.Since(start); took < timeout {
		t.Errorf("ask returned after %v, before the time was up", took)
	}
}

// A hub that's gone leaves its socket and lock behind. liveHubs clears them
// away, unless a helper holds the lock: it's about to listen.
func TestRemovesStaleHubs(t *testing.T) {
	for _, c := range []struct {
		name     string
		lock     string // "free", "held" or "none"
		wantGone bool
	}{
		{"gone", "free", true},
		{"about to listen", "held", false},
		{"no lock", "none", false},
	} {
		t.Run(c.name, func(t *testing.T) {
			base := filepath.Join(sockDir(t), "hub-1")
			ln, err := net.Listen("unix", base+".sock")
			if err != nil {
				t.Fatal(err)
			}
			ln.(*net.UnixListener).SetUnlinkOnClose(false) // as when its process exits
			ln.Close()
			if c.lock != "none" {
				if err := os.WriteFile(base+".lock", nil, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			if c.lock == "held" {
				f, err := tryLock(base+".lock", 0)
				if err != nil || f == nil {
					t.Fatalf("tryLock = %v, %v", f, err)
				}
				defer f.Close()
			}

			if live := liveHubs(filepath.Dir(base)); len(live) != 0 {
				t.Fatalf("liveHubs = %d hubs, want none", len(live))
			}
			_, sockErr := os.Stat(base + ".sock")
			_, lockErr := os.Stat(base + ".lock")
			switch {
			case c.wantGone && (!errors.Is(sockErr, os.ErrNotExist) || !errors.Is(lockErr, os.ErrNotExist)):
				t.Errorf("the socket (%v) and lock (%v) are still there", sockErr, lockErr)
			case !c.wantGone && sockErr != nil:
				t.Errorf("the socket's gone: %v", sockErr)
			}
		})
	}
}

// While the hub moves, no hub has the profiles for a moment; tell waits for
// the profile to turn up rather than give up on it.
func TestTellWaitsForTheHub(t *testing.T) {
	dir := sockDir(t)
	s := &session{dir: dir}
	told := make(chan error, 1)
	go func() { told <- s.tell("2", map[string]any{"kind": "forget"}) }()
	time.Sleep(300 * time.Millisecond)

	h := &hub{peers: map[*peer]bool{}}
	ln, err := net.Listen("unix", filepath.Join(dir, "hub-1.sock"))
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go h.handle(conn)
		}
	}()
	conn, err := net.Dial("unix", filepath.Join(dir, "hub-1.sock"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.Write([]byte(`{"type":"state","profile":"2"}` + "\n")); err != nil {
		t.Fatal(err)
	}
	conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	for sc := bufio.NewScanner(conn); sc.Scan(); {
		var m message
		if json.Unmarshal(sc.Bytes(), &m) == nil && m.Type == "msg" {
			if err := <-told; err != nil {
				t.Errorf("tell: %v", err)
			}
			return
		}
	}
	t.Fatal("the profile was never told")
}

// Once an ask has timed out, the client may have stopped part way through
// a message, and asking again fails rather than answer nothing.
func TestAskAfterTimeout(t *testing.T) {
	h := &hub{peers: map[*peer]bool{}}
	pipePeer(t, h, "1", false) // never answers
	c := pipeClient(t, h)
	if got, err := c.ask("1", map[string]any{"kind": "tabs"}, 100*time.Millisecond); err != nil || len(got) != 0 {
		t.Fatalf("ask = %v, %v; want nothing, once the time's up", got, err)
	}
	if got, err := c.ask("1", map[string]any{"kind": "tabs"}, 100*time.Millisecond); err == nil {
		t.Errorf("asking again = %v, %v; want it to fail", got, err)
	}
	if err := c.next(); err == nil {
		t.Errorf("next after a timeout = nil, want it to fail")
	}
}

// A field of the wrong type in what one profile says about itself loses
// only that field: the command line still sees the hub, and the rest.
func TestOddInfoKeepsTheHub(t *testing.T) {
	h := &hub{peers: map[*peer]bool{}}
	conn, lines := pipePeer(t, h, "1", false)
	info := `{"name":5,"where":"Chrome/Default","claims":"corp.com","done":7}`
	if _, err := conn.Write([]byte(`{"type":"state","profile":"1","info":` + info + "}\n")); err != nil {
		t.Fatal(err)
	}
	for line := range lines {
		if strings.Contains(string(line), info) {
			break
		}
	}
	c := pipeClient(t, h)
	if len(c.peers) != 1 {
		t.Fatalf("the client sees %d profiles, want 1", len(c.peers))
	}
	if p := c.peers[0].Info; p.Where != "Chrome/Default" || p.Name != "" || p.Claims != nil || p.Done != nil {
		t.Errorf("the command line reads %+v", p)
	}
}

func TestProfileInfoFields(t *testing.T) {
	done := "x1"
	for _, c := range []struct {
		in   string
		want profileInfo
	}{
		{`{"name":"Work","where":"Chrome/Default","claims":["a"],"done":"x1"}`, profileInfo{Name: "Work", Where: "Chrome/Default", Claims: []string{"a"}, Done: &done}},
		{`{"Name":"Work"}`, profileInfo{Name: "Work"}}, // as encoding/json matches names
		{`{"name":["Work"],"claims":["a",5],"done":null}`, profileInfo{}},
		{`{"done":7}`, profileInfo{}}, // missing, as from an older tabstack, not ""
		{`"Work"`, profileInfo{}},
		{`[1,2]`, profileInfo{}},
	} {
		var got profileInfo
		if err := json.Unmarshal([]byte(c.in), &got); err != nil {
			t.Errorf("%s: %v", c.in, err)
			continue
		}
		if got.Name != c.want.Name || got.Where != c.want.Where || !slices.Equal(got.Claims, c.want.Claims) ||
			(got.Done == nil) != (c.want.Done == nil) || got.Done != nil && *got.Done != *c.want.Done {
			t.Errorf("%s reads as %+v, want %+v", c.in, got, c.want)
		}
		if raw, _ := json.Marshal(got); string(raw) != c.in {
			t.Errorf("%s is passed on as %s", c.in, raw)
		}
	}
}
