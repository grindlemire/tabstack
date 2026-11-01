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

// maxLog caps host.log; a bigger log is cleared before the next line.
const maxLog = 1 << 20

// maxWrite is Chrome's limit on a message from the host to the extension. A
// bigger one would make Chrome drop the connection, so it's dropped instead.
const maxWrite = 1 << 20

// joinTimeout bounds how long a helper waits for another to finish becoming
// the hub.
const joinTimeout = 5 * time.Second

// A helper the hub keeps dropping waits before each rejoin, from
// minRejoinDelay doubling to maxRejoinDelay, so it doesn't spin; one that
// stayed joined longer than that rejoins at once, as when the hub moves.
const (
	minRejoinDelay = 100 * time.Millisecond
	maxRejoinDelay = 5 * time.Second
)

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
	logf, err := os.OpenFile(filepath.Join(dir, "host.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	defer logf.Close()
	log.SetOutput(cappedLog{logf})
	log.SetPrefix(fmt.Sprintf("[%d] ", os.Getpid()))

	// The browser starts every profile's helper itself, so its process ID
	// names the hub they share. Two browsers (Chrome and Brave, say) get one
	// each, since neither can bring the other's windows forward.
	base := filepath.Join(dir, fmt.Sprintf("hub-%d", os.Getppid()))
	log.Printf("started by %d (version %s)", os.Getppid(), version)
	if home, err := os.UserHomeDir(); err == nil {
		fixed, err := repair(home)
		for _, r := range fixed {
			log.Printf("repaired the registration with %s: pointed at %s, now %s", r.browser, r.was, r.now)
		}
		if err != nil {
			log.Printf("repairing registrations: %v", err)
		}
	}
	err = relay(base, os.Stdin, os.Stdout)
	log.Printf("done: %v", err)
	return err
}

// cappedLog is host.log, cleared once it's grown past maxLog. A helper runs
// as long as its browser, for weeks, and every helper of every browser
// writes to it.
type cappedLog struct{ f *os.File }

func (l cappedLog) Write(b []byte) (int, error) {
	if info, err := l.f.Stat(); err == nil && info.Size() > maxLog {
		l.f.Truncate(0) // opened to append, so the next line goes at the start
	}
	return l.f.Write(b)
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

	self, _ := selfPath()
	hello, _ := json.Marshal(message{Type: "hello", Version: version, Binary: fileID(self)})
	var state []byte // the profile's last state message
	var delay time.Duration
	for {
		conn, err := joinHub(base)
		if err != nil {
			return err
		}
		joined := time.Now()
		// The hub's messages go to the browser from their own goroutine, so
		// this one blocking on a write to the hub never stops them being read:
		// the hub, writing to us at the same time, would give up on us.
		lost := make(chan error, 1)
		go func() { lost <- toBrowser(conn, out) }()

		err = send(conn, hello)
		if err == nil && state != nil {
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
			case werr := <-lost:
				lost <- werr // for after the loop
				err = io.EOF
			}
		}
		conn.Close()
		// toBrowser is all that writes to out; the next hub's waits for this
		// one to stop, so frames never interleave
		if werr := <-lost; werr != nil {
			return werr
		}
		if time.Since(joined) > maxRejoinDelay {
			delay = 0
		}
		log.Printf("lost the hub (%v); rejoining in %v", err, delay)
		time.Sleep(delay)
		delay = min(max(2*delay, minRejoinDelay), maxRejoinDelay)
	}
}

// toBrowser passes the hub's messages on to the browser until the hub's
// connection closes, when it returns nil, or writing to the browser fails.
func toBrowser(conn net.Conn, out io.Writer) error {
	dec := json.NewDecoder(conn)
	for {
		var msg json.RawMessage
		if err := dec.Decode(&msg); err != nil {
			return nil
		}
		if len(msg) > maxWrite {
			log.Printf("dropped a %d-byte message, over the browser's limit", len(msg))
			continue
		}
		if err := writeFrame(out, msg); err != nil {
			conn.Close()
			return err
		}
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
	f, err := tryLock(base+".lock", os.O_CREATE)
	if err != nil || f == nil {
		return nil, err
	}
	sock := base + ".sock"
	os.Remove(sock) // left by a hub that exited
	ln, err := net.Listen("unix", sock)
	if err != nil {
		f.Close()
		return nil, err
	}
	exe, _ := helperPath()
	h := &hub{lock: f, exe: exe, peers: map[*peer]bool{}}
	log.Printf("hub: listening on %s", sock)
	go h.serve(ln)
	go h.watchExe()
	return h, nil
}

// tryLock takes an exclusive lock on the file at path without waiting. It
// returns nil when another process holds it, or when the file was removed or
// replaced between opening and locking it (by removeStale, say), since a lock
// on a file that's no longer at path keeps no one else out.
func tryLock(path string, flag int) (*os.File, error) {
	f, err := os.OpenFile(path, flag|os.O_RDWR, 0o600)
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
	locked, err := f.Stat()
	there, err2 := os.Stat(path)
	if err != nil || err2 != nil || !os.SameFile(locked, there) {
		f.Close()
		return nil, nil
	}
	return f, nil
}
