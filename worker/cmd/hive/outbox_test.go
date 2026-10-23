package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/tdduydev/xdev-hive/worker/internal/localipc"
	"github.com/tdduydev/xdev-hive/worker/internal/outbox"
)

// fakeOutbox là hive-worker giả cho op outbox.*: trả lời đặt sẵn theo op, nhớ yêu cầu để test kiểm.
type fakeOutbox struct {
	mu       sync.Mutex
	reqs     []map[string]any
	bodyFile []byte
	submit   func(req map[string]any) (map[string]any, string)
}

func startOutbox(t *testing.T) (string, *fakeOutbox) {
	t.Helper()
	// Đường dẫn ngắn: socket Unix giới hạn khoảng 100 ký tự, thư mục t.TempDir() trên macOS dài hơn.
	dir, err := os.MkdirTemp("", "hvo")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	f := &fakeOutbox{}
	path := filepath.Join(dir, "hive.sock")
	ln, err := localipc.Listen(path)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		_ = (&localipc.Server{Worker: "9.9.9-test", Handler: f.handle}).Serve(ctx, ln)
		close(done)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	return path, f
}

func (f *fakeOutbox) handle(_ context.Context, c *localipc.Conn, req localipc.Request) error {
	var m map[string]any
	if err := req.Decode(&m); err != nil {
		return c.Fail(localipc.CodeBadRequest, err.Error())
	}
	f.mu.Lock()
	f.reqs = append(f.reqs, m)
	f.mu.Unlock()
	switch req.Op {
	case "outbox.status":
		return c.OK(map[string]any{"hub": "down", "hubUrl": "https://hive.example.vn", "lastContactAt": "2026-10-23T03:00:00Z",
			"pending": 1, "held": 1, "rejected": 1, "expired": 0, "bytes": 2048, "limitBytes": 256 << 20})
	case "outbox.list":
		return c.OK(map[string]any{"items": []any{
			map[string]any{"key": "01JBAAAAAAAAAAAAAAAAAAAAAA", "kind": "task_update", "state": "pending", "createdAt": "2026-10-23T03:00:00Z",
				"title": "Cập nhật task (task t-1)", "attempts": 2, "lastError": "hub không trả lời", "heldReason": nil},
			map[string]any{"key": "01JBBBBBBBBBBBBBBBBBBBBBBB", "kind": "doc_propose", "state": "rejected", "createdAt": "2026-10-23T03:01:00Z",
				"title": "Đề xuất tài liệu (doc d-1)", "result": map[string]any{"code": "STALE_BASE", "reason": "Tài liệu đã đổi."}, "heldReason": nil},
			map[string]any{"key": "01JBCCCCCCCCCCCCCCCCCCCCCC", "kind": "memory.write", "state": "held", "createdAt": "2026-10-23T03:02:00Z",
				"title": "Ghi bộ nhớ", "heldReason": outbox.HeldIdentityMismatch},
		}})
	case "outbox.drop":
		return c.OK(map[string]any{"dropped": []string{"01JBBBBBBBBBBBBBBBBBBBBBBB"}, "skipped": []string{"01JBAAAAAAAAAAAAAAAAAAAAAA"}})
	case "outbox.retry":
		return c.OK(map[string]any{"retried": 1})
	case "outbox.export":
		return c.OK(map[string]any{"path": m["path"], "count": 2})
	case "outbox.submit":
		if p, _ := m["bodyFile"].(string); p != "" {
			// Như worker: đọc rồi xoá file tạm.
			b, err := os.ReadFile(p)
			_ = os.Remove(p)
			if err != nil {
				return c.Fail(localipc.CodeBadRequest, err.Error())
			}
			f.mu.Lock()
			f.bodyFile = b
			f.mu.Unlock()
		}
		reply, code := f.submit(m)
		if code != "" {
			return c.Fail(code, reply["error"].(string))
		}
		return c.OK(reply)
	}
	return c.Fail(localipc.CodeUnsupported, "op lạ")
}

func (f *fakeOutbox) last() map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.reqs[len(f.reqs)-1]
}

func runOutbox(t *testing.T, path, stdin string, args ...string) (*testApp, int) {
	t.Helper()
	a := newTestApp(path, strings.NewReader(stdin))
	return a, a.run(append([]string{"outbox"}, args...))
}

func TestOutboxShow(t *testing.T) {
	path, f := startOutbox(t)
	a, code := runOutbox(t, path, "")
	out := a.out.String()
	if code != exitOK {
		t.Fatalf("mã %d, stderr %q", code, a.err.String())
	}
	for _, want := range []string{
		"Hub https://hive.example.vn: đang vắng · liên lạc lần cuối", "Chờ gửi: 1 · đang giữ: 1 · bị từ chối: 1",
		"2.0 KB / 256.0 MB", "Cập nhật task (task t-1)", "đã thử 2 lần: hub không trả lời", "Tài liệu đã đổi.",
		"máy đang đăng nhập người khác", "hive outbox drop <khoá>",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("thiếu %q trong:\n%s", want, out)
		}
	}

	a, code = runOutbox(t, path, "", "--json", "--state", "rejected,held")
	if code != exitOK {
		t.Fatalf("--json: mã %d, %q", code, a.err.String())
	}
	var got struct {
		Status outboxStatus     `json:"status"`
		Items  []map[string]any `json:"items"`
	}
	if err := json.Unmarshal([]byte(a.out.String()), &got); err != nil || got.Status.Hub != "down" || len(got.Items) != 3 {
		t.Fatalf("--json in %q: %v", a.out.String(), err)
	}
	if states, _ := f.last()["states"].([]any); len(states) != 2 || states[0] != "rejected" {
		t.Fatalf("list gửi %v", f.last())
	}
	if _, code := runOutbox(t, path, "", "--state", "accepted"); code != exitUsage {
		t.Fatalf("trạng thái lạ: mã %d", code)
	}
}

