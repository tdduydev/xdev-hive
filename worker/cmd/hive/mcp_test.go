package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/projects"
)

type mcpHarness struct {
	a    *testApp
	in   *io.PipeWriter
	done chan int
}

func startMCP(t *testing.T, handler http.HandlerFunc, args ...string) *mcpHarness {
	t.Helper()
	return startMCPWith(t, handler, "", args...)
}

// startMCPWith như startMCP, kèm socket worker (rỗng là socket không tồn tại).
func startMCPWith(t *testing.T, handler http.HandlerFunc, socket string, args ...string) *mcpHarness {
	t.Helper()
	a := authApp(t)
	hub := httptest.NewServer(handler)
	t.Cleanup(hub.Close)
	if _, err := a.saveToken(hub.URL, testToken); err != nil {
		t.Fatal(err)
	}
	a.getwd = func() (string, error) { return t.TempDir(), nil }
	if socket == "" {
		socket = filepath.Join(t.TempDir(), "khong-co.sock")
	}
	a.socket = func() (string, error) { return socket, nil }
	r, w := io.Pipe()
	a.stdin = r
	h := &mcpHarness{a: a, in: w, done: make(chan int, 1)}
	go func() { h.done <- a.run(append([]string{"mcp", "--hub", hub.URL}, args...)) }()
	t.Cleanup(func() {
		_ = w.Close()
		select {
		case code := <-h.done:
			if code != exitOK {
				t.Errorf("exit = %d, stderr = %s", code, a.err.String())
			}
		case <-time.After(5 * time.Second):
			t.Error("proxy không dừng sau khi đóng stdin")
		}
		_ = r.Close()
		if strings.Contains(a.err.String(), testToken) {
			t.Error("token lọt ra stderr")
		}
	})
	return h
}

func (h *mcpHarness) send(t *testing.T, message string) {
	t.Helper()
	if _, err := fmt.Fprintln(h.in, message); err != nil {
		t.Fatal(err)
	}
}

