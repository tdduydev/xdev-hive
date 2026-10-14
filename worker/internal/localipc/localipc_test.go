package localipc

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"strings"
	"testing"
)

func pipe(t *testing.T) (*Conn, *Conn) {
	t.Helper()
	a, b := net.Pipe()
	t.Cleanup(func() { _ = a.Close(); _ = b.Close() })
	return newConn(a), newConn(b)
}

func TestFrameRoundTrip(t *testing.T) {
	a, b := pipe(t)
	big := bytes.Repeat([]byte("x"), MaxFrame)
	go func() {
		_ = a.WriteFrame(FrameOut, []byte("xin chào"))
		_ = a.WriteFrame(FrameIn, nil)
		_ = a.WriteFrame(FrameOut, big)
		_ = a.WriteCtl(Ctl{Type: CtlDetach})
	}()
	for i, want := range []struct {
		typ  byte
		data []byte
	}{{FrameOut, []byte("xin chào")}, {FrameIn, []byte{}}, {FrameOut, big}, {FrameCtl, []byte(`{"type":"detach"}`)}} {
		typ, data, err := b.ReadFrame()
		if err != nil || typ != want.typ || !bytes.Equal(data, want.data) {
			t.Fatalf("khung %d: %d %d byte %v", i, typ, len(data), err)
		}
	}
}

func TestFrameTooLarge(t *testing.T) {
	a, b := pipe(t)
	if err := a.WriteFrame(FrameOut, make([]byte, MaxFrame+1)); !errors.Is(err, ErrFrameTooLarge) {
		t.Fatalf("ghi khung quá cỡ: %v", err)
	}
	// Đầu kia khai độ dài quá cỡ: đọc phải dừng ngay, không cấp phát theo độ dài khai.
	go func() {
		var hdr [5]byte
		hdr[0] = FrameIn
		binary.BigEndian.PutUint32(hdr[1:], 1<<31)
		_, _ = a.nc.Write(hdr[:])
	}()
	if _, _, err := b.ReadFrame(); !errors.Is(err, ErrFrameTooLarge) {
		t.Fatalf("đọc khung quá cỡ: %v", err)
	}
}

func TestFrameTruncated(t *testing.T) {
	a, b := pipe(t)
	go func() {
		var hdr [5]byte
		hdr[0] = FrameOut
		binary.BigEndian.PutUint32(hdr[1:], 100)
		_, _ = a.nc.Write(hdr[:])
		_, _ = a.nc.Write([]byte("dở"))
		_ = a.Close()
	}()
	if _, _, err := b.ReadFrame(); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("đóng giữa khung: %v", err)
	}
}

func TestLineLimits(t *testing.T) {
	a, b := pipe(t)
	go func() {
		_, _ = a.nc.Write([]byte(`{"op":"session.list"}` + "\n"))
		_, _ = a.nc.Write([]byte(strings.Repeat("a", MaxLine+10) + "\n"))
	}()
	req, err := b.ReadRequest()
	if err != nil || req.Op != "session.list" {
		t.Fatalf("yêu cầu: %+v %v", req, err)
	}
	if _, err := b.ReadRequest(); !errors.Is(err, ErrLineTooLong) {
		t.Fatalf("dòng quá dài: %v", err)
	}
}

func TestCallRemoteError(t *testing.T) {
	a, b := pipe(t)
	go func() {
		req, _ := b.ReadRequest()
		var p struct {
			ID string `json:"id"`
		}
		_ = req.Decode(&p)
		_ = b.Fail(CodeNotFound, "Không có phiên "+p.ID+".")
	}()
	err := a.Call(map[string]any{"op": "session.kill", "id": "abc"}, nil)
	var re *RemoteError
	if !errors.As(err, &re) || re.Code != CodeNotFound || re.Message != "Không có phiên abc." {
		t.Fatalf("lỗi = %#v", err)
	}
}
