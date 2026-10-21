package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/config"
	"github.com/tdduydev/xdev-hive/worker/internal/score"
)

// fakeHub nhận sự kiện client như hub và trả outcome theo outcome hiện tại.
type fakeHub struct {
	srv     *httptest.Server
	mu      sync.Mutex
	outcome string
	bodies  []map[string]any
	auth    []string
}

func newFakeHub(t *testing.T) *fakeHub {
	t.Helper()
	h := &fakeHub{outcome: "accepted"}
	h.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/v1/client-events" {
			http.NotFound(w, r)
			return
		}
		b, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(b, &body)
		h.mu.Lock()
		defer h.mu.Unlock()
		h.bodies = append(h.bodies, body)
		h.auth = append(h.auth, r.Header.Get("Authorization"))
		res := map[string]any{"key": body["key"], "outcome": h.outcome, "receivedAt": "2026-10-13T03:00:01Z"}
		if h.outcome == "rejected" {
			res["code"], res["reason"] = "TOKEN_SCORE_TOO_FREQUENT", "Điểm gửi quá dày."
		}
		_ = json.NewEncoder(w).Encode(res)
	}))
	t.Cleanup(h.srv.Close)
	old := optimizeHubHTTP
	optimizeHubHTTP = func() *http.Client { return h.srv.Client() }
	t.Cleanup(func() { optimizeHubHTTP = old })
	return h
}

func (h *fakeHub) count() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.bodies)
}

// scoreReportEnv dựng môi trường chấm điểm tối thiểu; registered thì ghi worker.json trỏ tới hub giả.
func scoreReportEnv(t *testing.T, hubURL string) optimizeEnv {
	t.Helper()
	e := fakeScoreEnv(t)
	e.write(t, ".claude/settings.json", "{}\n")
	e.accounts(t, `{"id":"claude-secret","cli":"claude","configDir":"~/.claude"}`)
	if hubURL != "" {
		if err := config.Save(e.config, config.Config{HubURL: hubURL, MachineID: "may-1", MachineToken: "hwm_test"}); err != nil {
			t.Fatal(err)
		}
	}
	return e
}

func (e optimizeEnv) reportState(t *testing.T) score.ReportState {
	t.Helper()
	st, err := score.LoadReportState(filepath.Join(e.home, ".xdev-hive", "optimizer"))
	if err != nil {
		t.Fatal(err)
	}
	return st
}

func (e optimizeEnv) reportView(t *testing.T, args ...string) scoreReportView {
	t.Helper()
	var v scoreReportView
	out := e.ok(t, append([]string{"report"}, append(args, "--json")...)...)
	if err := json.Unmarshal([]byte(out), &v); err != nil {
		t.Fatalf("không đọc được JSON: %v\n%s", err, out)
	}
	return v
}

func TestScoreReportAccepted(t *testing.T) {
	hub := newFakeHub(t)
	e := scoreReportEnv(t, hub.srv.URL)
	if v := e.reportView(t, "status"); v.Enabled || !v.Registered || v.Pending || v.LastSentAt != nil {
		t.Fatalf("mặc định tắt: %+v", v)
	}
	if v := e.reportView(t, "on"); !v.Enabled || !v.Registered {
		t.Fatalf("bật: %+v", v)
	}
	e.ok(t, "score", "--json")
	if hub.count() != 1 {
		t.Fatalf("hub nhận %d lần, cần 1", hub.count())
	}
	body := hub.bodies[0]
	if hub.auth[0] != "Bearer hwm_test" || body["kind"] != "machine.token_score" || body["createdAt"] != "2026-10-13T03:00:00Z" {
		t.Errorf("sự kiện: %v, auth %q", body, hub.auth[0])
	}
	if key, _ := body["key"].(string); !regexp.MustCompile(`^[0-9A-HJKMNP-TV-Z]{26}$`).MatchString(key) {
		t.Errorf("khoá không phải ULID: %q", key)
	}
	raw, _ := json.Marshal(body["payload"])
	if strings.Contains(string(raw), "claude-secret") || strings.Contains(string(raw), e.home) || !strings.Contains(string(raw), `"cli":"claude"`) {
		t.Errorf("payload: %s", raw)
	}
	st := e.reportState(t)
	if st.Pending != nil || st.LastSentAt == nil || !st.LastSentAt.Equal(optimizeNow()) {
		t.Errorf("hub nhận thì bỏ báo cáo chờ và ghi lần gửi: %+v", st)
	}

	// Chưa đủ một giờ thì không gửi; đủ thì gửi lại.
	base := optimizeNow()
	optimizeNow = func() time.Time { return base.Add(59 * time.Minute) }
	e.ok(t, "score", "--json")
	if hub.count() != 1 {
		t.Fatalf("gửi trong vòng một giờ: %d lần", hub.count())
	}
	optimizeNow = func() time.Time { return base.Add(61 * time.Minute) }
	e.ok(t, "score", "--json")
	if hub.count() != 2 {
		t.Fatalf("qua một giờ phải gửi lại: %d lần", hub.count())
	}
	if hub.bodies[0]["key"] == hub.bodies[1]["key"] {
		t.Error("mỗi lần chấm một khoá mới")
	}

	// Tắt thì không gửi nữa.
	optimizeNow = func() time.Time { return base.Add(3 * time.Hour) }
	e.reportView(t, "off")
	e.ok(t, "score", "--json")
	if hub.count() != 2 {
		t.Fatalf("đã tắt vẫn gửi: %d lần", hub.count())
	}
}

