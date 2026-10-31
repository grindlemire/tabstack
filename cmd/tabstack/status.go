package main

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"time"
)

// hubPeer is a connected profile, as a hub lists it.
type hubPeer struct {
	Profile string `json:"profile"`
	Windows int    `json:"windows"`
	Version string `json:"version"` // of the helper passing its messages on
	Info    struct {
		Name   string   `json:"name"`
		Where  string   `json:"where"` // browser/profile folder, once set up by install
		Claims []string `json:"claims"`
		// the install run whose setup page was last finished with Done; missing
		// altogether from a tabstack too old to say
		Done *string `json:"done"`
	} `json:"info"`
}

// hubClient watches a hub, one per running browser, and sends its profiles
// commands.
type hubClient struct {
	conn    net.Conn
	enc     *json.Encoder
	dec     *json.Decoder
	peers   []hubPeer
	version string // the hub's
}

func dialHub(sock string) (*hubClient, error) {
	conn, err := net.DialTimeout("unix", sock, time.Second)
	if err != nil {
		return nil, err
	}
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

// fromHub is anything the hub sends a watcher.
type fromHub struct {
	Type    string          `json:"type"`
	Peers   []hubPeer       `json:"peers"`
	Version string          `json:"version"`
	From    string          `json:"from"`
	Body    json.RawMessage `json:"body"`
}

// read takes the hub's next message, keeping up with who's connected.
func (c *hubClient) read() (fromHub, error) {
	var m fromHub
	if err := c.dec.Decode(&m); err != nil {
		return m, err
	}
	if m.Type == "peers" {
		c.peers, c.version = m.Peers, m.Version
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
// match an answer to its request by rid.
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

// liveHubs connects to each running hub. A socket left by a hub that's gone
// just doesn't answer.
func liveHubs(dir string) []*hubClient {
	socks, _ := filepath.Glob(filepath.Join(dir, "hub-*.sock"))
	var live []*hubClient
	for _, sock := range socks {
		if c, err := dialHub(sock); err == nil {
			live = append(live, c)
		}
	}
	return live
}

// connectedProfiles maps each connected profile that install set up, by
// where it is, to what it says about itself.
func connectedProfiles(dir string) map[string]hubPeer {
	out := map[string]hubPeer{}
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
