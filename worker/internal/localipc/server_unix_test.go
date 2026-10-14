//go:build !windows

package localipc

import (
	"context"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// sockPath trả đường dẫn socket ngắn: t.TempDir() trên macOS dài quá giới hạn 104 byte của sun_path.
func sockPath(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "hs")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return filepath.Join(dir, "run", "hive.sock")
}

type denyPeer struct{}

func (denyPeer) CheckPeer(net.Conn) error { return errors.New("uid 501 khác 502") }

// start chạy server; handler mặc định trả lời ping và vào chế độ khung khi op là "echo".
func start(t *testing.T, s *Server) string {
	t.Helper()
	path := sockPath(t)
	ln, err := Listen(path)
	if err != nil {
		t.Fatal(err)
	}
	if s.Worker == "" {
		s.Worker = "1.2.3"
	}
	if s.Handler == nil {
		s.Handler = echoHandler
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- s.Serve(ctx, ln) }()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(15 * time.Second):
			t.Error("server không dừng")
		}
	})
	return path
}

func echoHandler(_ context.Context, c *Conn, req Request) error {
	switch req.Op {
	case "ping":
		return c.OK(map[string]any{"pong": true})
	case "echo":
		if err := c.OK(nil); err != nil {
			return err
		}
		for {
			typ, data, err := c.ReadFrame()
			if err != nil {
				return err
			}
			if err := c.WriteFrame(typ, data); err != nil {
				return err
			}
		}
	}
	return c.Fail(CodeUnsupported, "không biết "+req.Op)
}

func TestHandshake(t *testing.T) {
	path := start(t, &Server{})
	c, h, err := Dial(path, "hive/test")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if h.V != Version || h.Worker != "1.2.3" {
		t.Fatalf("hello = %+v", h)
	}
	var resp struct {
		Pong bool `json:"pong"`
	}
	if err := c.Call(map[string]string{"op": "ping"}, &resp); err != nil || !resp.Pong {
		t.Fatalf("ping: %+v %v", resp, err)
	}
	var re *RemoteError
	if err := c.Call(map[string]string{"op": "lạ"}, nil); !errors.As(err, &re) || re.Code != CodeUnsupported {
		t.Fatalf("op lạ: %v", err)
	}
}

func TestVersionMismatch(t *testing.T) {
	path := start(t, &Server{})
	_, _, err := dial(path, "hive/test", Version+1)
	var ve *VersionError
	if !errors.As(err, &ve) || ve.Got != Version || ve.Worker != "1.2.3" {
		t.Fatalf("lệch phiên bản: %#v", err)
	}
	if ve.Error() != "Phiên bản hive và hive-worker khác nhau. Chạy `hive-worker update`." {
		t.Fatalf("thông báo: %q", ve.Error())
	}
}

func TestPermissions(t *testing.T) {
	path := start(t, &Server{})
	for p, want := range map[string]os.FileMode{filepath.Dir(path): 0o700, path: 0o600} {
		fi, err := os.Stat(p)
		if err != nil {
			t.Fatal(err)
		}
		if fi.Mode().Perm() != want {
			t.Fatalf("%s: quyền %o, muốn %o", p, fi.Mode().Perm(), want)
		}
	}
}

func TestDirTightened(t *testing.T) {
	path := sockPath(t)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	ln, err := Listen(path)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if fi, _ := os.Stat(filepath.Dir(path)); fi.Mode().Perm() != 0o700 {
		t.Fatalf("thư mục còn quyền %o", fi.Mode().Perm())
	}
}

func TestSameUserAccepted(t *testing.T) {
	// SameUser thật: tiến trình test nối chính nó nên phải được nhận.
	path := start(t, &Server{Peer: SameUser{}})
	c, _, err := Dial(path, "hive/test")
	if err != nil {
		t.Fatal(err)
	}
	_ = c.Close()
}

func TestOtherUserDenied(t *testing.T) {
	path := start(t, &Server{Peer: denyPeer{}})
	if _, _, err := Dial(path, "hive/test"); !errors.Is(err, ErrDenied) {
		t.Fatalf("uid khác: %v", err)
	}
}

