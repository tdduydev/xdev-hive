package terminal

import (
	"fmt"
	"strings"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/localipc"
	"github.com/tdduydev/xdev-hive/worker/internal/remoteauth"
)

// Tắt khẩn cấp, ngắt từ hub và giới hạn thời gian của phiên tại máy (specs/010 T040, FR-022–FR-024).

// Nguồn mở phiên tại máy.
const (
	OriginLocal  = "local"
	OriginRemote = "remote"
)

const (
	// DefaultRemoteKillGrace: phiên mở từ xa được SIGHUP rồi 10 giây mới bị giết (US5 kịch bản 1). Dài hơn hive kill vì
	// không ai ngồi ở máy chờ, nên cho CLI đủ thời gian lưu hội thoại.
	DefaultRemoteKillGrace = 10 * time.Second
	// defaultLimitTick: giới hạn tính bằng giờ nên kiểm mỗi phút là đủ, trễ tối đa một phút.
	defaultLimitTick = time.Minute
)

// Giới hạn bị vượt, ghi vào remote-audit.log.
const (
	limitDetached = "detached"
	limitMax      = "max"
)

// CloseRequest là term_close của phiên trên máy cá nhân: chủ phiên hay quản trị đội bấm "Ngắt" trên web (hub đã kiểm
// quyền; ngắt chỉ làm mất quyền, không cấp gì nên worker không đòi chữ ký).
type CloseRequest struct {
	SessionID, Reason, By string
}

func (l *Local) list() []*localSession {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]*localSession, 0, len(l.sessions))
	for _, s := range l.sessions {
		// nil là id đang giữ chỗ cho phiên còn chuẩn bị.
		if s != nil {
			out = append(out, s)
		}
	}
	return out
}

func (l *Local) killGrace(s *localSession) time.Duration {
	if s.origin == OriginRemote {
		return orDefault(l.RemoteKillGrace, DefaultRemoteKillGrace)
	}
	return orDefault(l.KillGrace, DefaultKillGrace)
}

func (l *Local) audit(action, by string, data map[string]any) {
	if l.Remote != nil {
		l.Remote.audit(action, by, data)
	}
}

// auditID: mã trên hub để khớp audit_log của hub; phiên không ghi thì dùng mã ngắn của hive ls.
func auditID(s *localSession) map[string]any {
	if id := s.rec.ID(); id != "" {
		return map[string]any{"sessionId": id, "origin": s.origin}
	}
	return map[string]any{"localId": s.id, "origin": s.origin}
}

// kill ngắt phiên theo yêu cầu của người (hive kill, term_close) và ghi audit "ngắt".
func (l *Local) kill(s *localSession, reason, message, by string) {
	data := auditID(s)
	data["reason"] = reason
	l.audit("session_close", by, data)
	s.stopBy(reason, message, by)
}

// ended ghi audit "phiên kết thúc" cho phiên người ngoài máy thấy được (ghi lên hub hoặc mở từ xa); phiên
// `hive chat --no-record` không liên quan tới điều khiển từ xa.
func (l *Local) ended(s *localSession, ctl localipc.Ctl, by string) {
	if s.rec.ID() == "" && s.origin != OriginRemote {
		return
	}
	data := auditID(s)
	data["reason"] = ctl.Reason
	if ctl.Code != nil {
		data["exitCode"] = *ctl.Code
	}
	if by == "" {
		by = byMachine
	}
	l.audit("session_end", by, data)
}

// exitBy đổi người ngắt dạng audit sang term_exit.by (userId hoặc "machine").
func exitBy(by string) string {
	if by == "hub" {
		return ""
	}
	return strings.TrimPrefix(by, "hub:")
}

// endRemote kết thúc mọi phiên mở từ xa khi tắt từ xa; phiên mở tại máy giữ nguyên (FR-022). Trả số phiên bị ngắt.
func (l *Local) endRemote(by string) int {
	if l == nil {
		return 0
	}
	n := 0
	for _, s := range l.list() {
		if s.origin == OriginRemote {
			l.kill(s, ReasonClosed, "Điều khiển từ xa đã tắt; phiên mở từ xa bị ngắt.", by)
			n++
		}
	}
	return n
}

