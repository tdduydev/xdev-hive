package channel

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/runner"
)

func quietLogger() *slog.Logger { return slog.New(slog.DiscardHandler) }

func testJobs(t *testing.T, capacity int) *jobs {
	t.Helper()
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "pending"), 0700); err != nil {
		t.Fatal(err)
	}
	return newJobs(context.Background(), Config{DataDir: dir, CLIs: []string{"codex"}, Capacity: capacity, Logger: quietLogger()})
}

func TestDurableSinkPersistsAndAckRemovesInSequence(t *testing.T) {
	j := testJobs(t, 1)
	var sent []any
	j.conn = nil
	run := &activeRun{runID: "run-1", attempt: 2, leaseID: "lease-1", cancel: func() {}}
	sink, err := j.newSink(run)
	if err != nil {
		t.Fatal(err)
	}
	sink.send = func(v any) error { sent = append(sent, v); return nil }
	for _, e := range []runner.Event{
		{Type: "phase", RunID: "run-1", Attempt: 2, Phase: "running"},
		{Type: "log", RunID: "run-1", Attempt: 2, Offset: 0, Data: []byte("hello")},
		{Type: "result", RunID: "run-1", Attempt: 2, Result: &runner.Result{Status: "succeeded", HeadSHA: strings.Repeat("a", 40)}},
	} {
		if err := sink.Emit(e); err != nil {
			t.Fatal(err)
		}
	}
	for i, want := range []string{"run_event", "log_chunk", "run_result"} {
		var env struct {
			Type string `json:"type"`
			Seq  int64  `json:"seq"`
		}
		if err := json.Unmarshal(mustJSON(sent[i]), &env); err != nil {
			t.Fatal(err)
		}
		if env.Type != want || env.Seq != int64(i+1) {
			t.Fatalf("gói %d = %s seq %d", i, env.Type, env.Seq)
		}
	}
	if !sink.hasResult() {
		t.Fatal("sink không ghi nhận đã gửi kết quả")
	}
	var m runMarker
	b, _ := os.ReadFile(markerPath(j.markers, "run-1"))
	if err := json.Unmarshal(b, &m); err != nil || m.Seq != 3 || m.LeaseID != "lease-1" {
		t.Fatalf("marker = %+v, %v", m, err)
	}
	ackPending(j.pending, "run-1", 2)
	if got := pendingMessages(j.pending); len(got) != 1 {
		t.Fatalf("còn %d gói sau ack 2", len(got))
	}
	// Ack của run khác không đụng gói của run này, kể cả khi id là tiền tố của nhau.
	ackPending(j.pending, "run", 99)
	if runs := queuedRunIDs(j.pending); len(runs) != 1 || runs[0] != "run-1" {
		t.Fatalf("run còn gói = %v", runs)
	}
	ackPending(j.pending, "run-1", 3)
	if got := queuedRunIDs(j.pending); len(got) != 0 {
		t.Fatalf("run còn gói sau ack hết = %v", got)
	}
}

func TestSinkKeepsMessagesWhenOffline(t *testing.T) {
	j := testJobs(t, 1)
	sink, err := j.newSink(&activeRun{runID: "run", attempt: 1, cancel: func() {}})
	if err != nil {
		t.Fatal(err)
	}
	// Chưa có kết nối: run không được hỏng, gói nằm trên đĩa chờ gửi lại.
	if err := sink.Emit(runner.Event{Type: "phase", RunID: "run", Attempt: 1, Phase: "prepare"}); err != nil {
		t.Fatalf("Emit khi mất kết nối trả lỗi %v", err)
	}
	files, err := filepath.Glob(filepath.Join(j.pending, "*.json"))
	if err != nil || len(files) != 1 {
		t.Fatalf("file trong hàng đợi %v %v", files, err)
	}
	// Windows không dùng bit quyền POSIX; thư mục dữ liệu nằm trong hồ sơ người dùng, quyền theo ACL của nó.
	if runtime.GOOS == "windows" {
		return
	}
	info, err := os.Stat(files[0])
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("quyền file = %o", info.Mode().Perm())
	}
}

func TestDecodeJobPassesLeaseEnvironment(t *testing.T) {
	offer := &JobOffer{RunID: "r", Attempt: 1, Spec: json.RawMessage(`{"repo":"org/repo","cli":"codex","prompt":"do it","projectKey":"web","runPermissions":"full"}`)}
	job, err := decodeJob(offer, Lease{RunToken: "run-secret"}, "https://hub.example", "mac-dinh")
	if err != nil {
		t.Fatal(err)
	}
	if job.RunPermissions != "full" || job.RepoURL != "https://github.com/org/repo.git" || job.Branch != "ai/r" || job.BaseBranch != "main" {
		t.Fatalf("job = %+v", job)
	}
	for k, want := range map[string]string{"HIVE_RUN_TOKEN": "run-secret", "HIVE_MCP_TOKEN": "run-secret", "HIVE_HUB_URL": "https://hub.example", "HIVE_PROJECT": "web"} {
		if job.Env[k] != want {
			t.Fatalf("%s = %q, cần %q", k, job.Env[k], want)
		}
	}
}

func TestDecodeJobKeepsReviewKind(t *testing.T) {
	offer := &JobOffer{RunID: "r", Attempt: 1, Spec: json.RawMessage(`{"kind":"review","repoUrl":"https://git.example/a.git","cli":"claude","branch":"ai/HD-1"}`)}
	job, err := decodeJob(offer, Lease{RunToken: "t"}, "https://hub.example", "p")
	if err != nil {
		t.Fatal(err)
	}
	if job.Kind != runner.KindReview || job.Branch != "ai/HD-1" {
		t.Fatalf("job = %+v", job)
	}
}

