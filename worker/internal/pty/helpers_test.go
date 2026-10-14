package pty

import (
	"bytes"
	"io"
	"strings"
	"testing"
	"time"
)

// reader gom output của PTY trong nền để test chờ một chuỗi xuất hiện.
type reader struct {
	ch  chan []byte
	buf bytes.Buffer
}

func readAll(f io.Reader) *reader {
	r := &reader{ch: make(chan []byte, 64)}
	go func() {
		defer close(r.ch)
		b := make([]byte, 4096)
		for {
			n, err := f.Read(b)
			if n > 0 {
				r.ch <- append([]byte(nil), b[:n]...)
			}
			if err != nil {
				return
			}
		}
	}()
	return r
}

func (r *reader) waitFor(t *testing.T, want string) {
	t.Helper()
	r.waitUntil(t, want, func(s string) bool { return strings.Contains(s, want) })
}

func (r *reader) waitUntil(t *testing.T, want string, done func(string) bool) {
	t.Helper()
	deadline := time.After(10 * time.Second)
	for !done(r.buf.String()) {
		select {
		case b, ok := <-r.ch:
			if !ok {
				t.Fatalf("PTY đóng trước khi thấy %q; output: %q", want, r.buf.String())
			}
			r.buf.Write(b)
		case <-deadline:
			t.Fatalf("không thấy %q; output: %q", want, r.buf.String())
		}
	}
}