func TestOutboxDropRetryExport(t *testing.T) {
	path, f := startOutbox(t)
	a, code := runOutbox(t, path, "", "drop", "01JBBBBBBBBBBBBBBBBBBBBBBB", "01JBAAAAAAAAAAAAAAAAAAAAAA")
	if code != exitOK || !strings.Contains(a.out.String(), "Đã bỏ 1 mục.") || !strings.Contains(a.out.String(), "01JBAAAAAAAAAAAAAAAAAAAAAA") {
		t.Fatalf("drop: mã %d, %q", code, a.out.String())
	}
	if keys, _ := f.last()["keys"].([]any); len(keys) != 2 {
		t.Fatalf("drop gửi %v", f.last())
	}
	if a, code := runOutbox(t, path, "", "retry", "01JBCCCCCCCCCCCCCCCCCCCCCC"); code != exitOK || !strings.Contains(a.out.String(), "Đã đưa 1 mục") {
		t.Fatalf("retry: mã %d, %q", code, a.out.String())
	}
	if _, code := runOutbox(t, path, "", "retry"); code != exitUsage {
		t.Fatalf("retry thiếu khoá: mã %d", code)
	}

	wd, _ := os.Getwd()
	a, code = runOutbox(t, path, "", "export", "-o", "hop-thu.json")
	if code != exitOK || f.last()["path"] != filepath.Join(wd, "hop-thu.json") || f.last()["keys"] != nil {
		t.Fatalf("export: mã %d, gửi %v, stderr %q", code, f.last(), a.err.String())
	}
	if _, code := runOutbox(t, path, "", "export"); code != exitUsage {
		t.Fatalf("export thiếu -o: mã %d", code)
	}
}

func TestOutboxSubmit(t *testing.T) {
	path, f := startOutbox(t)
	f.submit = func(req map[string]any) (map[string]any, string) {
		if req["kind"] == "leader_reply" {
			return map[string]any{"error": "Hub đang vắng (https://hive.example.vn). Thao tác này cần hub trả lời ngay."}, "NOT_QUEUEABLE"
		}
		return map[string]any{"state": "queued", "key": req["key"], "pending": 1, "hub": "down"}, ""
	}
	req := `{"key":"01JBDDDDDDDDDDDDDDDDDDDDDD","source":"desktop","transport":"mcp","kind":"doc_propose","body":{"name":"doc_propose","arguments":{"docId":"d-1"}}}`
	a, code := runOutbox(t, path, req, "submit", "--json", "-")
	var reply map[string]any
	if code != exitOK || json.Unmarshal([]byte(a.out.String()), &reply) != nil || reply["state"] != "queued" || reply["ok"] != true {
		t.Fatalf("submit: mã %d, %q, stderr %q", code, a.out.String(), a.err.String())
	}
	if f.last()["op"] != "outbox.submit" || f.last()["body"] == nil {
		t.Fatalf("worker nhận %v", f.last())
	}

	// Lỗi vẫn in JSON trên stdout để app đọc mã.
	a, code = runOutbox(t, path, `{"transport":"mcp","kind":"leader_reply","body":{}}`, "submit", "--json", "-")
	if code != exitFailed || !strings.Contains(a.out.String(), `"code":"NOT_QUEUEABLE"`) || !strings.Contains(a.err.String(), "Hub đang vắng") {
		t.Fatalf("NOT_QUEUEABLE: mã %d, %q, %q", code, a.out.String(), a.err.String())
	}

	if _, code := runOutbox(t, path, "khong phai json", "submit", "--json", "-"); code != exitUsage {
		t.Fatalf("stdin hỏng: mã %d", code)
	}
	if _, code := runOutbox(t, path, req, "submit"); code != exitUsage {
		t.Fatalf("thiếu --json -: mã %d", code)
	}
}

func TestOutboxSubmitLargeBodyGoesThroughFile(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	path, f := startOutbox(t)
	f.submit = func(req map[string]any) (map[string]any, string) {
		return map[string]any{"state": "queued", "key": "01JBEEEEEEEEEEEEEEEEEEEEEE", "pending": 1, "hub": "down"}, ""
	}
	content := strings.Repeat("nội dung dài ", 8000)
	body, _ := json.Marshal(map[string]any{"path": "memory/write", "input": map[string]any{"content": content}})
	req := `{"transport":"rpc","kind":"memory.write","body":` + string(body) + `}`
	a, code := runOutbox(t, path, req, "submit", "--json", "-")
	if code != exitOK {
		t.Fatalf("mã %d, stderr %q", code, a.err.String())
	}
	file, _ := f.last()["bodyFile"].(string)
	if f.last()["body"] != nil || filepath.Dir(file) != filepath.Join(home, ".xdev-hive", "outbox", outbox.IncomingDir) {
		t.Fatalf("thân lớn phải đi qua file trong incoming: %v", file)
	}
	if string(f.bodyFile) != string(body) {
		t.Fatalf("worker đọc %d byte, muốn %d", len(f.bodyFile), len(body))
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatalf("file tạm còn: %v", err)
	}
}

func TestOutboxWorkerMissing(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "khong-co.sock")
	a, code := runOutbox(t, missing, "")
	if code != exitUsage || !strings.Contains(a.err.String(), "Chưa chạy hive-worker") {
		t.Fatalf("mã %d, %q", code, a.err.String())
	}
}
