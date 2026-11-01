package main

// Fuzz targets for what the helper reads from others: the browser's frames,
// claims and messages from anything that joins the hub, and the browsers'
// preference files. go test runs each on its seeds; go test -fuzz=FuzzX
// looks for more.

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// readFrame reads frames until it can't, never more than the limit, and
// always gets further along.
func FuzzReadFrame(f *testing.F) {
	f.Add(frame(7, `{"a":1}`))
	f.Add(append(frame(0, ""), frame(2, "{}")...))
	f.Add([]byte{1, 0})
	f.Add(frame(10, `{"a":1}`))
	f.Add(frame(maxRead+1, ""))
	f.Add(frame(0xffffffff, "x"))
	f.Fuzz(func(t *testing.T, data []byte) {
		r := bytes.NewReader(data)
		for {
			left := r.Len()
			msg, err := readFrame(r)
			if err != nil {
				return
			}
			if len(msg) > maxRead || left-r.Len() != 4+len(msg) {
				t.Fatalf("read a %d-byte message from %d bytes", len(msg), left-r.Len())
			}
		}
	})
}

// covers never panics or stalls on a claim, whatever it is.
func FuzzCovers(f *testing.F) {
	data, err := os.ReadFile("../../testdata/covers.json")
	if err != nil {
		f.Fatal(err)
	}
	var cases []struct{ Pattern, URL string }
	if err := json.Unmarshal(data, &cases); err != nil {
		f.Fatal(err)
	}
	for _, c := range cases {
		f.Add(c.Pattern, c.URL)
	}
	f.Add(strings.Repeat("*", 100_000), "https://corp.com/")
	f.Add("corp.com/"+strings.Repeat("*", maxPattern), "https://corp.com/"+strings.Repeat("a/", 1000))
	f.Add("[", "http://[::1]/")
	f.Fuzz(func(t *testing.T, pattern, link string) {
		u, err := url.Parse(link)
		if err != nil {
			return
		}
		start := time.Now()
		got := covers(pattern, u)
		if took := time.Since(start); took > time.Second {
			t.Fatalf("covers(%q, %q) took %v", pattern, link, took)
		}
		// spaces around a claim don't matter
		if again := covers(" "+pattern+"\t", u); again != got && len(pattern)+2 <= maxPattern {
			t.Fatalf("covers(%q) = %v, but with spaces around it %v", pattern, got, again)
		}
	})
}

// The hub reads whatever a connection sends without panicking, and closes
// it once the bytes stop making sense. JSON values it can't use are
// skipped, and the connection kept.
func FuzzHubHandle(f *testing.F) {
	f.Add([]byte(`{"type":"hello","version":"1.2.0","binary":"1:2"}`))
	f.Add([]byte(`{"type":"state","profile":"1","windows":2,"info":{"name":"Work"}}`))
	f.Add([]byte(`{"type":"state","profile":"1","windows":"2"}`))
	f.Add([]byte(`{"type":"watch"}{"type":"send","to":"*","body":{"kind":"x"}}`))
	f.Add([]byte(`{"type":"send","to":"cli-1","body":null}`))
	f.Add([]byte(`{"type":"peers","peers":[{"profile":"1","info":{"name":5}}]}`))
	f.Add([]byte(`[1,"a",{}] "x" 5 null`))
	f.Add([]byte(`{"type":"state"`))
	f.Add([]byte("\xff\x00{"))
	log.SetOutput(io.Discard) // a line for each message it skips
	f.Cleanup(func() { log.SetOutput(os.Stderr) })
	f.Fuzz(func(t *testing.T, data []byte) {
		h := &hub{peers: map[*peer]bool{}}
		conn, theirs := net.Pipe()
		defer conn.Close()
		done := make(chan struct{})
		go func() {
			h.handle(theirs)
			close(done)
		}()
		marked, gone := make(chan struct{}), make(chan struct{})
		go func() {
			defer close(gone)
			r := bufio.NewReader(conn)
			seen := false
			for {
				line, err := r.ReadBytes('\n')
				if err != nil {
					return
				}
				if !seen && bytes.Contains(line, []byte(`"fuzz-marker"`)) {
					seen = true
					close(marked)
				}
			}
		}()
		conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
		conn.Write(data)
		if json.Valid(data) {
			// still connected: a state after it is announced
			conn.Write([]byte("\n" + `{"type":"state","profile":"fuzz-marker"}` + "\n"))
			select {
			case <-marked:
			case <-gone:
				t.Fatalf("the hub dropped the connection after %q", data)
			case <-time.After(3 * time.Second):
				t.Fatalf("the hub stopped answering after %q", data)
			}
		}
		conn.Close()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			t.Fatalf("the hub kept reading a closed connection after %q", data)
		}
	})
}

