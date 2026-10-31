package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The cases tabstack's own covers runs too (src/background/covers.test.ts),
// so the command line opens a link where the browser would move it.
func TestCovers(t *testing.T) {
	data, err := os.ReadFile("../../testdata/covers.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Pattern string `json:"pattern"`
		URL     string `json:"url"`
		Covers  bool   `json:"covers"`
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, tc := range cases {
		u, err := url.Parse(tc.URL)
		if err != nil {
			t.Fatal(err)
		}
		if got := covers(tc.Pattern, u); got != tc.Covers {
			t.Errorf("covers(%q, %s) = %v, want %v", tc.Pattern, tc.URL, got, tc.Covers)
		}
	}
}

// A claim is anyone's who joins the hub, and one too big for regexp, or big
// enough to take seconds to compile, matches nothing rather than crash or
// stall tabstack open.
func TestCoversHugePattern(t *testing.T) {
	u, _ := url.Parse("https://corp.com/a/b")
	for _, pattern := range []string{
		strings.Repeat("*", 2<<20),               // too large to compile
		"corp.com/" + strings.Repeat("*", 1<<20), // compiles, slowly
		"corp.com/" + strings.Repeat("*", maxPattern),
		strings.Repeat("corp.com", maxPattern),
	} {
		start := time.Now()
		if covers(pattern, u) {
			t.Errorf("a %d-byte pattern covers %s", len(pattern), u)
		}
		if took := time.Since(start); took > 100*time.Millisecond {
			t.Errorf("a %d-byte pattern took %v", len(pattern), took)
		}
	}
	if !covers("corp.com/"+strings.Repeat("*", maxPattern-len("corp.com/")), u) {
		t.Errorf("a pattern of maxPattern bytes doesn't count")
	}
}

// Go's flag stops at the first argument that isn't one, so a flag after it
// would be opened as a link, or searched for; it's refused instead. A lone
// "-" is a word like any other.
func TestFlagsAfterArgs(t *testing.T) {
	isolate(t)
	for _, c := range []struct {
		args []string
		want string
	}{
		{[]string{"open", "example.com", "--profile", "Work"}, "--profile: flags go before the links"},
		{[]string{"open", "a.com", "b.com", "-profile=Work"}, "-profile=Work: flags go before the links"},
		{[]string{"tabs", "foo", "--json"}, "--json: flags go before the words"},
		{[]string{"tabs", "--json", "foo", "-"}, "no profile is connected"},
		{[]string{"install", "x", "--extension-id", storeID}, "--extension-id: flags go before the rest"},
	} {
		err := run(c.args, io.Discard)
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%q: %v, want %q", c.args, err, c.want)
		}
	}
}

// -h prints a command's flags, and isn't a mistake.
func TestHelpFlag(t *testing.T) {
	isolate(t)
	for _, cmd := range []string{"tabs", "open", "install"} {
		if err := run([]string{cmd, "-h"}, io.Discard); err != nil {
			t.Errorf("%s -h: %v", cmd, err)
		}
	}
}

// isolate keeps a test that runs commands from the real browsers and hubs,
// and from starting anything: there's no program to start.
func isolate(t *testing.T) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("TABSTACK_HOST_DIR", sockDir(t))
	t.Setenv("TABSTACK_TEST_BROWSER", "")
	t.Setenv("PATH", t.TempDir())
}

// serveHub serves the hub of browser n on its socket in dir, by handle.
func serveHub(t *testing.T, dir string, n int, handle func(net.Conn)) {
	t.Helper()
	ln, err := net.Listen("unix", filepath.Join(dir, fmt.Sprintf("hub-%d.sock", n)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go handle(conn)
		}
	}()
}

// answerTabs joins h as profile, and answers each request for tabs with
// these.
func answerTabs(t *testing.T, h *hub, profile string, tabs []tab) {
	t.Helper()
	conn, lines := pipePeer(t, h, profile, false)
	go func() {
		for line := range lines {
			var m message
			var req struct {
				Rid string `json:"rid"`
			}
			if json.Unmarshal(line, &m) != nil || m.Type != "msg" || json.Unmarshal(m.Body, &req) != nil {
				continue
			}
			body, _ := json.Marshal(map[string]any{"kind": "reply", "rid": req.Rid, "tabs": tabs})
			out, _ := json.Marshal(message{Type: "send", To: m.From, Body: body})
			conn.Write(append(out, '\n'))
		}
	}()
}

// brokenHub lists one profile, then cuts the connection part way through
// its answer.
func brokenHub(conn net.Conn) {
	defer conn.Close()
	r := bufio.NewReader(conn)
	r.ReadBytes('\n') // watch
	conn.Write([]byte(`{"type":"peers","peers":[{"profile":"9","windows":1}]}` + "\n"))
	r.ReadBytes('\n') // the request
	conn.Write([]byte(`{"type":"msg","from":"9","bo`))
}

// One browser's helper going away while tabs asks loses only its tabs; the
// rest are listed, and the command says what went wrong.
func TestTabsKeepsOtherHubs(t *testing.T) {
	isolate(t)
	dir := os.Getenv("TABSTACK_HOST_DIR")
	h := &hub{peers: map[*peer]bool{}}
	serveHub(t, dir, 1, h.handle)
	serveHub(t, dir, 2, brokenHub)
	answerTabs(t, h, "1", []tab{{ID: 7, Title: "kept", URL: "https://corp.com/"}})

	var out strings.Builder
	err := run([]string{"tabs", "--json"}, &out)
	if !strings.Contains(out.String(), `"title":"kept"`) {
		t.Errorf("tabs printed %q, want the tab from the hub that answered", out.String())
	}
	if err == nil || !strings.Contains(err.Error(), "lost a browser's helper") {
		t.Errorf("tabs: %v, want it to say a hub was lost", err)
	}
}

// A page picks its title, and the escapes in one never reach the terminal:
// tabs leaves out control characters, and --json escapes them.
func TestTabsEscapes(t *testing.T) {
	isolate(t)
	h := &hub{peers: map[*peer]bool{}}
	serveHub(t, os.Getenv("TABSTACK_HOST_DIR"), 1, h.handle)
	title := "evil\x1b]0;pwned\x07\x1b[2J ti\u009b31mtle\x7f"
	answerTabs(t, h, "1", []tab{{ID: 7, Title: title, URL: "https://corp.com/\x1b[A"}})

	var out strings.Builder
	if err := run([]string{"tabs"}, &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "evil]0;pwned[2J ti31mtle") || !strings.Contains(out.String(), "https://corp.com/[A") {
		t.Errorf("tabs printed %q, want the title and address as plain text", out.String())
	}
	out.Reset()
	if err := run([]string{"tabs", "--json"}, &out); err != nil {
		t.Fatal(err)
	}
	var got tab
	if err := json.Unmarshal([]byte(out.String()), &got); err != nil || got.Title != title {
		t.Errorf("tabs --json printed %q, which reads back as %q, %v", out.String(), got.Title, err)
	}
	for _, s := range []string{"\x1b", "\x07", "\x7f", "\u009b"} {
		if strings.Contains(out.String(), s) {
			t.Errorf("tabs --json printed %q, with %q in it", out.String(), s)
		}
	}
}
