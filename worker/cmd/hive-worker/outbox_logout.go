package main

import (
	"context"
	"strings"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/localipc"
	"github.com/tdduydev/xdev-hive/worker/internal/outbox"
)

// Op `outbox.logout` cho `hive logout` và app (specs/027 T025, edge case đăng xuất khi còn mục): đếm mục của người
// đang đăng nhập hub đó, rồi gửi trước, giữ lại hay bỏ trước khi token bị xoá.

const (
	logoutCount = "count"
	logoutSend  = "send"
	logoutKeep  = "keep"
	logoutDrop  = "drop"

	defaultLogoutWait = 30 * time.Second
)

type logoutRequest struct {
	HubURL string `json:"hubUrl"`
	Action string `json:"action"`
	WaitMs *int   `json:"waitMs"`
}

func (s *outboxService) logout(ctx context.Context, c *localipc.Conn, req localipc.Request) error {
	var r logoutRequest
	if err := req.Decode(&r); err != nil {
		return c.Fail(localipc.CodeBadRequest, err.Error())
	}
	switch r.Action {
	case logoutCount, logoutSend, logoutKeep, logoutDrop:
	default:
		return c.Fail(localipc.CodeBadRequest, "action phải là count, send, keep hoặc drop")
	}
	hub := strings.TrimRight(r.HubURL, "/")
	if hub == "" {
		return c.Fail(localipc.CodeBadRequest, "cần hubUrl")
	}
	ids, err := s.logoutIdentities(ctx, hub, r.Action)
	if err != nil {
		return failOutbox(c, err)
	}
	out := map[string]any{}
	switch r.Action {
	case logoutSend:
		wait := defaultLogoutWait
		if r.WaitMs != nil && *r.WaitMs >= 0 {
			wait = min(time.Duration(*r.WaitMs)*time.Millisecond, maxSubmitWait)
		}
		s.flushAll(ctx, ids, wait)
		// Mục chưa tới hub sau lượt gửi ở lại như "Giữ lại": token sắp bị xoá, gửi tiếp chỉ ra 401.
		if err := s.holdPending(ids); err != nil {
			return c.Fail(localipc.CodeFailed, err.Error())
		}
	case logoutKeep:
		if err := s.holdPending(ids); err != nil {
			return c.Fail(localipc.CodeFailed, err.Error())
		}
	case logoutDrop:
		n := 0
		for _, id := range ids {
			items, err := s.store.List(id)
			if err != nil {
				return c.Fail(localipc.CodeFailed, err.Error())
			}
			// Drop giữ khoá của danh tính như lượt gửi, nên không bỏ mục đang trên đường tới hub.
			for _, it := range items {
				if err := s.store.Drop(id, it.Key); err == nil {
					n++
				}
			}
		}
		out["dropped"] = n
	}
	if r.Action != logoutCount {
		s.changed()
	}
	var total outbox.Stats
	for _, id := range ids {
		st, err := s.store.Stats(id)
		if err != nil {
			return c.Fail(localipc.CodeFailed, err.Error())
		}
		total.Pending += st.Pending
		total.Held += st.Held
		total.Rejected += st.Rejected
		total.Expired += st.Expired
	}
	out["pending"], out["held"], out["rejected"], out["expired"] = total.Pending, total.Held, total.Rejected, total.Expired
	return c.OK(out)
}

// logoutIdentities là danh tính của người đang đăng nhập hub. Không hỏi được hub là ai (hub vắng, hive.json chưa có
// userId) thì đếm và giữ lại mọi người dùng của hub đó vẫn an toàn, còn gửi và bỏ thì phải biết đúng người.
func (s *outboxService) logoutIdentities(ctx context.Context, hub, action string) ([]outbox.Identity, error) {
	all, err := s.store.Identities()
	if err != nil {
		return nil, err
	}
	var onHub []outbox.Identity
	for _, id := range all {
		if id.IsUser() && strings.TrimRight(id.HubURL, "/") == hub {
			onHub = append(onHub, id)
		}
	}
	cur, err := s.creds.Current(ctx)
	if err != nil || strings.TrimRight(cur.HubURL, "/") != hub {
		if action == logoutCount || action == logoutKeep {
			return onHub, nil
		}
		return nil, &outbox.Error{Code: "UNKNOWN_IDENTITY", Message: "Không xác định được người đang đăng nhập hub; chọn Giữ lại."}
	}
	for _, id := range onHub {
		if id.Key() == cur.Key() {
			return []outbox.Identity{id}, nil
		}
	}
	return nil, nil
}

// flushAll chạy một lượt gửi cho từng danh tính và chờ xong, tối đa wait.
func (s *outboxService) flushAll(ctx context.Context, ids []outbox.Identity, wait time.Duration) {
	timer := time.NewTimer(wait)
	defer timer.Stop()
	for _, id := range ids {
		// Mục đang giữ vì đăng nhập được thử lại bằng token hiện tại trước khi token bị xoá.
		if _, err := s.store.RetryHeld(id, outbox.HeldLoginRequired); err != nil {
			continue
		}
		w := &submitWaiter{ch: make(chan *outbox.Outcome, 1)}
		s.kick(id, w)
		select {
		case <-w.ch:
		case <-timer.C:
			return
		case <-ctx.Done():
			return
		}
	}
}

// holdPending giữ mục chờ gửi với lý do cần đăng nhập, để lần `hive login` sau của đúng người đưa chúng về hàng đợi.
func (s *outboxService) holdPending(ids []outbox.Identity) error {
	for _, id := range ids {
		// Ghi nhận token hiện tại trước, để nhịp gửi kế tiếp không coi đây là lần đăng nhập mới rồi thả mục vừa giữ.
		s.releaseHeld(id)
		items, err := s.store.List(id)
		if err != nil {
			return err
		}
		for _, it := range items {
			if it.State == outbox.StatePending || it.State == outbox.StateSending {
				if err := s.store.Hold(id, it.Key, outbox.HeldLoginRequired); err != nil {
					return err
				}
			}
		}
	}
	return nil
}
