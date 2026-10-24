package main

import (
	"strings"
	"testing"
)

func TestFind(t *testing.T) {
	work := hubPeer{Profile: "p2"}
	work.Info.Name = "Work"
	s := &session{}
	s.entries = []entry{
		{n: 1, p: profile{dir: "Default", name: "joel@example.com"}},
		{n: 2, p: profile{dir: "Profile 1", name: "Person 1"}, peer: &work},
		{n: 3, p: profile{dir: "Profile 2", name: "Side"}},
		{n: 4, p: profile{dir: "Default", name: "Side"}}, // another browser's
	}
	cases := []struct {
		arg  string
		want int
		err  string
	}{
		{arg: "2", want: 2},
		{arg: "work", want: 2},     // the name tabstack goes by
		{arg: "Person 1", want: 2}, // or the browser's name for it
		{arg: "profile 2", want: 3},
		{arg: "5", err: "no profile 5"},
		{arg: "Personal", err: "no profile called"},
		{arg: "Side", err: "could be profile 3 or 4"},
		{arg: "default", err: "could be profile 1 or 4"},
	}
	for _, tc := range cases {
		got, err := s.find(tc.arg)
		switch {
		case tc.err != "":
			if err == nil || !strings.Contains(err.Error(), tc.err) {
				t.Errorf("find(%q) = %d, %v; want an error with %q", tc.arg, got.n, err, tc.err)
			}
		case err != nil || got.n != tc.want:
			t.Errorf("find(%q) = %d, %v; want %d", tc.arg, got.n, err, tc.want)
		}
	}
}

// The command line watches the hub and can send a profile a command, which
// arrives from "cli".
func TestCommandLineSends(t *testing.T) {
	exe, dir := buildHelper(t)
	a, b := startHelper(t, exe, dir), startHelper(t, exe, dir)
	a.send(t, state("1", 1))
	b.send(t, state("2", 1))
	b.expectPeers(t, "1", "2")

	live := liveHubs(dir)
	if len(live) != 1 {
		t.Fatalf("liveHubs = %d hubs, want 1", len(live))
	}
	defer live[0].Close()
	if err := live[0].send("2", map[string]any{"kind": "rename", "name": "Work"}); err != nil {
		t.Fatal(err)
	}
	got := b.expect(t, "msg")
	if body := got["body"].(map[string]any); got["from"] != "cli" || body["kind"] != "rename" {
		t.Errorf("b got %v", got)
	}
	a.expectNothing(t)
}
