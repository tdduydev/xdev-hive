package channel

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/accounts"
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

func TestDecodeJobPassesExternalMCPServers(t *testing.T) {
	offer := &JobOffer{RunID: "r", Attempt: 1, Spec: json.RawMessage(`{"repoUrl":"https://git.example/a.git","cli":"claude","mcpServers":[{"name":"github","transport":"stdio","command":"npx","args":["-y","@modelcontextprotocol/server-github"]},{"name":"context7","transport":"http","url":"https://mcp.context7.com/mcp"}]}`)}
	job, err := decodeJob(offer, Lease{RunToken: "t"}, "https://hub.example", "p")
	if err != nil {
		t.Fatal(err)
	}
	want := []runner.MCPServer{
		{Name: "github", Transport: "stdio", Command: "npx", Args: []string{"-y", "@modelcontextprotocol/server-github"}},
		{Name: "context7", Transport: "http", URL: "https://mcp.context7.com/mcp"},
	}
	if !reflect.DeepEqual(job.MCPServers, want) {
		t.Fatalf("MCPServers = %+v", job.MCPServers)
	}
	// Hub cũ không gửi mcpServers: không có server ngoài nào.
	offer.Spec = json.RawMessage(`{"repoUrl":"https://git.example/a.git","cli":"claude"}`)
	if job, err = decodeJob(offer, Lease{RunToken: "t"}, "https://hub.example", "p"); err != nil || job.MCPServers != nil {
		t.Fatalf("job = %+v, err = %v", job.MCPServers, err)
	}
}

// Chính sách agent của tổ chức đi kèm spec; hub cũ không gửi thì job không có hook.
func TestDecodeJobReadsOrganizationPolicy(t *testing.T) {
	offer := &JobOffer{RunID: "r", Attempt: 1, Spec: json.RawMessage(`{"repo":"org/repo","cli":"claude","prompt":"p","policy":{"hooks":[{"event":"Stop","name":"test","command":"pnpm test"},{"event":"PreToolUse","name":"g","command":"guard","matcher":"Bash"}],"managedHooksOnly":true}}`)}
	job, err := decodeJob(offer, Lease{}, "https://hub.example", "p")
	if err != nil {
		t.Fatal(err)
	}
	if !job.Policy.ManagedHooksOnly || len(job.Policy.Hooks) != 2 || job.Policy.Hooks[1].Matcher != "Bash" || job.Policy.Hooks[0].Command != "pnpm test" {
		t.Fatalf("policy = %+v", job.Policy)
	}
	old, err := decodeJob(&JobOffer{RunID: "r", Attempt: 1, Spec: json.RawMessage(`{"repo":"org/repo","cli":"claude","prompt":"p"}`)}, Lease{}, "", "p")
	if err != nil {
		t.Fatal(err)
	}
	if old.Policy.ManagedHooksOnly || len(old.Policy.Hooks) != 0 {
		t.Fatalf("policy = %+v", old.Policy)
	}
}

