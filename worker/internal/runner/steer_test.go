package runner

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// Claude (CLI stream-json): prompt đi qua stdin, chỉ dẫn gửi lúc agent chạy tới đúng phiên, worker báo đã áp dụng, và
// stdin chỉ đóng sau lượt cuối nên run kết thúc bình thường chứ không treo tới hết giờ.
func TestRunnerSteersStreamJSONCLI(t *testing.T) {
	remote, base := makeRemote(t)
	record := filepath.Join(t.TempDir(), "stdin.jsonl")
	cmds := map[string]Command{"claude": {Path: os.Args[0], Args: []string{"-test.run=TestFakeCLIHelper", "--", "helper"}, Input: InputStreamJSON}}
	steers := make(chan Steer, 4)
	// Hub cũ không gửi steerId: vẫn đưa vào agent nhưng không báo lại. Gửi trước khi CLI chạy, nằm chờ trong kênh.
	steers <- Steer{Input: "chỉ dẫn từ hub cũ"}
	var mu sync.Mutex
	var events []Event
	job := Job{RunID: "steer", Attempt: 1, RepoURL: fileURL(remote), BaseBranch: base, Branch: "ai/steer", CLI: "claude", Prompt: "sửa README", Timeout: 30 * time.Second, Steers: steers,
		Env: map[string]string{"HIVE_RUNNER_HELPER": "1", "HIVE_FAKE_MODE": "stream", "HIVE_FAKE_STEERS": "2", "HIVE_FAKE_RECORD": record}}
	start := time.Now()
	err := (Runner{DataDir: t.TempDir(), CLICommands: cmds, KillGrace: time.Second}).Run(context.Background(), job, SinkFunc(func(e Event) error {
		mu.Lock()
		events = append(events, e)
		mu.Unlock()
		if e.Type == "phase" && e.Phase == "running" {
			steers <- Steer{ID: "42", Input: "thêm test cho số âm"}
		}
		return nil
	}))
	if err != nil {
		t.Fatal(err)
	}
	if time.Since(start) > 15*time.Second {
		t.Fatal("run treo: stdin không được đóng sau lượt cuối")
	}
	if res := lastResult(events); res == nil || res.Status != "no_changes" {
		t.Fatalf("result = %+v", res)
	}
	// Hub bỏ mọi gói đến sau run_result, nên kết quả chỉ dẫn phải đi trước.
	var got []SteerResult
	for _, e := range events {
		if e.Type == "result" && len(got) == 0 {
			t.Fatal("steer_result phải đi trước run_result")
		}
		if e.Type == "steer_result" {
			got = append(got, *e.Steer)
		}
	}
	if len(got) != 1 || got[0] != (SteerResult{SteerID: "42", Applied: true}) {
		t.Fatalf("steer_result = %+v", got)
	}
	b, err := os.ReadFile(record)
	if err != nil {
		t.Fatal(err)
	}
	var msgs []string
	for _, line := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		var m string
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatal(err)
		}
		msgs = append(msgs, m)
	}
	want := []string{"sửa README", steerPrefix + "chỉ dẫn từ hub cũ", steerPrefix + "thêm test cho số âm"}
	if strings.Join(msgs, "|") != strings.Join(want, "|") {
		t.Fatalf("CLI nhận %q, cần %q", msgs, want)
	}
}

// CLI chỉ nhận prompt trong tham số (codex exec): báo hub chỉ dẫn chưa áp dụng, run vẫn chạy như thường.
func TestRunnerReportsSteerNotAppliedForArgsCLI(t *testing.T) {
	remote, base := makeRemote(t)
	steers := make(chan Steer, 1)
	var mu sync.Mutex
	var events []Event
	job := Job{RunID: "codex-steer", Attempt: 1, RepoURL: fileURL(remote), BaseBranch: base, Branch: "ai/codex-steer", CLI: "codex", Prompt: "p", Timeout: 20 * time.Second, Steers: steers,
		Env: map[string]string{"HIVE_RUNNER_HELPER": "1", "HIVE_FAKE_MODE": "wait"}}
	err := (Runner{DataDir: t.TempDir(), CLICommands: fakeCommands("wait")}).Run(context.Background(), job, SinkFunc(func(e Event) error {
		mu.Lock()
		events = append(events, e)
		mu.Unlock()
		if e.Type == "phase" && e.Phase == "running" {
			steers <- Steer{ID: "7", Input: "dùng pnpm"}
		}
		return nil
	}))
	if err != nil {
		t.Fatal(err)
	}
	if res := lastResult(events); res == nil || res.Status != "no_changes" {
		t.Fatalf("result = %+v", res)
	}
	var got *SteerResult
	for _, e := range events {
		if e.Type == "steer_result" {
			got = e.Steer
		}
	}
	if got == nil || got.SteerID != "7" || got.Applied || got.Reason == "" {
		t.Fatalf("steer_result = %+v", got)
	}
}

// ---- steering với stdin/stdout giả -------------------------------------------------------------------------------

type steerHarness struct {
	t       *testing.T
	s       *steering
	lines   chan map[string]any
	eof     chan struct{}
	mu      sync.Mutex
	results []SteerResult
}