func TestNotRunning(t *testing.T) {
	if _, _, err := Dial(sockPath(t), "hive/test"); !errors.Is(err, ErrNotRunning) {
		t.Fatalf("không có worker: %v", err)
	}
}

func TestStaleSocketRemoved(t *testing.T) {
	path := sockPath(t)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	old, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	// Như worker chết: file socket còn, không ai nghe.
	old.(*net.UnixListener).SetUnlinkOnClose(false)
	_ = old.Close()
	if _, _, err := Dial(path, "hive/test"); !errors.Is(err, ErrNotRunning) {
		t.Fatalf("socket cũ: %v", err)
	}
	ln, err := Listen(path)
	if err != nil {
		t.Fatalf("phải dọn socket cũ: %v", err)
	}
	defer ln.Close()
	// Còn worker đang nghe: không cướp socket.
	if _, err := Listen(path); !errors.Is(err, ErrInUse) {
		t.Fatalf("socket đang dùng: %v", err)
	}
	// File thường ở chỗ socket: không xoá.
	plain := filepath.Join(filepath.Dir(path), "plain")
	if err := os.WriteFile(plain, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Listen(plain); err == nil {
		t.Fatal("không được xoá file không phải socket")
	}
	if _, err := os.Stat(plain); err != nil {
		t.Fatalf("file thường bị xoá: %v", err)
	}
}

func TestLargeFramesOverSocket(t *testing.T) {
	path := start(t, &Server{})
	c, _, err := Dial(path, "hive/test")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if err := c.Call(map[string]string{"op": "echo"}, nil); err != nil {
		t.Fatal(err)
	}
	big := make([]byte, MaxFrame)
	for i := range big {
		big[i] = byte(i)
	}
	go func() { _ = c.WriteFrame(FrameIn, big) }()
	typ, data, err := c.ReadFrame()
	if err != nil || typ != FrameIn || len(data) != MaxFrame || data[MaxFrame-1] != big[MaxFrame-1] {
		t.Fatalf("khung lớn: %d %d %v", typ, len(data), err)
	}
}

func TestAbruptClose(t *testing.T) {
	ended := make(chan error, 1)
	path := start(t, &Server{Handler: func(ctx context.Context, c *Conn, req Request) error {
		err := echoHandler(ctx, c, req)
		ended <- err
		return err
	}})
	c, _, err := Dial(path, "hive/test")
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Call(map[string]string{"op": "echo"}, nil); err != nil {
		t.Fatal(err)
	}
	// Đầu khung hứa 1000 byte rồi đóng: server phải thoát vòng khung, không treo.
	_, _ = c.nc.Write([]byte{FrameIn, 0, 0, 3, 232, 'a'})
	_ = c.Close()
	select {
	case err := <-ended:
		if !errors.Is(err, io.ErrUnexpectedEOF) {
			t.Fatalf("lỗi = %v", err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("server treo sau khi client đóng giữa khung")
	}
	// Server vẫn nhận kết nối mới.
	c2, _, err := Dial(path, "hive/test")
	if err != nil {
		t.Fatal(err)
	}
	_ = c2.Close()
}

func TestMissingHello(t *testing.T) {
	path := start(t, &Server{})
	nc, err := net.Dial("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	c := newConn(nc)
	defer c.Close()
	err = c.Call(map[string]string{"op": "ping"}, nil)
	var re *RemoteError
	if !errors.As(err, &re) || re.Code != CodeBadRequest {
		t.Fatalf("thiếu hello: %v", err)
	}
}

func TestServeStopsWithContext(t *testing.T) {
	path := sockPath(t)
	ln, err := Listen(path)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- (&Server{Handler: echoHandler}).Serve(ctx, ln) }()
	c, _, err := Dial(path, "hive/test")
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Call(map[string]string{"op": "echo"}, nil); err != nil {
		t.Fatal(err)
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("Serve không dừng khi còn client gắn")
	}
	if _, _, err := c.ReadFrame(); err == nil {
		t.Fatal("kết nối phải bị đóng")
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("socket phải bị xoá khi dừng: %v", err)
	}
}
