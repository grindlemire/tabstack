package main

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// hubClient watches a hub, one per running browser, and sends its profiles
// commands.
type hubClient struct {
	conn    net.Conn
	enc     *json.Encoder
	dec     *json.Decoder
	peers   []peerInfo
	version string // the hub's
	path    string // the hub's helper, where it watches for a new build
}

func dialHub(sock string) (*hubClient, error) {
	conn, err := net.DialTimeout("unix", sock, time.Second)
	if err != nil {
		return nil, err
	}
	return watchHub(conn)
}

// watchHub starts watching the hub on conn, and returns once it's said
// who's connected.
func watchHub(conn net.Conn) (*hubClient, error) {
	c := &hubClient{conn: conn, enc: newEncoder(conn), dec: json.NewDecoder(conn)}
	conn.SetDeadline(time.Now().Add(time.Second))
	if err := c.enc.Encode(message{Type: "watch"}); err != nil {
		conn.Close()
		return nil, err
	}
	if err := c.next(); err != nil {
		conn.Close()
		return nil, err
	}
	conn.SetDeadline(time.Time{})
	return c, nil
}

// read takes the hub's next message, keeping up with who's connected.
func (c *hubClient) read() (message, error) {
	var m message
	if err := c.dec.Decode(&m); err != nil {
		return m, err
	}
	if m.Type == "peers" {
		c.peers, c.version, c.path = m.Peers, m.Version, m.Path
	}
	return m, nil
}

// next reads the hub's next list of who's connected.
func (c *hubClient) next() error {
	for {
		m, err := c.read()
		if err != nil || m.Type == "peers" {
			return err
		}
	}
}

// answer is one profile's answer to ask.
type answer struct {
	From string
	Body json.RawMessage
}

// ask sends a profile a request, or every profile when to is "*", and
// gathers the answers until each has answered or the time's up. Profiles
// match an answer to its request by rid. Once the time's up, c reads no
// more (the decoder keeps the error, and may have stopped part way through
// a message), so it's the last thing a command asks of a hub.
func (c *hubClient) ask(to string, body map[string]any, timeout time.Duration) ([]answer, error) {
	want := 1
	if to == "*" {
		want = len(c.peers)
	}
	rid := rand.Text()
	req := map[string]any{"rid": rid}
	for k, v := range body {
		req[k] = v
	}
	if err := c.send(to, req); err != nil {
		return nil, err
	}
	c.conn.SetReadDeadline(time.Now().Add(timeout))
	defer c.conn.SetReadDeadline(time.Time{})
	var got []answer
	for len(got) < want {
		m, err := c.read()
		if errors.Is(err, os.ErrDeadlineExceeded) {
			break
		}
		if err != nil {
			return got, err
		}
		var r struct {
			Kind string `json:"kind"`
			Rid  string `json:"rid"`
		}
		if m.Type == "msg" && json.Unmarshal(m.Body, &r) == nil && r.Kind == "reply" && r.Rid == rid {
			got = append(got, answer{m.From, m.Body})
		}
	}
	return got, nil
}

func (c *hubClient) send(to string, body any) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	return c.enc.Encode(message{Type: "send", To: to, Body: raw})
}

func (c *hubClient) Close() error {
	return c.conn.Close()
}

// liveHubs connects to each running hub, and clears away what hubs that
// are gone left behind.
func liveHubs(dir string) []*hubClient {
	socks, _ := filepath.Glob(filepath.Join(dir, "hub-*.sock"))
	var live []*hubClient
	for _, sock := range socks {
		c, err := dialHub(sock)
		switch {
		case err == nil:
			live = append(live, c)
		case errors.Is(err, syscall.ECONNREFUSED):
			removeStale(strings.TrimSuffix(sock, ".sock"))
		}
	}
	return live
}

// removeStale removes the socket and lock of the hub at base, when no
// helper holds the lock: nothing's listening, and none is about to.
func removeStale(base string) {
	f, err := tryLock(base+".lock", 0)
	if err != nil || f == nil {
		return
	}
	defer f.Close()
	os.Remove(base + ".sock")
	os.Remove(base + ".lock")
}

// connectedProfiles maps each connected profile that install set up, by
// where it is, to what it says about itself.
func connectedProfiles(dir string) map[string]peerInfo {
	out := map[string]peerInfo{}
	for _, c := range liveHubs(dir) {
		for _, p := range c.peers {
			if p.Info.Where != "" {
				out[p.Info.Where] = p
			}
		}
		c.Close()
	}
	return out
}
