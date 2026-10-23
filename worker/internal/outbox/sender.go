package outbox

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/hubclient"
)

// Sender gửi một sự kiện máy tới hub. Test thay bằng hub giả; chạy thật dùng HubSender.
type Sender func(ctx context.Context, ev hubclient.ClientEvent) (hubclient.ClientEventResult, error)

// HubSender gửi bằng hubclient.PostClientEvent với machine token của máy.
func HubSender(hc *http.Client, baseURL, machineToken string) Sender {
	return func(ctx context.Context, ev hubclient.ClientEvent) (hubclient.ClientEventResult, error) {
		return hubclient.PostClientEvent(ctx, hc, baseURL, machineToken, ev)
	}
}

// Outcome là kết quả của một mục trong lượt gửi.
type Outcome struct {
	Key    string `json:"key"`
	Kind   string `json:"kind"`
	State  State  `json:"state"`
	Code   string `json:"code,omitempty"`
	Reason string `json:"reason,omitempty"`
	Error  string `json:"error,omitempty"`
}

// FlushResult đếm theo kết quả: Retry là lần gửi hỏng sẽ thử lại, Waiting là mục chưa tới giờ thử lại.
type FlushResult struct {
	Accepted  int       `json:"accepted"`
	Duplicate int       `json:"duplicate"`
	Rejected  int       `json:"rejected"`
	Expired   int       `json:"expired"`
	Retry     int       `json:"retry"`
	Waiting   int       `json:"waiting"`
	Items     []Outcome `json:"items"`
}

// backoff là thời gian chờ sau lần gửi hỏng thứ n: 5 giây, gấp đôi mỗi lần, tối đa 5 phút.
func backoff(attempts int) time.Duration {
	d := backoffBase
	for i := 1; i < attempts && d < backoffMax; i++ {
		d *= 2
	}
	return min(d, backoffMax)
}

// Event dựng body gửi hub từ mục. CreatedAt và payload lấy từ file nên mỗi lần gửi lại đúng byte cũ.
func (it Item) Event() hubclient.ClientEvent {
	return hubclient.ClientEvent{Key: it.Key, Kind: it.Kind, CreatedAt: it.CreatedAt.UTC().Format(time.RFC3339), Payload: it.Body}
}