func newSteerHarness(t *testing.T) *steerHarness {
	h := &steerHarness{t: t, lines: make(chan map[string]any, 32), eof: make(chan struct{})}
	h.s = newSteering("claude", func(r SteerResult) { h.mu.Lock(); h.results = append(h.results, r); h.mu.Unlock() })
	r, w := io.Pipe()
	go func() {
		sc := bufio.NewScanner(r)
		for sc.Scan() {
			var m map[string]any
			_ = json.Unmarshal(sc.Bytes(), &m)
			h.lines <- m
		}
		close(h.eof)
	}()
	h.s.attach(w, "prompt")
	if m := h.read(); m["message"].(map[string]any)["content"] != "prompt" {
		t.Fatalf("tin đầu = %v", m)
	}
	return h
}

// read lấy tin kế tiếp runner ghi vào stdin.
func (h *steerHarness) read() map[string]any {
	h.t.Helper()
	select {
	case m := <-h.lines:
		return m
	case <-time.After(15 * time.Second):
		h.t.Fatal("không có tin trên stdin")
		return nil
	}
}

func (h *steerHarness) stdout(line string) {
	h.t.Helper()
	if _, err := h.s.Write([]byte(line + "\n")); err != nil {
		h.t.Fatal(err)
	}
}

func (h *steerHarness) replay(m map[string]any) {
	h.t.Helper()
	b, _ := json.Marshal(map[string]any{"type": "user", "uuid": m["uuid"], "isReplay": true, "message": m["message"]})
	h.stdout(string(b))
}

func (h *steerHarness) closed() bool {
	select {
	case <-h.eof:
		return true
	case <-time.After(200 * time.Millisecond):
		return false
	}
}

func (h *steerHarness) waitClosed() {
	h.t.Helper()
	select {
	case <-h.eof:
	case <-time.After(15 * time.Second):
		h.t.Fatal("stdin không được đóng")
	}
}

func (h *steerHarness) got() []SteerResult {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]SteerResult(nil), h.results...)
}

const okResult = `{"type":"result","subtype":"success","is_error":false}`

func TestSteeringClosesStdinOnlyAfterLastTurn(t *testing.T) {
	h := newSteerHarness(t)
	h.s.send(Steer{ID: "1", Input: "a"})
	first := h.read()
	// Lượt xong trước khi CLI đọc tới chỉ dẫn: giữ stdin mở cho lượt mới.
	h.stdout(okResult)
	if h.closed() {
		t.Fatal("đóng stdin khi còn chỉ dẫn chưa được nhận")
	}
	h.replay(first)
	if got := h.got(); len(got) != 1 || got[0] != (SteerResult{SteerID: "1", Applied: true}) {
		t.Fatalf("kết quả = %+v", got)
	}
	h.stdout(okResult)
	h.waitClosed()
	// Sau lượt cuối, chỉ dẫn mới không vào được nữa.
	h.s.send(Steer{ID: "2", Input: "b"})
	h.s.finish()
	h.s.send(Steer{ID: "3", Input: "c"})
	got := h.got()
	if len(got) != 3 || got[1].SteerID != "2" || got[1].Applied || got[2].SteerID != "3" || got[2].Applied || got[2].Reason == "" {
		t.Fatalf("kết quả = %+v", got)
	}
}

func TestSteeringErrorTurnDropsPending(t *testing.T) {
	h := newSteerHarness(t)
	h.s.send(Steer{ID: "1", Input: "a"})
	h.read()
	h.stdout(`{"type":"result","subtype":"error_max_budget_usd","is_error":true}`)
	h.waitClosed()
	if got := h.got(); len(got) != 1 || got[0].SteerID != "1" || got[0].Applied {
		t.Fatalf("kết quả = %+v", got)
	}
}

func TestSteeringGivesUpWhenReplayNeverComes(t *testing.T) {
	old := replayWait
	replayWait = 50 * time.Millisecond
	t.Cleanup(func() { replayWait = old })
	h := newSteerHarness(t)
	h.s.send(Steer{ID: "1", Input: "a"})
	h.read()
	h.stdout(okResult)
	h.waitClosed()
	if got := h.got(); len(got) != 1 || got[0].SteerID != "1" || got[0].Applied {
		t.Fatalf("kết quả = %+v", got)
	}
}

func TestSteeringReportsPendingWhenCLIExits(t *testing.T) {
	h := newSteerHarness(t)
	h.s.send(Steer{ID: "1", Input: "a"})
	h.read()
	h.s.finish()
	h.waitClosed()
	if got := h.got(); len(got) != 1 || got[0].SteerID != "1" || got[0].Applied {
		t.Fatalf("kết quả = %+v", got)
	}
}

func TestSteeringListenStopsOnShutdown(t *testing.T) {
	var mu sync.Mutex
	var got []SteerResult
	s := newSteering("gemini", func(r SteerResult) { mu.Lock(); got = append(got, r); mu.Unlock() })
	in := make(chan Steer, 1)
	in <- Steer{ID: "1", Input: "a"}
	s.listen(in)
	deadline := time.Now().Add(15 * time.Second)
	for {
		mu.Lock()
		n := len(got)
		mu.Unlock()
		if n == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("không báo kết quả")
		}
		time.Sleep(10 * time.Millisecond)
	}
	s.finish()
	s.shutdown()
	if got[0].Applied || !strings.Contains(got[0].Reason, "gemini") {
		t.Fatalf("kết quả = %+v", got)
	}
}