func TestScoreReportNetworkErrorKeepsPending(t *testing.T) {
	hub := newFakeHub(t)
	e := scoreReportEnv(t, hub.srv.URL)
	e.reportView(t, "on")
	hub.srv.Close()
	code, _, errOut := e.run(t, "score", "--json")
	if code != 0 {
		t.Fatalf("lỗi gửi không được làm hỏng lệnh chấm điểm: %d %s", code, errOut)
	}
	if !strings.Contains(errOut, "chưa gửi được điểm") {
		t.Errorf("stderr: %q", errOut)
	}
	st := e.reportState(t)
	if st.Pending == nil || st.LastSentAt != nil {
		t.Fatalf("hub vắng thì giữ báo cáo chờ: %+v", st)
	}
	var ev map[string]any
	if err := json.Unmarshal(st.Pending.Body, &ev); err != nil || ev["key"] != st.Pending.Key || ev["kind"] != "machine.token_score" {
		t.Errorf("báo cáo chờ: %s %v", st.Pending.Body, err)
	}
	if v := e.reportView(t, "status"); !v.Pending {
		t.Errorf("status phải báo còn báo cáo chờ: %+v", v)
	}
}

func TestScoreReportRejectedClearsPending(t *testing.T) {
	hub := newFakeHub(t)
	hub.outcome = "rejected"
	e := scoreReportEnv(t, hub.srv.URL)
	e.reportView(t, "on")
	_, _, errOut := e.run(t, "score", "--json")
	if hub.count() != 1 || !strings.Contains(errOut, "TOKEN_SCORE_TOO_FREQUENT") {
		t.Fatalf("hub nhận %d lần, stderr %q", hub.count(), errOut)
	}
	if st := e.reportState(t); st.Pending != nil || st.LastSentAt != nil {
		t.Errorf("bị từ chối thì bỏ báo cáo chờ, không ghi lần gửi: %+v", st)
	}
}

func TestScoreReportDisabledSendsNothing(t *testing.T) {
	hub := newFakeHub(t)
	e := scoreReportEnv(t, hub.srv.URL)
	e.ok(t, "score", "--json")
	if hub.count() != 0 {
		t.Fatalf("chưa bật mà đã gửi %d lần", hub.count())
	}
	if _, err := os.Stat(filepath.Join(e.home, ".xdev-hive", "optimizer", "score-report.json")); !os.IsNotExist(err) {
		t.Errorf("chưa bật thì không tạo score-report.json: %v", err)
	}
}

func TestScoreReportNotRegisteredSendsNothing(t *testing.T) {
	hub := newFakeHub(t)
	e := scoreReportEnv(t, "")
	if v := e.reportView(t, "on"); !v.Enabled || v.Registered {
		t.Fatalf("máy chưa đăng ký: %+v", v)
	}
	e.ok(t, "score", "--json")
	if hub.count() != 0 {
		t.Fatalf("máy chưa đăng ký mà đã gửi %d lần", hub.count())
	}
	if st := e.reportState(t); st.Pending != nil {
		t.Errorf("không có báo cáo chờ khi chưa đăng ký: %+v", st)
	}
}

func TestScoreReportOffDropsPending(t *testing.T) {
	hub := newFakeHub(t)
	e := scoreReportEnv(t, hub.srv.URL)
	e.reportView(t, "on")
	hub.srv.Close()
	e.run(t, "score", "--json")
	if v := e.reportView(t, "off"); v.Enabled || v.Pending {
		t.Fatalf("tắt thì bỏ báo cáo chờ: %+v", v)
	}
}

func TestOptimizeReportWithoutSubcommandStillTokenReport(t *testing.T) {
	e := scoreReportEnv(t, "")
	code, _, errOut := e.run(t, "report", "--json")
	if code != 0 {
		t.Fatalf("optimize report: %d %s", code, errOut)
	}
	if _, err := os.Stat(filepath.Join(e.home, ".xdev-hive", "optimizer", "score-report.json")); !os.IsNotExist(err) {
		t.Errorf("báo cáo token không đụng cài đặt gửi điểm: %v", err)
	}
}

func TestNewEventKey(t *testing.T) {
	at := time.Date(2026, 10, 13, 3, 0, 0, 0, time.UTC)
	a, b := newEventKey(at), newEventKey(at)
	if len(a) != 26 || a == b || a[:10] != b[:10] {
		t.Fatalf("khoá: %q %q", a, b)
	}
	if later := newEventKey(at.Add(time.Second)); later <= a {
		t.Errorf("khoá sau phải xếp sau: %q <= %q", later, a)
	}
}
