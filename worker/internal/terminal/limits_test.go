//go:build !windows

package terminal

import (
	"strings"
	"testing"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/localipc"
)

// openRemote mở một phiên như term_start (T050 chưa có): không client nào gắn.
func openRemote(t *testing.T, l *Local) *localSession {
	t.Helper()
	id, err := l.reserve()
	if err != nil {
		t.Fatal(err)
	}
	s, err := l.start(id, CreateParams{CLI: "claude", Cwd: t.TempDir(), origin: OriginRemote}, 80, 24, "xterm-256color")
	if err != nil {
		l.release(id)
		t.Fatal(err)
	}
	return s
}

func sessionGone(l *Local, s *localSession) bool {
	for _, x := range l.list() {
		if x == s {
			return false
		}
	}
	return true
}

func (e *ctlEnv) exitOf(id string) (Exit, bool) {
	var got Exit
	ok := false
	e.link.snapshot(func(f *fakeLink) {
		for _, x := range f.exits {
			if x.SessionID == id {
				got, ok = x, true
			}
		}
	})
	return got, ok
}

func (e *ctlEnv) waitExit(id, reason, message string) {
	e.t.Helper()
	waitRec(e.t, "term_exit "+reason, func() bool {
		x, ok := e.exitOf(id)
		return ok && x.Reason == reason && strings.Contains(x.Message, message)
	})
}

// Tắt từ xa: thu quyền, ngắt phiên mở từ xa trong ≤ 2 s, phiên mở tại máy vẫn chạy (FR-022).
func TestLimitsRemoteOff(t *testing.T) {
	e := newCtlEnv(t, nil)
	l := e.ctl.Local
	rs := openRemote(t, l)
	e.control("conn-l1")

	start := time.Now()
	e.rem.HubDisable(DisableRequest{By: "u1"})
	e.waitRevoked("conn-l1", RevokeDisabled)
	select {
	case <-rs.done:
	case <-time.After(2 * time.Second):
		t.Fatal("phiên mở từ xa chưa kết thúc sau 2 s")
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("tắt mất %v", d)
	}
	waitRec(t, "term_exit của phiên mở từ xa", func() bool {
		x, ok := e.exitOf(rs.rec.ID())
		return ok && x.Reason == ReasonClosed && x.By == "u1"
	})
	list := l.List()
	if len(list) != 1 || list[0].HubID != e.hub || list[0].Origin != OriginLocal {
		t.Fatalf("phiên tại máy phải còn: %+v", list)
	}
	// Quyền đã sang điện thoại rồi bị thu; người ở máy giành lại mới gõ được.
	e.tc.ctl(t, localipc.CtlTake)
	e.tc.send(t, "vẫn chạy\n")
	e.tc.waitOut(t, "got:vẫn chạy")
	if !containsAll(auditActions(t, e.rem), "remote_disable", "session_close", "session_end", "control_revoke") {
		t.Fatalf("audit = %v", auditActions(t, e.rem))
	}
}

// term_close từ web: ngắt phiên, term_exit ghi người ngắt; mã lạ bị bỏ qua.
func TestLimitsTermClose(t *testing.T) {
	e := newCtlEnv(t, nil)
	e.ctl.Recorder.CloseSession(CloseRequest{SessionID: "5b0f8c1e-2d3a-4b5c-8d9e-0f1a2b3c4d5e", By: "u9"})
	e.ctl.Recorder.CloseSession(CloseRequest{SessionID: e.hub, Reason: "Quản trị đội ngắt phiên.", By: "u9"})
	exit := e.tc.waitCtl(t, localipc.CtlExit)
	if exit.Reason != ReasonClosed || exit.Message != "Quản trị đội ngắt phiên." {
		t.Fatalf("exit = %+v", exit)
	}
	waitRec(t, "term_exit by u9", func() bool {
		x, ok := e.exitOf(e.hub)
		return ok && x.Reason == ReasonClosed && x.By == "u9"
	})
	found := false
	for _, a := range auditActions(t, e.rem) {
		found = found || a == "session_close/hub:u9"
	}
	if !found {
		t.Fatalf("audit = %v", auditActions(t, e.rem))
	}
}

// Giới hạn thời gian chỉ áp cho phiên mở từ xa: không client + không output quá detachedHours, hoặc quá maxHours.
func TestLimitsDetachedAndMax(t *testing.T) {
	e := newCtlEnv(t, nil)
	l := e.ctl.Local
	idle := openRemote(t, l)
	busy := openRemote(t, l)
	viewer, _ := gate(t, e.path, map[string]any{"op": "session.attach", "id": busy.id, "mode": ModeView})
	viewer.waitOut(t, "READY")

	now := time.Now()
	l.checkLimits(now.Add(time.Hour))
	if sessionGone(l, idle) || sessionGone(l, busy) {
		t.Fatal("chưa tới giới hạn mà phiên đã bị ngắt")
	}

	l.checkLimits(now.Add(2*time.Hour + time.Minute))
	<-idle.done
	e.waitExit(idle.rec.ID(), ReasonIdle, "2 giờ")
	if sessionGone(l, busy) {
		t.Fatal("phiên còn người xem không được ngắt vì không ai gắn")
	}

	l.checkLimits(now.Add(12*time.Hour + time.Minute))
	exit := viewer.waitCtl(t, localipc.CtlExit)
	if exit.Reason != ReasonClosed || !strings.Contains(exit.Message, "12 giờ") {
		t.Fatalf("exit phiên quá 12 giờ = %+v", exit)
	}
	<-busy.done
	if len(l.List()) != 1 {
		t.Fatalf("phiên `hive chat` không được tự ngắt: %+v", l.List())
	}
	if !containsAll(auditActions(t, e.rem), "session_limit", "session_end") {
		t.Fatalf("audit = %v", auditActions(t, e.rem))
	}
}

// Giới hạn chỉnh tại máy (hive remote set) có hiệu lực ở lần kiểm sau.
func TestLimitsFromConfig(t *testing.T) {
	e := newCtlEnv(t, nil)
	l := e.ctl.Local
	mustCall(t, e.rem, map[string]any{"op": "remote.settings", "detachedHours": 1})
	s := openRemote(t, l)
	l.checkLimits(time.Now().Add(time.Hour + time.Minute))
	<-s.done
	e.waitExit(s.rec.ID(), ReasonIdle, "1 giờ")
}
