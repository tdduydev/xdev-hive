package localipc

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"strings"
	"sync"
	"time"
)

// PeerChecker kiểm người ở đầu kia của kết nối trước khi đọc gì; lỗi là từ chối. Tách thành interface để test giả một
// UID khác mà không cần hai người dùng hệ điều hành.
type PeerChecker interface {
	CheckPeer(net.Conn) error
}

// SameUser chỉ nhận kết nối của cùng người dùng hệ điều hành với worker.
type SameUser struct{}

func (SameUser) CheckPeer(c net.Conn) error { return checkSameUser(c) }

// Handler xử lý một yêu cầu (sau bắt tay). Trả lỗi là đóng kết nối: dùng khi kết nối đã chuyển sang khung nhị phân
// (gắn vào phiên) hoặc client làm hỏng giao thức. Handler tự trả lời bằng c.OK/c.Fail.
type Handler func(ctx context.Context, c *Conn, req Request) error

// ErrDone: Handler đã dùng xong kết nối (sau khung nhị phân), server đóng mà không coi là lỗi.
var ErrDone = errors.New("kết nối đã xong")

// Server nhận kết nối socket nội bộ.
type Server struct {
	// Worker là phiên bản worker trả trong bắt tay.
	Worker  string
	Handler Handler
	// Peer nil là SameUser.
	Peer   PeerChecker
	Logger *slog.Logger

	mu    sync.Mutex
	conns map[net.Conn]struct{}
	wg    sync.WaitGroup
}

type hello struct {
	Op     string `json:"op"`
	V      int    `json:"v"`
	Client string `json:"client"`
}

func (s *Server) log() *slog.Logger {
	if s.Logger == nil {
		return slog.Default()
	}
	return s.Logger
}

// Serve nhận kết nối từ ln tới khi ctx xong; khi đó đóng ln và mọi kết nối đang mở rồi chờ chúng dọn xong.
func (s *Server) Serve(ctx context.Context, ln net.Listener) error {
	stop := context.AfterFunc(ctx, func() {
		_ = ln.Close()
		s.mu.Lock()
		for c := range s.conns {
			_ = c.Close()
		}
		s.mu.Unlock()
	})
	defer stop()
	defer s.wg.Wait()
	for {
		nc, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			var ne net.Error
			if errors.As(err, &ne) && ne.Timeout() {
				continue
			}
			return err
		}
		s.mu.Lock()
		if ctx.Err() != nil {
			s.mu.Unlock()
			_ = nc.Close()
			continue
		}
		if s.conns == nil {
			s.conns = map[net.Conn]struct{}{}
		}
		s.conns[nc] = struct{}{}
		s.wg.Add(1)
		s.mu.Unlock()
		go func() {
			defer s.wg.Done()
			defer func() {
				s.mu.Lock()
				delete(s.conns, nc)
				s.mu.Unlock()
				_ = nc.Close()
			}()
			s.serveConn(ctx, nc)
		}()
	}
}

func (s *Server) serveConn(ctx context.Context, nc net.Conn) {
	peer := s.Peer
	if peer == nil {
		peer = SameUser{}
	}
	c := newConn(nc)
	if err := peer.CheckPeer(nc); err != nil {
		s.log().Warn("Từ chối kết nối socket nội bộ", "error", err)
		_ = c.SetWriteDeadline(time.Now().Add(time.Second))
		_ = c.Fail(CodeDenied, "hive-worker chỉ nhận kết nối của người dùng đang chạy worker.")
		return
	}
	_ = c.SetReadDeadline(time.Now().Add(HelloTimeout))
	var h hello
	if err := c.ReadJSON(&h); err != nil || h.Op != "hello" {
		_ = c.Fail(CodeBadRequest, "Thiếu bắt tay hello.")
		return
	}
	_ = c.SetReadDeadline(time.Time{})
	if h.V != Version {
		_ = c.WriteJSON(map[string]any{"ok": false, "code": CodeVersion, "v": Version, "worker": s.Worker,
			"error": (&VersionError{}).Error()})
		return
	}
	if err := c.OK(map[string]any{"v": Version, "worker": s.Worker}); err != nil {
		return
	}
	s.log().Debug("Client socket nội bộ đã nối", "client", clip(h.Client, 80))
	for {
		req, err := c.ReadRequest()
		if err != nil {
			if !errors.Is(err, io.EOF) && !errors.Is(err, net.ErrClosed) {
				_ = c.Fail(CodeBadRequest, err.Error())
			}
			return
		}
		if s.Handler == nil {
			_ = c.Fail(CodeUnsupported, "hive-worker chưa nhận thao tác "+clip(req.Op, 40)+".")
			continue
		}
		if err := s.Handler(ctx, c, req); err != nil {
			if !errors.Is(err, ErrDone) && !errors.Is(err, io.EOF) && !errors.Is(err, net.ErrClosed) {
				s.log().Debug("Đóng kết nối socket nội bộ", "op", req.Op, "error", err)
			}
			return
		}
	}
}

func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return strings.ToValidUTF8(s[:n], "")
}