// Whatever the browser's files hold, reading them doesn't panic, and finds
// only tabstack.
func FuzzProfiles(f *testing.F) {
	override := `{"settings_override":{"homepage":"https://example.com"}}`
	store := `{"path":"` + storeID + `/1.0.0_0","location":1,"active_permissions":{"api":[` + override + `,"nativeMessaging"]}}`
	f.Add([]byte(`{"extensions":{"settings":{"`+storeID+`":`+store+`}}}`), []byte(``), []byte(`{"profile":{"info_cache":{"Default":{"name":"Me"}}}}`))
	f.Add([]byte(``), []byte(`{"extensions":{"settings":{"`+lookalikeID+`":{"active_permissions":{"api":[`+override+`]}},"`+storeID+`":`+store+`}}}`), []byte(``))
	f.Add([]byte(`{"extensions":{"settings":5}}`), []byte(`{"extensions":[]}`), []byte(`{"profile":{"info_cache":{"Default":{"name":5}}}}`))
	f.Add([]byte(`{"extensions":{"settings":{"`+unpackedID+`":{"path":"/","location":4,"disable_reasons":[],"state":1}}}}`), []byte(`null`), []byte(`[`))
	f.Add([]byte(``), []byte(``), []byte(`{"profile":{"info_cache":{"Default":{"name":5},"Profile 1":"x","Profile 2":{"name":"Work"}}}}`))
	f.Fuzz(func(t *testing.T, prefs, secure, localState []byte) {
		data := t.TempDir()
		for path, b := range map[string][]byte{
			filepath.Join(data, "Default", "Preferences"):        prefs,
			filepath.Join(data, "Default", "Secure Preferences"): secure,
			filepath.Join(data, "Local State"):                   localState,
		} {
			if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, b, 0o644); err != nil {
				t.Fatal(err)
			}
		}
		list, err := profiles(browser{name: "Test", dataDir: data})
		// only a Local State that isn't JSON hides the browser
		if err != nil && json.Valid(localState) {
			t.Fatalf("profiles: %v", err)
		}
		for _, p := range list {
			if p.id != "" && p.id != storeID && !extensionID.MatchString(p.id) {
				t.Fatalf("found tabstack as %q", p.id)
			}
		}
	})
}

// A message reads back as it was sent: what a profile says about itself
// goes on as it came (but compacted), and peers stays a list once it's one.
func FuzzMessageRoundTrip(f *testing.F) {
	f.Add([]byte(`{"type":"peers","version":"1.2.0","path":"/x","peers":[{"profile":"1","windows":2,"version":"1.2.0","info":{"name":"Work","mark":"🦊 & <b>","claims":["corp.com"],"done":"x1"}}]}`))
	f.Add([]byte(`{"type":"peers","peers":[]}`))
	f.Add([]byte(`{"type":"peers","peers":null}`))
	f.Add([]byte(`{"type":"peers","peers":[{"profile":"1","info":null},{"profile":"2","info":{ "name" : 5 }},{"info":"x"}]}`))
	f.Add([]byte(`{"type":"msg","from":"1","body":{"kind":"reply","rid":"r"},"info":null}`))
	f.Add([]byte(`{"type":"state","profile":"1","windows":0,"info":[1, 2]}`))
	f.Fuzz(func(t *testing.T, data []byte) {
		var m message
		if json.Unmarshal(data, &m) != nil {
			return
		}
		out := encode(t, m)
		var again message
		if err := json.Unmarshal(out, &again); err != nil {
			t.Fatalf("%s doesn't read back: %v", out, err)
		}
		if out2 := encode(t, again); !bytes.Equal(out, out2) {
			t.Fatalf("%s reads back as %s", out, out2)
		}
		if (m.Peers == nil) != (again.Peers == nil) || len(m.Peers) != len(again.Peers) {
			t.Fatalf("peers %v came back as %v", m.Peers, again.Peers)
		}
		for i, p := range m.Peers {
			var want bytes.Buffer
			if !p.Info.IsZero() {
				json.Compact(&want, p.Info.raw)
			}
			if got := again.Peers[i].Info.raw; !bytes.Equal(got, want.Bytes()) {
				t.Fatalf("info %s came back as %s", p.Info.raw, got)
			}
		}
	})
}

// encode writes m as the hub sends it.
func encode(t *testing.T, m message) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := newEncoder(&b).Encode(m); err != nil {
		t.Fatalf("encoding %+v: %v", m, err)
	}
	return bytes.TrimSuffix(b.Bytes(), []byte("\n"))
}