func TestDecodeJobKeepsReviewAndPlanKind(t *testing.T) {
	for _, kind := range []string{runner.KindReview, runner.KindPlan} {
		offer := &JobOffer{RunID: "r", Attempt: 1, Spec: json.RawMessage(`{"kind":"` + kind + `","repoUrl":"https://git.example/a.git","cli":"claude","branch":"ai/HD-1"}`)}
		job, err := decodeJob(offer, Lease{RunToken: "t"}, "https://hub.example", "p")
		if err != nil {
			t.Fatal(err)
		}
		if job.Kind != kind || job.Branch != "ai/HD-1" {
			t.Fatalf("job = %+v", job)
		}
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

// codexAccounts là accounts.json có một tài khoản Codex đã đăng nhập (thư mục cấu hình có auth.json).
func codexAccounts(t *testing.T) []byte {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "auth.json"), []byte(`{"tokens":{"id_token":"h.e30.s"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	quoted, _ := json.Marshal(dir)
	return []byte(`{"accounts":[{"id":"codex-3","cli":"codex","configDir":` + string(quoted) + `,"enabled":true,"maxConcurrent":1}]}`)
}

// Máy có hai chỗ nhưng chỉ một tài khoản Codex cho một run: đề nghị thứ hai vẫn được nhận (hub không bỏ máy) nhưng
// chờ tài khoản; bỏ đề nghị (huỷ, hết hạn) thì trả tài khoản.
func TestOfferHoldsAccountAndReleasesIt(t *testing.T) {
	j := testJobs(t, 2)
	path := filepath.Join(t.TempDir(), "accounts.json")
	if err := os.WriteFile(path, codexAccounts(t), 0o600); err != nil {
		t.Fatal(err)
	}
	j.cfg.Accounts = accounts.NewPool(path)
	offer := func(id string) *JobOffer {
		return &JobOffer{RunID: id, Attempt: 1, TTL: 30, Spec: json.RawMessage(`{"cli":"codex"}`)}
	}
	j.onOffer(offer("a"))
	if j.offers["a"].account.Label() != "codex-3" || j.offers["a"].waitAccount {
		t.Fatal("đề nghị a phải giữ tài khoản codex-3")
	}
	j.onOffer(offer("b"))
	if b, ok := j.offers["b"]; !ok || b.account != nil || !b.waitAccount {
		t.Fatalf("b phải được nhận và chờ tài khoản: %+v", b)
	}
	j.cancel("a", 0)
	j.onOffer(offer("c"))
	if j.offers["c"].account.Label() != "codex-3" {
		t.Fatal("huỷ a phải trả tài khoản cho đề nghị sau")
	}
}

func TestWaitAccountUntilFreeOrCancelled(t *testing.T) {
	j := testJobs(t, 2)
	path := filepath.Join(t.TempDir(), "accounts.json")
	if err := os.WriteFile(path, codexAccounts(t), 0o600); err != nil {
		t.Fatal(err)
	}
	j.cfg.Accounts = accounts.NewPool(path)
	saved := accountPoll
	accountPoll = 10 * time.Millisecond
	defer func() { accountPoll = saved }()
	held, _ := j.cfg.Accounts.Acquire("codex", accounts.RoleImplement)
	go func() {
		time.Sleep(50 * time.Millisecond)
		held.Release()
	}()
	got, err := j.waitAccount(context.Background(), "codex", accounts.RoleImplement, "r")
	if err != nil || got.Label() != "codex-3" {
		t.Fatalf("chờ xong phải nhận codex-3: %v %v", got, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := j.waitAccount(ctx, "codex", accounts.RoleImplement, "r"); err == nil {
		t.Fatal("huỷ khi đang chờ phải trả lỗi")
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

// Chỉ dẫn chỉ tới run đang chạy đúng lần thử; run không có trên máy (đã xong, chưa nhận lease) thì bỏ và ghi log.
func TestSteerReachesOnlyMatchingRun(t *testing.T) {
	var logs strings.Builder
	j := testJobs(t, 1)
	j.log = slog.New(slog.NewTextHandler(&logs, nil))
	run := &activeRun{runID: "run-1", attempt: 2, cancel: func() {}, steers: make(chan runner.Steer, steerBuffer)}
	j.active["run-1"] = run

	j.steer(&Steer{RunID: "run-x", SteerID: "1", Input: "a"})
	j.steer(&Steer{RunID: "run-1", Attempt: 1, SteerID: "2", Input: "b"})
	j.steer(&Steer{RunID: "run-1", Attempt: 2, SteerID: "3", Input: "c"})
	// Hub cũ không gửi attempt.
	j.steer(&Steer{RunID: "run-1", Input: "d"})
	close(run.steers)
	var got []runner.Steer
	for s := range run.steers {
		got = append(got, s)
	}
	if len(got) != 2 || got[0] != (runner.Steer{ID: "3", Input: "c"}) || got[1] != (runner.Steer{Input: "d"}) {
		t.Fatalf("run nhận %+v", got)
	}
	for _, want := range []string{"Bỏ chỉ dẫn cho run không chạy trên máy", "run=run-x", "Bỏ chỉ dẫn của lần thử khác"} {
		if !strings.Contains(logs.String(), want) {
			t.Fatalf("log thiếu %q:\n%s", want, logs.String())
		}
	}
}

func TestSteerResultEventCarriesOutcome(t *testing.T) {
	j := testJobs(t, 1)
	sink, err := j.newSink(&activeRun{runID: "run-1", attempt: 1, cancel: func() {}})
	if err != nil {
		t.Fatal(err)
	}
	var sent []any
	sink.send = func(v any) error { sent = append(sent, v); return nil }
	if err := sink.Emit(runner.Event{Type: "steer_result", RunID: "run-1", Attempt: 1, Steer: &runner.SteerResult{SteerID: "42", Reason: "CLI codex chưa nhận chỉ dẫn giữa chừng"}}); err != nil {
		t.Fatal(err)
	}
	ev, ok := sent[0].(RunEvent)
	if !ok || ev.Event != "steer_result" || string(ev.Data) != `{"steerId":"42","applied":false,"reason":"CLI codex chưa nhận chỉ dẫn giữa chừng"}` {
		t.Fatalf("gói = %#v (%s)", sent[0], ev.Data)
	}
}

func TestSandboxJobSnapshotDecodeAndModeGuard(t *testing.T) {
	policy := `{"execution":"sandbox","sandbox":{"allowlist":["api.openai.com:443"],"image":{"baseImage":"node:24","setupScriptHash":"` + strings.Repeat("a", 64) + `"}},"cli":"codex"}`
	offer := &JobOffer{RunID: "sandbox-run", Attempt: 1, Spec: json.RawMessage(policy)}
	job, err := decodeJob(offer, Lease{}, "http://hub.test", "project")
	if err != nil {
		t.Fatal(err)
	}
	if job.Execution != "sandbox" || job.EnvironmentImage != "node:24" || job.SandboxPolicy == nil || len(job.SandboxPolicy.Allowlist) != 1 {
		t.Fatalf("snapshot chưa tới runner: %+v", job)
	}
	dev := testJobs(t, 1)
	dev.onOffer(offer)
	if len(dev.offers) != 0 {
		t.Fatal("worker máy dev không được nhận sandbox")
	}
	host := testJobs(t, 1)
	host.cfg.Sandbox = &runner.SandboxConfig{}
	host.onOffer(offer)
	if len(host.offers) != 1 {
		t.Fatal("host phải nhận sandbox có snapshot")
	}
	host.onOffer(&JobOffer{RunID: "ordinary", Attempt: 1, Spec: json.RawMessage(`{"execution":"worker","cli":"codex"}`)})
	if _, ok := host.offers["ordinary"]; ok {
		t.Fatal("host không được nhận job máy dev")
	}
}

func TestSandboxJobRejectsMissingOrInvalidPolicy(t *testing.T) {
	for _, spec := range []string{
		`{"execution":"sandbox","cli":"codex"}`,
		`{"execution":"other","cli":"codex"}`,
		`{"execution":"sandbox","sandbox":{"allowlist":["a.com\n127.0.0.1"],"image":{"baseImage":"node:24","setupScriptHash":"` + strings.Repeat("a", 64) + `"}},"cli":"codex"}`,
	} {
		if _, err := decodeJob(&JobOffer{Spec: json.RawMessage(spec)}, Lease{}, "", ""); err == nil {
			t.Fatalf("phải từ chối %s", spec)
		}
		j := testJobs(t, 1)
		j.cfg.Sandbox = &runner.SandboxConfig{}
		j.onOffer(&JobOffer{RunID: "run", Spec: json.RawMessage(spec)})
		if len(j.offers) != 0 {
			t.Fatal("không nhận job có snapshot sai")
		}
	}
}

// stdout và stderr có offset riêng trong runner; hub bỏ chunk trùng offset của cùng lần thử, nên sink phải đánh offset
// chung theo tổng byte đã gửi.
func TestLogChunksShareOneOffsetAcrossStreams(t *testing.T) {
	j := testJobs(t, 1)
	sink, err := j.newSink(&activeRun{runID: "run-1", attempt: 1, cancel: func() {}})
	if err != nil {
		t.Fatal(err)
	}
	var sent []any
	sink.send = func(v any) error { sent = append(sent, v); return nil }
	for _, e := range []runner.Event{
		{Type: "log", RunID: "run-1", Attempt: 1, Stream: "stdout", Offset: 0, Data: []byte("abc")},
		{Type: "log", RunID: "run-1", Attempt: 1, Stream: "stderr", Offset: 0, Data: []byte("lỗi\n")},
		{Type: "log", RunID: "run-1", Attempt: 1, Stream: "stdout", Offset: 3, Data: []byte("de")},
	} {
		if err := sink.Emit(e); err != nil {
			t.Fatal(err)
		}
	}
	var offsets []int64
	for _, v := range sent {
		chunk, ok := v.(LogChunk)
		if !ok {
			t.Fatalf("gói %T", v)
		}
		offsets = append(offsets, chunk.Offset)
	}
	if len(offsets) != 3 || offsets[0] != 0 || offsets[1] != 3 || offsets[2] != 3+int64(len("lỗi\n")) {
		t.Fatalf("offset = %v", offsets)
	}
}