func TestOfferExpiresAndCancelFreesSlot(t *testing.T) {
	j := testJobs(t, 1)
	now := time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC)
	j.now = func() time.Time { return now }
	offer := func(id string) *JobOffer {
		return &JobOffer{RunID: id, Attempt: 1, TTL: 30, Spec: json.RawMessage(`{"cli":"codex"}`)}
	}
	j.onOffer(offer("a"))
	if len(j.offers) != 1 {
		t.Fatal("chưa giữ đề nghị a")
	}
	// Máy đầy vì a đang chờ lease.
	j.onOffer(offer("b"))
	if _, ok := j.offers["b"]; ok {
		t.Fatal("nhận b khi máy đã đầy")
	}
	// Lease không tới: hết hạn thì nhả chỗ.
	now = now.Add(minOfferWait + time.Second)
	j.expireOffers()
	if len(j.offers) != 0 {
		t.Fatalf("đề nghị chưa hết hạn: %v", j.offers)
	}
	// Hub nhận job_accept muộn thì gửi cancel: cũng nhả chỗ.
	j.onOffer(offer("c"))
	j.cancel("c", 0)
	if len(j.offers) != 0 {
		t.Fatal("cancel không bỏ đề nghị đang chờ lease")
	}
	// Lease của đề nghị đã bỏ thì không chạy.
	j.onLease(&Lease{RunID: "c", Attempt: 1, LeaseID: "l"})
	if len(j.active) != 0 {
		t.Fatal("chạy run của đề nghị đã bị huỷ")
	}
}

func TestRecoverInterruptedRun(t *testing.T) {
	dir := t.TempDir()
	pending := filepath.Join(dir, "pending")
	active := filepath.Join(dir, "active")
	for _, d := range []string{pending, active} {
		if err := os.MkdirAll(d, 0700); err != nil {
			t.Fatal(err)
		}
	}
	// run-9 đang chạy khi worker chết: seq 7 đã ghi, chưa có kết quả.
	if err := writeMarker(markerPath(active, "run-9"), runMarker{RunID: "run-9", Attempt: 2, LeaseID: "l9", Seq: 7}); err != nil {
		t.Fatal(err)
	}
	// run-8 đã có kết quả trong hàng đợi, chỉ chưa kịp xoá marker.
	if err := writeMarker(markerPath(active, "run-8"), runMarker{RunID: "run-8", Attempt: 1, Seq: 4}); err != nil {
		t.Fatal(err)
	}
	if err := writePending(pending, "run-8", 1, 4, resultMessage("run-8", 1, 4, &runner.Result{Status: "succeeded"})); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(markerPath(active, "hong"), []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := recoverInterrupted(dir, quietLogger()); err != nil {
		t.Fatal(err)
	}
	items := readPending(pending)
	if len(items) != 2 {
		t.Fatalf("hàng đợi có %d gói", len(items))
	}
	var r RunResult
	for _, it := range items {
		if it.head.RunID == "run-9" {
			if err := json.Unmarshal(it.raw, &r); err != nil {
				t.Fatal(err)
			}
		}
	}
	var report runner.Result
	_ = json.Unmarshal(r.Report, &report)
	if r.Type != "run_result" || r.Attempt != 2 || r.Seq != 8 || r.Exit != 1 || report.Status != "failed" || !strings.Contains(report.Error, "khởi động lại") {
		t.Fatalf("kết quả run-9 = %+v report %+v", r, report)
	}
	if left, _ := filepath.Glob(filepath.Join(active, "*")); len(left) != 0 {
		t.Fatalf("marker còn lại: %v", left)
	}
}

func TestDecodeJobBudget(t *testing.T) {
	offer := &JobOffer{RunID: "r", Attempt: 1, Spec: json.RawMessage(`{"repo":"org/repo","cli":"claude","budget":{"maxCostUsd":1.5,"maxTurns":40}}`)}
	job, err := decodeJob(offer, Lease{}, "https://hub.example", "")
	if err != nil {
		t.Fatal(err)
	}
	b := job.Budget
	if b.MaxCostUSD == nil || *b.MaxCostUSD != 1.5 || b.MaxTurns == nil || *b.MaxTurns != 40 || b.MaxTokens != nil {
		t.Fatalf("budget = %+v", b)
	}
}

func TestCostEventCarriesUsage(t *testing.T) {
	j := testJobs(t, 1)
	run := &activeRun{runID: "run-c", attempt: 1, leaseID: "lease-c", cancel: func() {}}
	sink, err := j.newSink(run)
	if err != nil {
		t.Fatal(err)
	}
	var sent []any
	sink.send = func(v any) error { sent = append(sent, v); return nil }
	cost := 0.25
	if err := sink.Emit(runner.Event{Type: "cost", RunID: "run-c", Attempt: 1, Cost: &runner.Usage{InputTokens: 10, OutputTokens: 5, CostUSD: &cost}}); err != nil {
		t.Fatal(err)
	}
	var got struct {
		Type  string         `json:"type"`
		Event string         `json:"event"`
		Data  map[string]any `json:"data"`
	}
	if err := json.Unmarshal(mustJSON(sent[0]), &got); err != nil {
		t.Fatal(err)
	}
	if got.Type != "run_event" || got.Event != "cost" || got.Data["inputTokens"] != float64(10) || got.Data["costUsd"] != 0.25 {
		t.Fatalf("gói = %+v", got)
	}
	// Trường CLI không báo vẫn có mặt với giá trị null để hub phân biệt "không biết" với 0.
	if v, ok := got.Data["turns"]; !ok || v != nil {
		t.Fatalf("turns = %v, %v", v, ok)
	}
}
