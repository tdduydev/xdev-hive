package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const usageProject = "11111111-1111-4111-8111-111111111111"

// usageTranscript là transcript Claude Code có cwd tuỳ ý; cwd đi qua json.Marshal để dấu `\` của Windows được escape.
func usageTranscript(t *testing.T, cwd, ts string) string {
	t.Helper()
	c, err := json.Marshal(cwd)
	if err != nil {
		t.Fatal(err)
	}
	return `{"type":"user","timestamp":"` + ts + `","cwd":` + string(c) + `,"entrypoint":"cli","version":"2.1.296","message":{"role":"user","content":"bí mật"}}` + "\n" +
		`{"type":"assistant","timestamp":"` + ts + `","message":{"id":"m1","model":"claude-opus-5-5","usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":3000,"cache_creation_input_tokens":0},"content":[{"type":"text","text":"chào"}]}}` + "\n"
}

// projectUsageEnv dựng máy có một dự án gắn với thư mục <home>/repo, hai phiên trong thư mục con của nó và một phiên ngoài.
func projectUsageEnv(t *testing.T, hubURL string) (optimizeEnv, string) {
	t.Helper()
	e := scoreReportEnv(t, hubURL)
	// Repo nằm ngoài thư mục tạm: thư mục tạm của macOS có `/T/`, tokenreport coi phiên ở đó là phiên test và bỏ qua.
	repo := filepath.Join(string(filepath.Separator), "srv", "repo")
	e.write(t, ".claude/projects/-a/in1.jsonl", usageTranscript(t, filepath.Join(repo, "pkg", "sub"), "2026-10-12T08:00:00Z"))
	e.write(t, ".claude/projects/-a/in2.jsonl", usageTranscript(t, repo, "2026-10-12T09:00:00Z"))
	e.write(t, ".claude/projects/-a/out.jsonl", usageTranscript(t, filepath.Join(e.home, "other"), "2026-10-12T09:00:00Z"))
	list, err := json.Marshal(map[string]any{"projects": []map[string]any{
		{"projectId": usageProject, "name": "ứng dụng", "folder": repo},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(filepath.Dir(e.config), "projects.json"), list, 0o644); err != nil {
		t.Fatal(err)
	}
	return e, filepath.Join(e.home, ".xdev-hive", "optimizer")
}

func setProjectUsage(t *testing.T, e optimizeEnv, dir, sub string) projectUsageView {
	t.Helper()
	var out, errOut bytes.Buffer
	if code := optimizeProjectUsage(dir, e.config, usageProject, sub, true, &out, &errOut); code != 0 {
		t.Fatalf("%s: %d %s", sub, code, errOut.String())
	}
	var v projectUsageView
	if err := json.Unmarshal(out.Bytes(), &v); err != nil {
		t.Fatalf("JSON: %v\n%s", err, out.String())
	}
	return v
}

func TestProjectUsageDisabledSendsNothing(t *testing.T) {
	hub := newFakeHub(t)
	e, dir := projectUsageEnv(t, hub.srv.URL)
	if v := setProjectUsage(t, e, dir, "status"); v.Enabled {
		t.Fatalf("mặc định phải tắt: %+v", v)
	}
	e.ok(t, "score", "--json")
	if hub.count() != 0 || len(e.outboxItems(t)) != 0 {
		t.Fatalf("cờ tắt mà vẫn gửi hay xếp hàng: %d lần, %d mục", hub.count(), len(e.outboxItems(t)))
	}
	// Bật cờ điểm máy không kéo theo cờ dự án.
	e.reportView(t, "on")
	e.ok(t, "score", "--json")
	for _, b := range hub.bodies {
		if b["kind"] == "project.token_usage" {
			t.Fatalf("cờ dự án tắt vẫn gửi: %v", b)
		}
	}
}

func TestProjectUsageSentWhenEnabled(t *testing.T) {
	hub := newFakeHub(t)
	e, dir := projectUsageEnv(t, hub.srv.URL)
	if v := setProjectUsage(t, e, dir, "on"); !v.Enabled || !v.Registered {
		t.Fatalf("bật: %+v", v)
	}
	e.ok(t, "score", "--json")
	if hub.count() != 1 {
		t.Fatalf("hub nhận %d lần, cần 1", hub.count())
	}
	body := hub.bodies[0]
	if body["kind"] != "project.token_usage" || hub.auth[0] != "Bearer hwm_test" {
		t.Fatalf("sự kiện: %v", body)
	}
	payload, _ := body["payload"].(map[string]any)
	if payload["projectId"] != usageProject || payload["sessions"] != float64(2) {
		t.Errorf("payload: %v", payload)
	}
	claude, _ := payload["tokens"].(map[string]any)["claude"].(map[string]any)
	if claude["input"] != float64(20) || claude["output"] != float64(40) || claude["cacheRead"] != float64(6000) {
		t.Errorf("tokens (chỉ hai phiên trong dự án): %v", claude)
	}
	raw, _ := json.Marshal(body)
	for _, leak := range []string{"bí mật", "chào", "repo", "pkg", "other", e.home, "claude-secret", "ứng dụng"} {
		if strings.Contains(string(raw), leak) {
			t.Errorf("payload lộ %q: %s", leak, raw)
		}
	}
	if v := setProjectUsage(t, e, dir, "status"); v.LastSentAt == nil || !v.LastSentAt.Equal(optimizeNow()) || v.Pending {
		t.Errorf("hub nhận thì ghi lần gửi: %+v", v)
	}

	// Chưa đủ một giờ thì không gửi lại; đủ thì gửi.
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

	// Tắt thì không gửi nữa.
	setProjectUsage(t, e, dir, "off")
	optimizeNow = func() time.Time { return base.Add(5 * time.Hour) }
	e.ok(t, "score", "--json")
	if hub.count() != 2 {
		t.Fatalf("đã tắt vẫn gửi: %d lần", hub.count())
	}
}

func TestProjectUsageOffDropsPending(t *testing.T) {
	hub := newFakeHub(t)
	e, dir := projectUsageEnv(t, hub.srv.URL)
	setProjectUsage(t, e, dir, "on")
	hub.srv.Close()
	e.ok(t, "score", "--json")
	if items := e.outboxItems(t); len(items) != 1 || items[0].Kind != "project.token_usage" {
		t.Fatalf("hub vắng thì số liệu nằm lại hộp thư đi: %+v", items)
	}
	if v := setProjectUsage(t, e, dir, "status"); !v.Pending || v.LastSentAt != nil {
		t.Errorf("trạng thái: %+v", v)
	}
	if v := setProjectUsage(t, e, dir, "off"); v.Enabled || v.Pending {
		t.Errorf("tắt: %+v", v)
	}
	if items := e.outboxItems(t); len(items) != 0 {
		t.Errorf("tắt phải bỏ số liệu đang chờ: %+v", items)
	}
}

func TestProjectUsageRejectsBadProjectID(t *testing.T) {
	e, dir := projectUsageEnv(t, "")
	var out, errOut bytes.Buffer
	if code := optimizeProjectUsage(dir, e.config, "../etc", "on", true, &out, &errOut); code == 0 {
		t.Fatal("mã dự án sai phải bị từ chối")
	}
}