func (h *mcpHarness) lines(t *testing.T, count int) []string {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		lines := strings.Split(strings.TrimSpace(h.a.out.String()), "\n")
		if len(lines) >= count && lines[0] != "" {
			for _, line := range lines {
				if !json.Valid([]byte(line)) {
					t.Fatalf("stdout không phải NDJSON: %q", line)
				}
			}
			return lines
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("chỉ có stdout = %q, cần %d dòng", h.a.out.String(), count)
	return nil
}

func TestMCPJSONSessionAndNotifications(t *testing.T) {
	notification := make(chan struct{}, 1)
	h := startMCP(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/mcp" || r.Method != "POST" || r.Header.Get("Authorization") != "Bearer "+testToken || r.Header.Get("X-Hive-Project") != "HIVE" {
			t.Error("sai endpoint hoặc header xác thực/dự án")
		}
		if r.Header.Get("Accept") != "application/json, text/event-stream" || r.Header.Get("Content-Type") != "application/json" {
			t.Error("sai header MCP")
		}
		var message struct {
			Method string
			ID     json.RawMessage
		}
		_ = json.NewDecoder(r.Body).Decode(&message)
		if message.Method != "initialize" {
			if r.Header.Get("Mcp-Session-Id") != "session-test" || r.Header.Get("Mcp-Protocol-Version") != "2025-06-18" {
				t.Error("thiếu session/protocol")
			}
		}
		if message.Method == "notifications/initialized" {
			w.WriteHeader(http.StatusAccepted)
			notification <- struct{}{}
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Mcp-Session-Id", "session-test")
		fmt.Fprintf(w, "{\n\"jsonrpc\":\"2.0\",\"id\":%s,\"result\":{\"protocolVersion\":\"2025-06-18\"}}", message.ID)
	}, "--project", "HIVE")
	h.send(t, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}`)
	h.lines(t, 1)
	h.send(t, `{"jsonrpc":"2.0","method":"notifications/initialized"}`)
	select {
	case <-notification:
	case <-time.After(5 * time.Second):
		t.Fatal("notification chưa được gửi")
	}
	h.send(t, `{"jsonrpc":"2.0","id":"tools","method":"tools/list"}`)
	lines := h.lines(t, 2)
	if !strings.Contains(lines[1], `"id":"tools"`) {
		t.Fatal(lines)
	}
}

func TestMCPSSE(t *testing.T) {
	h := startMCP(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
		fmt.Fprint(w, ": heartbeat\r\n\r\nevent: message\r\nid: 3\r\ndata: {\"jsonrpc\":\"2.0\",\r\ndata: \"method\":\"notifications/message\",\"params\":{}}\r\n\r\n")
		w.(http.Flusher).Flush()
		fmt.Fprint(w, "data: {\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{}}\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	})
	h.send(t, `{"jsonrpc":"2.0","id":7,"method":"tools/list"}`)
	lines := h.lines(t, 2)
	if !strings.Contains(lines[0], "notifications/message") || !strings.Contains(lines[1], `"id":7`) {
		t.Fatal(lines)
	}
}

func TestMCPUnauthorizedAndSafeErrors(t *testing.T) {
	for _, status := range []int{401, 500, 302} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			h := startMCP(t, func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Location", "/token-must-not-follow")
				w.WriteHeader(status)
				fmt.Fprint(w, testToken)
			})
			h.send(t, `{"jsonrpc":"2.0","id":"request","method":"tools/list"}`)
			line := h.lines(t, 1)[0]
			if !strings.Contains(line, `"id":"request"`) || !strings.Contains(line, `"error"`) || strings.Contains(line, testToken) {
				t.Fatal("lỗi không an toàn hoặc sai ID")
			}
			if status == 401 && !strings.Contains(line, "Chạy hive login") {
				t.Fatal(line)
			}
		})
	}
}

func TestMCPCancelsOnStdinClose(t *testing.T) {
	started, cancelled := make(chan struct{}), make(chan struct{})
	h := startMCP(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		close(started)
		<-r.Context().Done()
		close(cancelled)
	})
	h.send(t, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("chưa gọi hub")
	}
	_ = h.in.Close()
	select {
	case <-cancelled:
	case <-time.After(5 * time.Second):
		t.Fatal("HTTP chưa bị huỷ")
	}
}

func TestMCPProjectDiscovery(t *testing.T) {
	a := authApp(t)
	root := t.TempDir()
	sub := filepath.Join(root, "nested")
	if err := os.Mkdir(sub, 0o700); err != nil {
		t.Fatal(err)
	}
	a.getwd = func() (string, error) { return sub, nil }
	workerPath := os.Getenv("HIVE_WORKER_CONFIG")
	data, _ := json.Marshal(map[string]any{"projects": []projects.Project{{ProjectID: "bound", Folder: root}, {ProjectID: "nested", Folder: sub}}})
	if err := os.WriteFile(projects.DefaultPath(workerPath), data, 0o600); err != nil {
		t.Fatal(err)
	}
	if got := a.mcpProject(authHub); got != "nested" {
		t.Fatalf("project = %q", got)
	}
	mcp := filepath.Join(root, ".mcp.json")
	if err := os.WriteFile(mcp, []byte(`{"mcpServers":{"xdev-hive":{"url":"`+authHub+`/mcp","headers":{"x-hive-project":"FROM-FILE","Authorization":"Bearer ignored"}}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := a.mcpProject(authHub); got != "FROM-FILE" {
		t.Fatalf("project = %q", got)
	}
	if got := a.mcpProject("https://other.example.test"); got != "nested" {
		t.Fatal("đã dùng cấu hình MCP của hub khác")
	}
	a.getwd = func() (string, error) { return root + "-sibling", nil }
	if got := a.mcpProject(authHub); got != "" {
		t.Fatalf("khớp nhầm thư mục cùng tiền tố: %q", got)
	}
}

func TestMCPMissingTokenAndInvalidInput(t *testing.T) {
	a := authApp(t)
	a.stdin = strings.NewReader("bad-json\n[]\n" + `{"jsonrpc":"2.0","id":9,"method":"tools/list"}` + "\n" + `{"jsonrpc":"2.0","method":"notifications/initialized"}` + "\n")
	if code := a.run([]string{"mcp", "--hub", authHub, "--project", "HIVE"}); code != exitOK {
		t.Fatal(code)
	}
	lines := strings.Split(strings.TrimSpace(a.out.String()), "\n")
	if len(lines) != 3 || !strings.Contains(lines[0], "-32700") || !strings.Contains(lines[1], "-32600") || !strings.Contains(lines[2], "Chạy hive login") || !strings.Contains(lines[2], `"id":9`) {
		t.Fatal(lines)
	}
	a.err.Reset()
	if code := a.run([]string{"mcp", "--unknown", testToken}); code != exitUsage || strings.Contains(a.err.String(), testToken) {
		t.Fatal("đối số sai làm lộ token")
	}
}

func TestMCPWriteToolsGoThroughOutbox(t *testing.T) {
	path, f := startOutbox(t)
	f.submit = func(req map[string]any) (map[string]any, string) {
		switch req["kind"] {
		case "doc_propose":
			return map[string]any{"state": "queued", "key": req["key"], "pending": 1, "hub": "down"}, ""
		case "doc_comment":
			return map[string]any{"error": "Máy chưa đăng nhập hub. Chạy hive login."}, "NOT_SIGNED_IN"
		}
		return map[string]any{"state": "accepted", "key": req["key"], "result": map[string]any{
			"outcome":  "accepted",
			"response": map[string]any{"content": []any{map[string]any{"type": "text", "text": "đã cập nhật"}}},
		}}, ""
	}
	hubCalls := make(chan string, 4)
	h := startMCPWith(t, func(w http.ResponseWriter, r *http.Request) {
		hubCalls <- r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"jsonrpc":"2.0","id":0,"result":{}}`)
	}, path, "--project", "HIVE")

	h.send(t, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"doc_propose","arguments":{"key":"kien-truc","content":"x"}}}`)
	line := h.lines(t, 1)[0]
	if !strings.Contains(line, "Đã xếp hàng, chờ hub (khoá ") || !strings.Contains(line, "không cần gọi lại") || strings.Contains(line, "isError") {
		t.Fatalf("queued: %s", line)
	}
	req := f.last()
	target, _ := req["target"].(map[string]any)
	body, _ := req["body"].(map[string]any)
	if req["source"] != "mcp-local" || req["transport"] != "mcp" || req["project"] != "HIVE" || req["waitMs"] != float64(mcpSubmitWaitMs) ||
		target["id"] != "kien-truc" || body["name"] != "doc_propose" || len(req["key"].(string)) != 26 {
		t.Fatalf("worker nhận %v", req)
	}

	h.send(t, `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"task_update","arguments":{"note":"xong"}}}`)
	if line := h.lines(t, 2)[1]; !strings.Contains(line, `"id":2`) || !strings.Contains(line, "đã cập nhật") {
		t.Fatalf("accepted phải trả nguyên kết quả của hub: %s", line)
	}
	h.send(t, `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"doc_comment","arguments":{"key":"kien-truc"}}}`)
	if line := h.lines(t, 3)[2]; !strings.Contains(line, `"isError":true`) || !strings.Contains(line, "chưa đăng nhập") {
		t.Fatalf("lỗi worker: %s", line)
	}
	select {
	case p := <-hubCalls:
		t.Fatalf("tool ghi không được gọi thẳng hub (%s)", p)
	default:
	}
}

func TestMCPWorkerMissingAndHubDown(t *testing.T) {
	h := startMCP(t, func(w http.ResponseWriter, r *http.Request) {
		// Hub chết giữa chừng: đóng kết nối không trả lời.
		conn, _, err := w.(http.Hijacker).Hijack()
		if err == nil {
			_ = conn.Close()
		}
	})
	h.send(t, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"task_update","arguments":{"note":"x"}}}`)
	if line := h.lines(t, 1)[0]; !strings.Contains(line, "Sidecar hive-worker không chạy") || !strings.Contains(line, `"isError":true`) {
		t.Fatalf("worker vắng: %s", line)
	}
	h.send(t, `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"leader_reply","arguments":{}}}`)
	if line := h.lines(t, 2)[1]; !strings.Contains(line, "Hub đang vắng (http://127.0.0.1") || !strings.Contains(line, `"isError":true`) {
		t.Fatalf("tool immediate khi hub vắng: %s", line)
	}
	h.send(t, `{"jsonrpc":"2.0","id":3,"method":"tools/list"}`)
	if line := h.lines(t, 3)[2]; !strings.Contains(line, "Hub đang vắng") || !strings.Contains(line, "-32603") {
		t.Fatalf("tools/list khi hub vắng: %s", line)
	}
}

func TestMCPLargeWriteGoesThroughFile(t *testing.T) {
	path, f := startOutbox(t)
	f.submit = func(req map[string]any) (map[string]any, string) {
		return map[string]any{"state": "queued", "key": req["key"], "pending": 1, "hub": "down"}, ""
	}
	h := startMCPWith(t, func(w http.ResponseWriter, r *http.Request) { t.Error("không được gọi hub") }, path)
	content := strings.Repeat("nội dung dài ", 8000)
	h.send(t, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"memory_write","arguments":{"content":"`+content+`"}}}`)
	if line := h.lines(t, 1)[0]; !strings.Contains(line, "Đã xếp hàng") {
		t.Fatal(line)
	}
	if f.last()["body"] != nil || !strings.Contains(string(f.bodyFile), content) {
		t.Fatalf("thân lớn phải đi qua file: %v", f.last()["bodyFile"])
	}
}
