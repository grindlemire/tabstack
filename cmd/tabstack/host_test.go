package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// helper is one copy of the binary, started the way a browser starts it.
type helper struct {
	cmd *exec.Cmd
	in  io.WriteCloser
	out chan map[string]any
}

func startHelper(t *testing.T, exe, dir string) *helper {
	t.Helper()
	cmd := exec.Command(exe, "chrome-extension://abcdefghijklmnopabcdefghijklmnop/")
	// a home of its own, so repairing registrations never reaches the real ones
	cmd.Env = append(os.Environ(), "TABSTACK_HOST_DIR="+dir, "HOME="+dir)
	in, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	h := &helper{cmd: cmd, in: in, out: make(chan map[string]any, 100)}
	go func() {
		for {
			msg, err := readFrame(stdout)
			if err != nil {
				return
			}
			var m map[string]any
			json.Unmarshal(msg, &m)
			h.out <- m
		}
	}()
	t.Cleanup(func() {
		cmd.Process.Kill()
		cmd.Wait()
	})
	return h
}

func (h *helper) send(t *testing.T, v any) {
	t.Helper()
	b, _ := json.Marshal(v)
	if err := writeFrame(h.in, b); err != nil {
		t.Fatal(err)
	}
}

// expect waits for the next message of the given type, skipping peer lists
// unless that's what it's waiting for.
func (h *helper) expect(t *testing.T, want string) map[string]any {
	t.Helper()
	deadline := time.After(3 * time.Second)
	for {
		select {
		case m := <-h.out:
			if m["type"] == want {
				return m
			}
			if m["type"] != "peers" {
				t.Fatalf("got %v, want a %q message", m, want)
			}
		case <-deadline:
			t.Fatalf("no %q message", want)
			return nil
		}
	}
}

// expectPeers waits for a peer list naming exactly these profiles, in order.
func (h *helper) expectPeers(t *testing.T, want ...string) {
	t.Helper()
	deadline := time.After(3 * time.Second)
	var last []string
	for {
		select {
		case m := <-h.out:
			if m["type"] != "peers" {
				continue
			}
			last = nil
			for _, p := range m["peers"].([]any) {
				last = append(last, p.(map[string]any)["profile"].(string))
			}
			if strings.Join(last, ",") == strings.Join(want, ",") {
				return
			}
		case <-deadline:
			t.Fatalf("peers = %v, want %v", last, want)
		}
	}
}

// deliver sends a message from one helper until another gets it. While the
// hub moves to another helper, a message can be lost; the old hub announces
// who's left as it goes, before the others have rejoined the new one.
func deliver(t *testing.T, from *helper, msg map[string]any, to *helper) {
	t.Helper()
	for range 20 {
		from.send(t, msg)
		deadline := time.After(250 * time.Millisecond)
	wait:
		for {
			select {
			case m := <-to.out:
				if m["type"] == "msg" {
					return
				}
			case <-deadline:
				break wait
			}
		}
	}
	t.Fatal("message never arrived")
}

func (h *helper) expectNothing(t *testing.T) {
	t.Helper()
	deadline := time.After(200 * time.Millisecond)
	for {
		select {
		case m := <-h.out:
			if m["type"] != "peers" {
				t.Fatalf("got %v, want nothing", m)
			}
		case <-deadline:
			return
		}
	}
}

func buildHelper(t *testing.T) (exe, dir string) {
	t.Helper()
	exe = filepath.Join(t.TempDir(), "tabstack")
	if out, err := exec.Command("go", "build", "-o", exe, ".").CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	return exe, sockDir(t)
}

// sockDir is a folder for hubs' sockets. Unix socket paths are limited to
// about 100 bytes, which t.TempDir() can pass on macOS.
func sockDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "ts")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}

func state(profile string, windows int) map[string]any {
	return map[string]any{"type": "state", "profile": profile, "windows": windows, "info": map[string]any{"name": "P" + profile}}
}

func sendTo(to string, body map[string]any) map[string]any {
	return map[string]any{"type": "send", "to": to, "body": body}
}

// Helpers started together, as at browser launch, race to be the hub. One
// wins: everyone sees everyone, and messages reach the profile they're for.
func TestRouting(t *testing.T) {
	exe, dir := buildHelper(t)
	a, b, c := startHelper(t, exe, dir), startHelper(t, exe, dir), startHelper(t, exe, dir)
	a.send(t, state("1", 1))
	b.send(t, state("2", 2))
	c.send(t, state("3", 0))
	for _, h := range []*helper{a, b, c} {
		h.expectPeers(t, "1", "2", "3")
	}

	a.send(t, sendTo("2", map[string]any{"kind": "focus", "left": 10}))
	got := b.expect(t, "msg")
	if body, _ := got["body"].(map[string]any); got["from"] != "1" || body["kind"] != "focus" || body["left"] != 10.0 {
		t.Errorf("b got %v", got)
	}
	a.expectNothing(t)
	c.expectNothing(t)

	// "*" reaches everyone but the sender
	b.send(t, sendTo("*", map[string]any{"kind": "hide"}))
	a.expect(t, "msg")
	c.expect(t, "msg")
	b.expectNothing(t)

	// the peer list carries what each profile says about itself
	c.send(t, map[string]any{"type": "state", "profile": "3", "windows": 1, "info": map[string]any{"name": "Work"}})
	for {
		m := a.expect(t, "peers")
		peers := m["peers"].([]any)
		if p := peers[2].(map[string]any); p["windows"] == 1.0 && p["info"].(map[string]any)["name"] == "Work" {
			break
		}
	}
}

