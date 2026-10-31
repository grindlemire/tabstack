package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"testing"
)

func frame(n uint32, body string) []byte {
	b := binary.NativeEndian.AppendUint32(nil, n)
	return append(b, body...)
}

func TestReadFrame(t *testing.T) {
	for _, c := range []struct {
		name  string
		in    []byte
		want  string
		fails bool
		is    error // what it fails with, if that matters
	}{
		{name: "a message", in: frame(7, `{"a":1}`), want: `{"a":1}`},
		{name: "an empty one", in: frame(0, "")},
		{name: "the browser closed", fails: true, is: io.EOF},
		{name: "a short header", in: []byte{1, 0}, fails: true, is: io.ErrUnexpectedEOF},
		{name: "a short body", in: frame(10, `{"a":1}`), fails: true, is: io.ErrUnexpectedEOF},
		// refused from the header alone, before it's read or allocated
		{name: "over the limit", in: frame(maxRead+1, ""), fails: true},
	} {
		t.Run(c.name, func(t *testing.T) {
			got, err := readFrame(bytes.NewReader(c.in))
			switch {
			case c.fails && (err == nil || c.is != nil && !errors.Is(err, c.is)):
				t.Errorf("readFrame = %q, %v; want it to fail with %v", got, err, c.is)
			case !c.fails && (err != nil || string(got) != c.want):
				t.Errorf("readFrame = %q, %v; want %q", got, err, c.want)
			}
		})
	}
}

func TestWriteFrameReadsBack(t *testing.T) {
	var buf bytes.Buffer
	if err := writeFrame(&buf, []byte(`{"type":"peers"}`)); err != nil {
		t.Fatal(err)
	}
	if got, err := readFrame(&buf); err != nil || string(got) != `{"type":"peers"}` {
		t.Errorf("readFrame = %q, %v", got, err)
	}
}
