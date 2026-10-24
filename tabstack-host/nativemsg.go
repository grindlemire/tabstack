package main

import (
	"encoding/binary"
	"fmt"
	"io"
)

// Native messaging frames are a 4-byte length in native byte order followed by
// that many bytes of JSON.

// maxRead is Chrome's limit on a message sent from the extension to the host.
const maxRead = 64 << 20

// readFrame reads one message. It returns io.EOF when the browser closes the
// connection.
func readFrame(r io.Reader) ([]byte, error) {
	var n uint32
	if err := binary.Read(r, binary.NativeEndian, &n); err != nil {
		return nil, err
	}
	if n > maxRead {
		return nil, fmt.Errorf("message of %d bytes exceeds limit", n)
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return nil, err
	}
	return buf, nil
}

// writeFrame writes msg, which is already JSON, as one message.
func writeFrame(w io.Writer, msg []byte) error {
	frame := make([]byte, 4+len(msg))
	binary.NativeEndian.PutUint32(frame, uint32(len(msg)))
	copy(frame[4:], msg)
	_, err := w.Write(frame)
	return err
}
