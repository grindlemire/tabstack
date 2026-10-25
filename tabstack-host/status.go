package main

import (
	"encoding/json"
	"net"
	"path/filepath"
	"time"
)

// hubPeer is a connected profile, as a hub lists it.
type hubPeer struct {
	Profile string `json:"profile"`
	Windows int    `json:"windows"`
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
	conn  net.Conn
	enc   *json.Encoder
	dec   *json.Decoder
	peers []hubPeer
}

func dialHub(sock string) (*hubClient, error) {
	conn, err := net.DialTimeout("unix", sock, time.Second)
	if err != nil {
		return nil, err
	}
	c := &hubClient{conn: conn, enc: json.NewEncoder(conn), dec: json.NewDecoder(conn)}
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

// next reads the hub's next list of who's connected.
func (c *hubClient) next() error {
	var m struct {
		Type  string    `json:"type"`
		Peers []hubPeer `json:"peers"`
	}
	for m.Type != "peers" {
		if err := c.dec.Decode(&m); err != nil {
			return err
		}
	}
	c.peers = m.Peers
	return nil
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
