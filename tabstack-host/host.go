package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

// maxLog caps host.log; a bigger log is cleared when the helper starts.
const maxLog = 1 << 20

// maxWrite is Chrome's limit on a message from the host to the extension. A
// bigger one would make Chrome drop the connection, so it's dropped instead.
const maxWrite = 1 << 20

// joinTimeout bounds how long a helper waits for another to finish becoming
// the hub.
const joinTimeout = 5 * time.Second

// runHost is the entry point when a browser starts the helper. It returns when
// the browser closes the connection.
func runHost() error {
	dir, err := hubDir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	// stdout belongs to the browser, so logs go to a file.
	logPath := filepath.Join(dir, "host.log")
	if info, err := os.Stat(logPath); err == nil && info.Size() > maxLog {
		os.Truncate(logPath, 0)
	}
	logf, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	defer logf.Close()
	log.SetOutput(logf)
	log.SetPrefix(fmt.Sprintf("[%d] ", os.Getpid()))

	// The browser starts every profile's helper itself, so its process ID
	// names the hub they share. Two browsers (Chrome and Brave, say) get one
	// each, since neither can bring the other's windows forward.
	base := filepath.Join(dir, fmt.Sprintf("hub-%d", os.Getppid()))
	log.Printf("started by %d", os.Getppid())
	err = relay(base, os.Stdin, os.Stdout)
	log.Printf("done: %v", err)
	return err
}

// hubDir holds the hub's socket and lock, and the log.
func hubDir() (string, error) {
	if dir := os.Getenv("TABSTACK_HOST_DIR"); dir != "" {
		return dir, nil
	}
	cache, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(cache, "tabstack"), nil
}

// relay passes messages between the extension (frames on in and out) and the
// hub at base. When the hub goes away, because the profile whose helper was
// the hub closed, it joins or becomes the next one and tells it this
// profile's state again. It returns nil when in reaches EOF.
func relay(base string, in io.Reader, out io.Writer) error {
	fromExt := make(chan []byte)
	go func() {
		defer close(fromExt)
		for {
			msg, err := readFrame(in)
			if err != nil {
				if !errors.Is(err, io.EOF) {
					log.Printf("reading from browser: %v", err)
				}
				return
			}
			fromExt <- msg
		}
	}()

	var state []byte // the profile's last state message
	for {
		conn, err := joinHub(base)
		if err != nil {
			return err
		}
		fromHub := make(chan []byte)
		go func() {
			defer close(fromHub)
			dec := json.NewDecoder(conn)
			for {
				var msg json.RawMessage
				if err := dec.Decode(&msg); err != nil {
					return
				}
				fromHub <- msg
			}
		}()

		err = nil
		if state != nil {
			err = send(conn, state)
		}
		for err == nil {
			select {
			case msg, ok := <-fromExt:
				if !ok {
					conn.Close()
					return nil
				}
				if kind(msg) == "state" {
					state = msg
				}
				err = send(conn, msg)
			case msg, ok := <-fromHub:
				if !ok {
					err = io.EOF
					break
				}
				if len(msg) > maxWrite {
					log.Printf("dropped a %d-byte message, over the browser's limit", len(msg))
					break
				}
				if err := writeFrame(out, msg); err != nil {
					conn.Close()
					return err
				}
			}
		}
		conn.Close()
		for range fromHub {
		}
		log.Printf("lost the hub (%v); rejoining", err)
	}
}

func send(conn net.Conn, msg []byte) error {
	_, err := conn.Write(append(msg, '\n'))
	return err
}

func kind(msg []byte) string {
	var m struct {
		Type string `json:"type"`
	}
	json.Unmarshal(msg, &m)
	return m.Type
}

// joinHub connects to the hub at base, becoming it first when no helper is.
func joinHub(base string) (net.Conn, error) {
	sock := base + ".sock"
	deadline := time.Now().Add(joinTimeout)
	for {
		if conn, err := net.Dial("unix", sock); err == nil {
			return conn, nil
		}
		h, err := becomeHub(base)
		if err != nil {
			return nil, err
		}
		if h != nil {
			continue // dial ourselves
		}
		// another helper holds the lock and is about to listen
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("no hub listening on %s", sock)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// becomeHub starts serving the hub at base, or returns nil when another
// helper already is. The hub holds an exclusive lock on base.lock for as long
// as it runs, so only one helper can win, and the lock goes when that helper
// exits, however it exits.
func becomeHub(base string) (*hub, error) {
	f, err := os.OpenFile(base+".lock", os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, nil
		}
		return nil, err
	}
	sock := base + ".sock"
	os.Remove(sock) // left by a hub that exited
	ln, err := net.Listen("unix", sock)
	if err != nil {
		f.Close()
		return nil, err
	}
	h := &hub{lock: f, peers: map[*peer]bool{}}
	log.Printf("hub: listening on %s", sock)
	go h.serve(ln)
	return h, nil
}