// closeSession là term_close: ngắt phiên theo mã trên hub. Phiên không có trên máy thì bỏ qua (có thể là phiên Leader
// của Host, kênh chuyển cho cả hai).
func (l *Local) closeSession(req CloseRequest) bool {
	s := l.byHubID(req.SessionID)
	if s == nil {
		return false
	}
	msg := strings.TrimSpace(req.Reason)
	if msg == "" {
		msg = "Phiên đã bị ngắt từ web."
	}
	l.kill(s, ReasonClosed, clip(msg, 200), byHub(req.By))
	return true
}

// limits đọc giới hạn mỗi lần kiểm để chỉnh tại máy (hive remote set) có hiệu lực ngay.
func (l *Local) limits() (detached, max time.Duration) {
	var c remoteauth.Config
	if l.Remote != nil && l.Remote.Store != nil {
		if loaded, err := l.Remote.Store.Load(); err == nil {
			c = loaded
		} else {
			l.log().Warn("Không đọc được remote.json; dùng giới hạn mặc định", "error", err)
		}
	}
	return c.Detached(), c.Max()
}

// watchLimits chạy từ phiên đầu tiên tới khi worker tắt.
func (l *Local) watchLimits() {
	t := time.NewTicker(orDefault(l.LimitTick, defaultLimitTick))
	defer t.Stop()
	for now := range t.C {
		l.mu.Lock()
		closing := l.closing
		l.mu.Unlock()
		if closing {
			return
		}
		l.checkLimits(now)
	}
}

// checkLimits ngắt phiên mở từ xa không client, không output quá detachedHours, hoặc chạy quá maxHours (US5 kịch bản
// 4). Phiên `hive chat` tách ra như tmux là việc người ở máy chủ ý làm nên không tự ngắt.
func (l *Local) checkLimits(now time.Time) {
	detached, max := l.limits()
	for _, s := range l.list() {
		if s.origin != OriginRemote {
			continue
		}
		s.mu.Lock()
		stopping := s.ended || s.reason != ""
		alone := len(s.clients) == 0 && s.remote == nil
		quiet, age := now.Sub(s.active), now.Sub(s.started)
		s.mu.Unlock()
		switch {
		case stopping:
		case age >= max:
			l.limit(s, limitMax, ReasonClosed, max,
				fmt.Sprintf("Phiên mở từ xa đã chạy quá %s; hive-worker đã ngắt.", hoursText(max)))
		case alone && quiet >= detached:
			l.limit(s, limitDetached, ReasonIdle, detached,
				fmt.Sprintf("Phiên không có ai gắn và không có output trong %s; hive-worker đã ngắt.", hoursText(detached)))
		}
	}
}

func (l *Local) limit(s *localSession, which, reason string, d time.Duration, message string) {
	data := auditID(s)
	data["limit"], data["hours"] = which, int(d.Hours())
	l.audit("session_limit", byMachine, data)
	l.log().Info("Ngắt phiên vì quá giới hạn thời gian", "session", s.id, "limit", which)
	s.stopBy(reason, message, byMachine)
}

func hoursText(d time.Duration) string {
	if d < time.Hour {
		return fmt.Sprintf("%d phút", int(d.Minutes()))
	}
	return fmt.Sprintf("%d giờ", int(d.Hours()))
}

// ---- Nối với Controller và Recorder ----

// endRemote: tắt từ xa thu quyền rồi ngắt phiên mở từ xa.
func (c *Controller) endRemote(by string) int {
	if c == nil {
		return 0
	}
	return c.Local.endRemote(by)
}

// CloseSession là term_close cho phiên trên máy cá nhân.
func (r *Recorder) CloseSession(req CloseRequest) {
	if r.Controller != nil && r.Controller.Local != nil {
		go r.Controller.Local.closeSession(req)
	}
}
