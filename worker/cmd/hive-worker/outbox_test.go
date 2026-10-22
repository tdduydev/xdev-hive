package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/outbox"
	"github.com/tdduydev/xdev-hive/worker/internal/score"
)

func (e optimizeEnv) outbox(t *testing.T, args ...string) (int, string, string) {
	t.Helper()
	var out, errOut bytes.Buffer
	code := outboxCommand(append(args, "--config", e.config), &out, &errOut)
	return code, out.String(), errOut.String()
}

func (e optimizeEnv) outboxJSON(t *testing.T, v any, args ...string) {
	t.Helper()
	code, out, errOut := e.outbox(t, append(args, "--json")...)
	if code != 0 {
		t.Fatalf("outbox %v thoát %d: %s", args, code, errOut)
	}
	if err := json.Unmarshal([]byte(out), v); err != nil {
		t.Fatalf("không đọc được JSON: %v\n%s", err, out)
	}
}

func (e optimizeEnv) outboxItems(t *testing.T) []outbox.Item {
	t.Helper()
	s := outbox.Store{Root: filepath.Join(e.home, ".xdev-hive", "outbox")}
	items, err := s.List(outbox.Identity{MachineID: "may-1"})
	if err != nil {
		t.Fatal(err)
	}
	return items
}

func TestOutboxSubmitFlushStatus(t *testing.T) {
	hub := newFakeHub(t)
	e := scoreReportEnv(t, hub.srv.URL)

	var sub outboxItemView
	e.outboxJSON(t, &sub, "submit", "--kind", "memory.propose", "--payload", `{"content":"Dùng pnpm"}`)
	if sub.Key == "" || sub.State != "pending" || sub.Kind != "memory.propose" {
		t.Fatalf("submit: %+v", sub)
	}
	if hub.count() != 0 {
		t.Fatal("submit chỉ xếp hàng, không gửi")
	}
	var st outboxStatusView
	e.outboxJSON(t, &st, "status")
	if !st.Registered || st.Pending != 1 || len(st.Items) != 1 || st.Items[0].Key != sub.Key {
		t.Fatalf("status: %+v", st)
	}

	var fl outboxFlushView
	e.outboxJSON(t, &fl, "flush")
	if !fl.Registered || fl.Accepted != 1 || fl.Remaining != 0 || hub.count() != 1 {
		t.Fatalf("flush: %+v, hub nhận %d", fl, hub.count())
	}
	body := hub.bodies[0]
	if body["key"] != sub.Key || body["kind"] != "memory.propose" || hub.auth[0] != "Bearer hwm_test" {
		t.Errorf("sự kiện: %v %v", body, hub.auth)
	}
	e.outboxJSON(t, &st, "status")
	if st.Pending != 0 || len(st.Items) != 0 || st.SentRecent != 1 {
		t.Errorf("status sau khi gửi: %+v", st)
	}
}

func TestOutboxSubmitFromFileAndErrors(t *testing.T) {
	hub := newFakeHub(t)
	e := scoreReportEnv(t, hub.srv.URL)
	p := filepath.Join(t.TempDir(), "p.json")
	if err := os.WriteFile(p, []byte(`{"projectId":"p1"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	var sub outboxItemView
	e.outboxJSON(t, &sub, "submit", "--kind", "project.token_usage", "--payload-file", p, "--stream", "project:p1")
	if sub.Stream != "project:p1" {
		t.Errorf("stream: %+v", sub)
	}
	if code, _, errOut := e.outbox(t, "submit", "--kind", "memory.write", "--payload", `{}`); code == 0 || errOut == "" {
		t.Errorf("kind lạ: %d %q", code, errOut)
	}
	if code, _, _ := e.outbox(t, "submit", "--kind", "memory.propose"); code != 2 {
		t.Errorf("thiếu payload: %d", code)
	}
	if code, _, _ := e.outbox(t, "nope"); code != 2 {
		t.Errorf("lệnh lạ: %d", code)
	}
	if code, _, errOut := e.outbox(t, "drop", sub.Key); code != 0 || len(e.outboxItems(t)) != 0 {
		t.Errorf("drop: %d %s", code, errOut)
	}
}

func TestOutboxNotRegistered(t *testing.T) {
	e := scoreReportEnv(t, "")
	if code, _, errOut := e.outbox(t, "submit", "--kind", "memory.propose", "--payload", `{}`); code != 1 || !strings.Contains(errOut, "chưa đăng ký") {
		t.Errorf("submit khi chưa đăng ký: %d %q", code, errOut)
	}
	var fl outboxFlushView
	e.outboxJSON(t, &fl, "flush")
	if fl.Registered {
		t.Errorf("flush: %+v", fl)
	}
}

func TestOutboxFlushHubDownKeepsItem(t *testing.T) {
	hub := newFakeHub(t)
	e := scoreReportEnv(t, hub.srv.URL)
	var sub outboxItemView
	e.outboxJSON(t, &sub, "submit", "--kind", "memory.propose", "--payload", `{}`)
	hub.srv.Close()
	var fl outboxFlushView
	e.outboxJSON(t, &fl, "flush")
	if fl.Retry != 1 || fl.Remaining != 1 {
		t.Fatalf("flush khi hub vắng: %+v", fl)
	}
	items := e.outboxItems(t)
	if len(items) != 1 || items[0].State != outbox.StatePending || items[0].NextAttemptAt == nil {
		t.Fatalf("mục: %+v", items)
	}
}

// Báo cáo điểm chờ của bản trước (score-report.json) được chuyển sang hộp thư đi với đúng khoá cũ.
func TestOutboxMigratesLegacyScorePending(t *testing.T) {
	hub := newFakeHub(t)
	e := scoreReportEnv(t, hub.srv.URL)
	dir := filepath.Join(e.home, ".xdev-hive", "optimizer")
	key := "01JAAAAAAAAAAAAAAAAAAAAAAA"
	body := `{"key":"` + key + `","kind":"machine.token_score","createdAt":"2026-10-13T02:00:00Z","payload":{"days":7}}`
	if _, err := score.UpdateReportState(dir, func(st *score.ReportState) error {
		st.Enabled = true
		st.Pending = &score.PendingReport{Key: key, Body: json.RawMessage(body)}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	var fl outboxFlushView
	e.outboxJSON(t, &fl, "flush")
	if fl.Accepted != 1 || hub.count() != 1 || hub.bodies[0]["key"] != key || hub.bodies[0]["createdAt"] != "2026-10-13T02:00:00Z" {
		t.Fatalf("flush: %+v, sự kiện %v", fl, hub.bodies)
	}
	st := e.reportState(t)
	if st.Pending != nil || st.LastSentAt == nil || !st.LastSentAt.Equal(optimizeNow()) {
		t.Errorf("hub nhận điểm thì bỏ báo cáo chờ cũ và ghi lần gửi: %+v", st)
	}
}

func TestOutboxLoopFlushesUntilCancelled(t *testing.T) {
	hub := newFakeHub(t)
	e := scoreReportEnv(t, hub.srv.URL)
	var sub outboxItemView
	e.outboxJSON(t, &sub, "submit", "--kind", "memory.propose", "--payload", `{}`)
	cfg, _ := registeredHub(e.config)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { outboxLoop(ctx, cfg, time.Hour); close(done) }()
	deadline := time.Now().Add(10 * time.Second)
	for hub.count() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	<-done
	if hub.count() != 1 {
		t.Fatalf("vòng gửi phải gửi ngay lúc bắt đầu: %d", hub.count())
	}
}