// Flush gửi các mục tới hạn của danh tính theo thứ tự trong từng stream. Mục `sending` còn lại là của tiến trình bị
// giết giữa lúc gửi: gửi lại cùng khoá, hub đã nhận thì trả `duplicate`. Mất mạng thì dừng cả lượt, các mục còn lại chờ
// lượt sau, khỏi chờ timeout từng mục.
func (s Store) Flush(ctx context.Context, id Identity, send Sender) (FlushResult, error) {
	res := FlushResult{Items: []Outcome{}}
	unlock, err := s.lock(id)
	if err != nil {
		return res, err
	}
	defer unlock()
	s.cleanTemp(id)
	items, _, err := s.load(id)
	if err != nil {
		return res, err
	}
	hub := normalizeHub(id.HubURL)
	blocked := map[string]bool{}
	offline := false
	for _, l := range items {
		it := l.Item
		// Mục của lần đăng ký với hub khác: machine token hiện tại không gửi thay được.
		if normalizeHub(it.Identity.HubURL) != hub {
			continue
		}
		switch it.State {
		case StateAccepted, StateDuplicate:
			// Hub đã nhận nhưng tiến trình chết trước khi dọn: chỉ dọn, không gửi lại.
			if err := s.finish(id, it, s.now()); err != nil {
				return res, err
			}
			continue
		case StateRejected, StateExpired:
			continue
		}
		now := s.now()
		if it.expired(now) {
			it.State, it.NextAttemptAt = StateExpired, nil
			if err := s.write(id, it); err != nil {
				return res, err
			}
			res.Expired++
			res.Items = append(res.Items, Outcome{Key: it.Key, Kind: it.Kind, State: it.State})
			continue
		}
		if blocked[it.Stream] {
			continue
		}
		if it.State == StateHeld {
			// Mục sau cùng stream có thể phụ thuộc mục bị giữ (cập nhật task sau khi gửi kế hoạch), nên chờ cùng.
			blocked[it.Stream] = true
			res.Waiting++
			continue
		}
		if offline || (it.State == StatePending && it.NextAttemptAt != nil && now.Before(*it.NextAttemptAt)) {
			blocked[it.Stream] = true
			res.Waiting++
			continue
		}

		// Ghi `sending` trước khi gửi: tiến trình chết sau đó thì lần sau biết mục có thể đã tới hub.
		it.State, it.Attempts, it.NextAttemptAt = StateSending, it.Attempts+1, nil
		it.LastAttemptAt = &now
		if err := s.write(id, it); err != nil {
			return res, err
		}
		r, sendErr := send(ctx, it.Event())
		now = s.now()
		out := Outcome{Key: it.Key, Kind: it.Kind}
		var statusErr *hubclient.StatusError
		switch {
		case sendErr == nil && (r.Outcome == hubclient.OutcomeAccepted || r.Outcome == hubclient.OutcomeDuplicate):
			it.State, it.LastError = State(r.Outcome), ""
			it.Result = &Result{Outcome: r.Outcome, ReceivedAt: r.ReceivedAt}
			if err := s.write(id, it); err != nil {
				return res, err
			}
			if err := s.finish(id, it, now); err != nil {
				return res, err
			}
			if it.State == StateAccepted {
				res.Accepted++
			} else {
				res.Duplicate++
			}
		case sendErr == nil && r.Outcome == hubclient.OutcomeRejected:
			it.State, it.LastError = StateRejected, ""
			it.Result = &Result{Outcome: r.Outcome, Code: r.Code, Reason: r.Reason, ReceivedAt: r.ReceivedAt}
			out.Code, out.Reason = r.Code, r.Reason
			res.Rejected++
		case errors.As(sendErr, &statusErr) && permanent(statusErr.Status):
			// Hub từ chối cả yêu cầu (sai schema, quá lớn): gửi lại cùng byte vẫn hỏng.
			it.State, it.LastError = StateRejected, ""
			it.Result = &Result{Outcome: hubclient.OutcomeRejected, Code: fmt.Sprintf("HTTP_%d", statusErr.Status), Reason: statusErr.Message}
			out.Code, out.Reason = it.Result.Code, it.Result.Reason
			res.Rejected++
		default:
			// Mạng, hub lỗi hay quá tải, token bị thu hồi, hub cũ chưa có đường dẫn: chờ rồi thử lại tới khi hết hạn.
			if sendErr == nil {
				sendErr = fmt.Errorf("hub trả kết quả lạ %q", r.Outcome)
			}
			next := now.Add(backoff(it.Attempts))
			it.State, it.NextAttemptAt, it.LastError = StatePending, &next, sendErr.Error()
			out.Error = it.LastError
			blocked[it.Stream] = true
			res.Retry++
			if statusErr == nil {
				offline = true
			}
		}
		if it.State != StateAccepted && it.State != StateDuplicate {
			if err := s.write(id, it); err != nil {
				return res, err
			}
		}
		out.State = it.State
		res.Items = append(res.Items, out)
	}
	if err := s.pruneSent(id, s.now()); err != nil {
		return res, err
	}
	return res, nil
}

// permanent là mã HTTP mà gửi lại cùng body không đổi kết quả. 401/403 (token bị thu hồi hay đổi) và 404 (hub cũ chưa có
// đường dẫn) vẫn thử lại: đăng ký lại hay nâng hub thì gửi được, còn không thì mục hết hạn sau 14 ngày.
func permanent(status int) bool {
	switch status {
	case http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound, http.StatusRequestTimeout, http.StatusTooManyRequests:
		return false
	}
	return status >= 400 && status < 500
}

func (s Store) write(id Identity, it Item) error {
	b, err := json.Marshal(it)
	if err != nil {
		return err
	}
	return writeAtomic(s.itemPath(id, it.Key), b)
}

// finish ghi sent.jsonl rồi xoá file mục. Chết giữa hai bước thì lần sau gặp lại mục `accepted`; dòng đã có thì không ghi
// thêm.
func (s Store) finish(id Identity, it Item, now time.Time) error {
	sent, err := s.Sent(id)
	if err != nil {
		return err
	}
	exists := false
	for _, e := range sent {
		if e.Key == it.Key {
			exists = true
			break
		}
	}
	if !exists {
		e := SentEntry{Key: it.Key, Kind: it.Kind, Stream: it.Stream, Outcome: string(it.State), SentAt: now.UTC()}
		if it.Result != nil {
			e.ReceivedAt = it.Result.ReceivedAt
		}
		if err := s.appendSent(id, e); err != nil {
			return err
		}
	}
	if err := os.Remove(s.itemPath(id, it.Key)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}