// When the profile whose helper is the hub closes, another helper takes
// over, and the others tell it who they are again.
func TestHubHandsOver(t *testing.T) {
	exe, dir := buildHelper(t)
	a := startHelper(t, exe, dir)
	a.send(t, state("1", 1))
	a.expectPeers(t, "1") // a is the hub
	b, c := startHelper(t, exe, dir), startHelper(t, exe, dir)
	b.send(t, state("2", 1))
	c.send(t, state("3", 1))
	b.expectPeers(t, "1", "2", "3")
	c.expectPeers(t, "1", "2", "3")

	a.in.Close()
	a.cmd.Wait()
	b.expectPeers(t, "2", "3")
	c.expectPeers(t, "2", "3")
	deliver(t, b, sendTo("3", map[string]any{"kind": "x"}), c)

	d := startHelper(t, exe, dir)
	d.send(t, state("4", 1))
	c.expectPeers(t, "2", "3", "4")
	d.send(t, sendTo("2", map[string]any{"kind": "x"}))
	b.expect(t, "msg")
}

// Two profiles sending each other big messages at once all get through: a
// helper keeps reading from the hub while it's busy writing to it, so the
// hub, writing to that helper, never gives up on it.
func TestCrossTraffic(t *testing.T) {
	exe, dir := buildHelper(t)
	a, b := startHelper(t, exe, dir), startHelper(t, exe, dir)
	a.send(t, state("1", 1))
	b.send(t, state("2", 1))
	a.expectPeers(t, "1", "2")
	b.expectPeers(t, "1", "2")

	const n = 30
	pad := strings.Repeat("x", 200<<10)
	for _, s := range []struct {
		from *helper
		to   string
	}{{a, "2"}, {b, "1"}} {
		// what doesn't get sent doesn't arrive, which is what's checked
		go func() {
			for i := range n {
				msg, _ := json.Marshal(sendTo(s.to, map[string]any{"i": i, "pad": pad}))
				if writeFrame(s.from.in, msg) != nil {
					return
				}
			}
		}()
	}
	got := map[*helper]int{}
	for deadline := time.After(10 * time.Second); got[a] < n || got[b] < n; {
		select {
		case m := <-a.out:
			if m["type"] == "msg" {
				got[a]++
			}
		case m := <-b.out:
			if m["type"] == "msg" {
				got[b]++
			}
		case <-deadline:
			t.Fatalf("a got %d/%d, b got %d/%d", got[a], n, got[b], n)
		}
	}
}

// A message too big for the browser is dropped rather than sent, since
// Chrome closes the connection over one.
func TestDropsOversize(t *testing.T) {
	exe, dir := buildHelper(t)
	a, b := startHelper(t, exe, dir), startHelper(t, exe, dir)
	a.send(t, state("1", 1))
	b.send(t, state("2", 1))
	a.expectPeers(t, "1", "2")
	b.expectPeers(t, "1", "2")

	a.send(t, sendTo("2", map[string]any{"kind": "big", "pad": strings.Repeat("x", maxWrite)}))
	a.send(t, sendTo("2", map[string]any{"kind": "small"}))
	got := b.expect(t, "msg")
	if body := got["body"].(map[string]any); body["kind"] != "small" {
		t.Errorf("b got %v first, want the small message", body["kind"])
	}
}

// A helper the hub keeps dropping (a hub too old to skip a message it
// can't read, say) waits longer before each rejoin, rather than spin and
// fill host.log.
func TestRejoinBacksOff(t *testing.T) {
	exe, dir := buildHelper(t)
	// the hub of the browser that starts the helper, this test
	ln, err := net.Listen("unix", filepath.Join(dir, fmt.Sprintf("hub-%d.sock", os.Getpid())))
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	var joins atomic.Int64
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			joins.Add(1)
			conn.Close()
		}
	}()
	h := startHelper(t, exe, dir)
	h.send(t, state("1", 1))
	time.Sleep(1500 * time.Millisecond)
	// at once, then after 100ms, 200ms, 400ms and 800ms
	if n := joins.Load(); n > 10 {
		t.Errorf("the helper joined %d times in 1.5s", n)
	}
	if info, err := os.Stat(filepath.Join(dir, "host.log")); err != nil || info.Size() > maxLog {
		t.Errorf("host.log: %v, %v", info.Size(), err)
	}
}

// host.log is cleared once it's grown past maxLog, while the helper runs.
func TestCappedLog(t *testing.T) {
	path := filepath.Join(t.TempDir(), "host.log")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	l := cappedLog{f}
	line := []byte(strings.Repeat("x", 99) + "\n")
	for range 3 * maxLog / len(line) {
		if _, err := l.Write(line); err != nil {
			t.Fatal(err)
		}
	}
	if info, err := os.Stat(path); err != nil || info.Size() > maxLog+int64(len(line)) {
		t.Errorf("host.log is %d bytes, over %d", info.Size(), maxLog)
	}
}
