package terminal

import (
	"context"
	"errors"
	"io"
	"net"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/localipc"
)

// watch là luồng sự kiện cho app desktop và `hive remote watch --json` (specs/010 T020): trả trạng thái hiện tại, rồi mỗi
// dòng một sự kiện (`state`, `pair_request`, `pair_done`, `start_request`, `start_done`, `outbox`, `outbox.item`). Cùng
// kết nối nhận tiếp yêu cầu (vd. remote.pair.decide) để app trả lời hộp xác nhận mà không cần mở kết nối thứ hai; dòng
// trả lời có "ok", dòng sự kiện có "event".

// Yêu cầu chờ chủ máy bấm Cho phép; trả lời bằng remote.pair.decide {pairId} hay remote.start.decide {requestId}.
const (
	eventPairRequest  = "pair_request"
	eventStartRequest = "start_request"
)

type watchEvent struct {
	Event     string        `json:"event"`
	State     *RemoteStatus `json:"state,omitempty"`
	PairID    string        `json:"pairId,omitempty"`
	RequestID string        `json:"requestId,omitempty"`
	// CLI, Cwd: phiên sắp mở (CLI, nhãn thư mục) để chủ máy biết mình đang cho phép gì.
	CLI       string    `json:"cli,omitempty"`
	Cwd       string    `json:"cwd,omitempty"`
	Label     string    `json:"label,omitempty"`
	UserID    string    `json:"userId,omitempty"`
	ExpiresAt time.Time `json:"expiresAt,omitzero"`
	OK        bool      `json:"ok,omitempty"`
	DeviceID  string    `json:"deviceId,omitempty"`
	Reason    string    `json:"reason,omitempty"`
}

// watchQueue: sự kiện chờ ghi mỗi người xem; đầy là client đọc không kịp, cắt kết nối để không chặn người khác.
const watchQueue = 64

type watcher struct {
	ch   chan any
	done chan struct{}
}

// Notify đưa sự kiện của phần khác trong worker (hộp thư đi: `outbox`, `outbox.item`) vào cùng luồng watch, để app chỉ
// giữ một kết nối nghe. e là object JSON có trường "event".
func (r *Remote) Notify(e any) { r.broadcast(e) }

func (r *Remote) broadcast(e any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for w := range r.watchers {
		select {
		case w.ch <- e:
		default:
			delete(r.watchers, w)
			close(w.done)
		}
	}
}

func (r *Remote) watch(ctx context.Context, c *localipc.Conn) error {
	st, err := r.Status()
	if err != nil {
		return c.Fail(localipc.CodeFailed, err.Error())
	}
	w := &watcher{ch: make(chan any, watchQueue), done: make(chan struct{})}
	r.mu.Lock()
	if r.watchers == nil {
		r.watchers = map[*watcher]struct{}{}
	}
	r.watchers[w] = struct{}{}
	// Yêu cầu ghép đang chờ từ trước khi mở watch vẫn phải hiện để người ở máy trả lời kịp.
	for _, d := range r.decisions {
		select {
		case w.ch <- d.ev:
		default:
		}
	}
	r.mu.Unlock()
	defer func() {
		r.mu.Lock()
		if _, ok := r.watchers[w]; ok {
			delete(r.watchers, w)
			close(w.done)
		}
		r.mu.Unlock()
	}()
	if err := c.OK(map[string]any{"status": st}); err != nil {
		return err
	}

	reqs := make(chan localipc.Request)
	readErr := make(chan error, 1)
	go func() {
		for {
			req, err := c.ReadRequest()
			if err != nil {
				readErr <- err
				return
			}
			select {
			case reqs <- req:
			case <-w.done:
				return
			}
		}
	}()
	for {
		select {
		case e := <-w.ch:
			if err := c.WriteJSON(e); err != nil {
				return err
			}
		case req := <-reqs:
			if req.Op == "watch" {
				_ = c.Fail(localipc.CodeBadRequest, "Kết nối này đang watch.")
				continue
			}
			if err := r.Handle(ctx, c, req); err != nil {
				return err
			}
		case err := <-readErr:
			if errors.Is(err, io.EOF) || errors.Is(err, net.ErrClosed) {
				return localipc.ErrDone
			}
			return err
		case <-w.done:
			_ = c.Fail(localipc.CodeBusy, "Đọc sự kiện không kịp; mở lại watch.")
			return localipc.ErrDone
		case <-ctx.Done():
			return localipc.ErrDone
		}
	}
}
