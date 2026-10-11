package channel

// Test đầu-cuối của kênh: hub giả bằng httptest + coder/websocket, CLI giả là chính binary test chạy lại với
// -test.run=^TestHelperCLI$, repo là bare repo git cục bộ.

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/tdduydev/xdev-hive/worker/internal/runner"
)

const waitFor = 20 * time.Second

// ---- CLI giả ---------------------------------------------------------------------------------------------------

func helperMode() string {
	for i, a := range os.Args {
		if a == "hive-helper" && i+1 < len(os.Args) {
			return os.Args[i+1]
		}
	}
	return ""
}

// TestHelperCLI không phải test: là CLI giả khi binary test được gọi lại với "hive-helper <chế độ>".
func TestHelperCLI(t *testing.T) {
	mode := helperMode()
	if mode == "" {
		return
	}
	fmt.Printf("token=%s mcp=%s project=%s\n", os.Getenv("HIVE_RUN_TOKEN"), os.Getenv("HIVE_MCP_TOKEN"), os.Getenv("HIVE_PROJECT"))
	switch mode {
	case "hang":
		// Bỏ qua tín hiệu dừng nhẹ: chỉ bị dừng khi worker hết grace và giết hẳn.
		signal.Ignore(os.Interrupt)
		time.Sleep(time.Minute)
	case "sleep":
		time.Sleep(time.Minute)
	case "slow":
		for i := range 10 {
			fmt.Println("dòng", i)
			time.Sleep(100 * time.Millisecond)
		}
		helperCommit()
	case "commit":
		helperCommit()
	case "stream":
		helperStream()
	}
	os.Exit(0)
}

// helperStream làm như `claude -p --input-format stream-json --replay-user-messages`: phát lại prompt và một chỉ dẫn,
// in result, rồi chỉ thoát khi worker đóng stdin. stdin đóng trước lượt cuối thì thoát mã 5.
func helperStream() {
	sc := bufio.NewScanner(os.Stdin)
	for range 2 {
		var m struct {
			UUID string `json:"uuid"`
		}
		done := make(chan bool, 1)
		go func() { done <- sc.Scan() }()
		select {
		case ok := <-done:
			if !ok || json.Unmarshal(sc.Bytes(), &m) != nil {
				os.Exit(5)
			}
		case <-time.After(waitFor):
			os.Exit(6)
		}
		fmt.Printf(`{"type":"user","uuid":%q,"isReplay":true}`+"\n", m.UUID)
	}
	fmt.Println(`{"type":"result","subtype":"success","is_error":false}`)
	for sc.Scan() {
	}
}

func helperCommit() {
	_ = os.WriteFile("change.txt", []byte("change"), 0600)
	if exec.Command("git", "add", "change.txt").Run() != nil {
		os.Exit(2)
	}
	c := exec.Command("git", "-c", "user.name=Worker Test", "-c", "user.email=worker@example.invalid", "commit", "-m", "test")
	if c.Run() != nil {
		os.Exit(3)
	}
}

func helperCommands(mode string) map[string]runner.Command {
	return map[string]runner.Command{"codex": {Path: os.Args[0], Args: []string{"-test.run=^TestHelperCLI$", "--", "hive-helper", mode}}}
}

// ---- Repo ------------------------------------------------------------------------------------------------------

func makeRemote(t *testing.T) (string, string) {
	t.Helper()
	root := t.TempDir()
	remote := filepath.Join(root, "remote.git")
	work := filepath.Join(root, "source")
	run := func(args ...string) string {
		t.Helper()
		out, err := exec.Command(args[0], args[1:]...).CombinedOutput()
		if err != nil {
			t.Fatalf("%v: %s: %v", args, out, err)
		}
		return string(out)
	}
	run("git", "init", "--bare", remote)
	run("git", "init", work)
	if err := os.WriteFile(filepath.Join(work, "README"), []byte("init"), 0600); err != nil {
		t.Fatal(err)
	}
	run("git", "-C", work, "add", ".")
	run("git", "-C", work, "-c", "user.name=Worker Test", "-c", "user.email=worker@example.invalid", "commit", "-m", "base")
	base := strings.TrimSpace(run("git", "-C", work, "branch", "--show-current"))
	run("git", "-C", work, "remote", "add", "origin", remote)
	run("git", "-C", work, "push", "-u", "origin", base)
	return remote, base
}

func fileURL(path string) string {
	return (&url.URL{Scheme: "file", Path: filepath.ToSlash(path)}).String()
}

// ---- Hub giả ---------------------------------------------------------------------------------------------------

type wmsg struct {
	Type      string            `json:"type"`
	RunID     string            `json:"runId"`
	Attempt   int               `json:"attempt"`
	Seq       int64             `json:"seq"`
	Event     string            `json:"event"`
	Data      json.RawMessage   `json:"data"`
	Bytes     []byte            `json:"bytes"`
	Exit      int               `json:"exit"`
	HeadSHA   *string           `json:"headSha"`
	Report    json.RawMessage   `json:"report"`
	DiffStats *runner.DiffStats `json:"diffStats"`
	Reason    string            `json:"reason"`
}

func (m wmsg) phase() string {
	var d struct {
		Phase string `json:"phase"`
	}
	_ = json.Unmarshal(m.Data, &d)
	return d.Phase
}

func (m wmsg) report() runner.Result {
	var r runner.Result
	_ = json.Unmarshal(m.Report, &r)
	return r
}

type hubConn struct {
	conn  *websocket.Conn
	hello Hello
	in    chan wmsg
}

type fakeHub struct {
	srv     *httptest.Server
	conns   chan *hubConn
	autoAck bool
}

func newFakeHub(t *testing.T, autoAck bool) *fakeHub {
	t.Helper()
	h := &fakeHub{conns: make(chan *hubConn, 8), autoAck: autoAck}
	h.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		ctx := r.Context()
		_, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		hc := &hubConn{conn: conn, in: make(chan wmsg, 4096)}
		_ = json.Unmarshal(data, &hc.hello)
		_ = conn.Write(ctx, websocket.MessageText, []byte(`{"type":"welcome","v":1,"id":"w","sessionId":"s","heartbeatSec":30}`))
		h.conns <- hc
		defer close(hc.in)
		for {
			_, data, err := conn.Read(ctx)
			if err != nil {
				return
			}
			var m wmsg
			if json.Unmarshal(data, &m) != nil {
				continue
			}
			if h.autoAck && m.Seq > 0 {
				_ = conn.Write(ctx, websocket.MessageText, fmt.Appendf(nil, `{"type":"ack","v":1,"id":"a","runId":%q,"uptoSeq":%d}`, m.RunID, m.Seq))
			}
			hc.in <- m
		}
	}))
	t.Cleanup(h.srv.Close)
	return h
}

func (h *fakeHub) accept(t *testing.T) *hubConn {
	t.Helper()
	select {
	case c := <-h.conns:
		return c
	case <-time.After(waitFor):
		t.Fatal("worker không nối tới hub")
		return nil
	}
}

func (c *hubConn) send(t *testing.T, format string, args ...any) {
	t.Helper()
	if err := c.conn.Write(context.Background(), websocket.MessageText, fmt.Appendf(nil, format, args...)); err != nil {
		t.Fatal(err)
	}
}

func (c *hubConn) offer(t *testing.T, runID string, spec map[string]any) {
	t.Helper()
	b, _ := json.Marshal(spec)
	c.send(t, `{"type":"job_offer","v":1,"id":"o","runId":%q,"attempt":1,"spec":%s,"ttl":30}`, runID, b)
}

func (c *hubConn) lease(t *testing.T, runID, token string) {
	t.Helper()
	c.send(t, `{"type":"lease","v":1,"id":"l","runId":%q,"attempt":1,"leaseId":"lease-%s","expiresAt":"2026-10-11T00:00:00Z","runToken":%q}`, runID, runID, token)
}

func (c *hubConn) ack(t *testing.T, runID string, seq int64) {
	t.Helper()
	c.send(t, `{"type":"ack","v":1,"id":"a","runId":%q,"uptoSeq":%d}`, runID, seq)
}

// next đợi gói kế tiếp thoả match, bỏ qua heartbeat.
func (c *hubConn) next(t *testing.T, what string, match func(wmsg) bool) wmsg {
	t.Helper()
	timeout := time.After(waitFor)
	for {
		select {
		case m, ok := <-c.in:
			if !ok {
				t.Fatalf("kết nối đóng trước khi nhận %s", what)
			}
			if m.Type != "heartbeat" && match(m) {
				return m
			}
		case <-timeout:
			t.Fatalf("không nhận %s", what)
		}
	}
}

func (c *hubConn) nextType(t *testing.T, typ string) wmsg {
	t.Helper()
	return c.next(t, typ, func(m wmsg) bool { return m.Type == typ })
}

// untilResult gom mọi gói của run tới run_result.
func (c *hubConn) untilResult(t *testing.T, runID string) []wmsg {
	t.Helper()
	var out []wmsg
	for {
		m := c.next(t, "run_result của "+runID, func(m wmsg) bool { return m.RunID == runID })
		out = append(out, m)
		if m.Type == "run_result" {
			return out
		}
	}
}

func jobSpecFor(remote, base, branch string) map[string]any {
	return map[string]any{"cli": "codex", "prompt": "sửa README", "repoUrl": fileURL(remote), "baseBranch": base, "branch": branch, "timeoutSec": 60, "projectKey": "web"}
}

func workerConfig(t *testing.T, hub *fakeHub, mode string) Config {
	t.Helper()
	return Config{HubURL: hub.srv.URL, Machine: "machine-1", Version: "1.2.3", CLIs: []string{"codex"}, Capacity: 2, MinBackoff: time.Millisecond, MaxBackoff: 4 * time.Millisecond, DataDir: t.TempDir(), CLICommands: helperCommands(mode), Logger: quietLogger(), StopTimeout: waitFor}
}

// startWorker chạy worker tới khi test xong; trả kênh nhận lỗi khi Run tự thoát.
func startWorker(t *testing.T, cfg Config) <-chan error {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	errc := make(chan error, 1)
	stopped := make(chan struct{})
	go func() { errc <- cfg.Run(ctx); close(stopped) }()
	t.Cleanup(func() {
		cancel()
		select {
		case <-stopped:
		case <-time.After(waitFor):
			t.Error("worker không dừng")
		}
	})
	return errc
}

func eventually(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(waitFor)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("hết giờ chờ: %s", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func noFiles(pattern string) func() bool {
	return func() bool { m, _ := filepath.Glob(pattern); return len(m) == 0 }
}

// ---- Test ------------------------------------------------------------------------------------------------------

func TestJobOfferToResult(t *testing.T) {
	remote, base := makeRemote(t)
	hub := newFakeHub(t, true)
	cfg := workerConfig(t, hub, "commit")
	startWorker(t, cfg)
	c := hub.accept(t)
	c.offer(t, "run-1", jobSpecFor(remote, base, "ai/T-1"))
	if m := c.nextType(t, "job_accept"); m.RunID != "run-1" || m.Attempt != 1 {
		t.Fatalf("job_accept = %+v", m)
	}
	c.lease(t, "run-1", "tok-1")
	msgs := c.untilResult(t, "run-1")

	var phases []string
	var logs strings.Builder
	for i, m := range msgs {
		if m.Seq != int64(i+1) {
			t.Fatalf("gói %d (%s) có seq %d", i, m.Type, m.Seq)
		}
		switch m.Type {
		case "run_event":
			phases = append(phases, m.phase())
		case "log_chunk":
			logs.Write(m.Bytes)
		}
	}
	if want := []string{"prepare", "running", "verifying", "publishing", "cleanup"}; !slices.Equal(phases, want) {
		t.Fatalf("pha = %v, cần %v", phases, want)
	}
	// Hub bỏ mọi sự kiện đến sau run_result, nên cleanup phải đi ngay trước.
	if prev := msgs[len(msgs)-2]; prev.Type != "run_event" || prev.phase() != "cleanup" {
		t.Fatalf("gói trước run_result = %+v", prev)
	}
	res := msgs[len(msgs)-1]
	if res.Exit != 0 || res.HeadSHA == nil || res.report().Status != "succeeded" {
		t.Fatalf("run_result = %+v report %+v", res, res.report())
	}
	if res.DiffStats == nil || res.DiffStats.AddedLines != 1 || res.DiffStats.DeletedLines != 0 || !slices.Equal(res.DiffStats.ChangedFiles, []string{"change.txt"}) {
		t.Fatalf("diffStats = %#v", res.DiffStats)
	}
	if !strings.Contains(logs.String(), "token=tok-1 mcp=tok-1 project=web") {
		t.Fatalf("CLI không nhận biến môi trường của run; log = %q", logs.String())
	}
	out, err := exec.Command("git", "--git-dir", remote, "rev-parse", "refs/heads/ai/T-1").Output()
	if err != nil || strings.TrimSpace(string(out)) != *res.HeadSHA {
		t.Fatalf("nhánh trên remote = %q, %v; headSha %s", out, err, *res.HeadSHA)
	}
	// Hub ack hết thì hàng đợi trống; run xong thì marker và worktree được gỡ.
	eventually(t, "hàng đợi trống", noFiles(filepath.Join(cfg.DataDir, "pending", "*.json")))
	eventually(t, "marker được gỡ", noFiles(filepath.Join(cfg.DataDir, "active", "*.json")))
	eventually(t, "worktree được gỡ", noFiles(filepath.Join(cfg.DataDir, "runs", "*")))
}

// Hub gửi chỉ dẫn cho run đang chạy: tới đúng CLI qua stdin, worker báo steer_result đã áp dụng, run kết thúc bình
// thường. Chỉ dẫn cho run không có trên máy thì bị bỏ, không có gói trả lời.
func TestSteerReachesRunningCLI(t *testing.T) {
	remote, base := makeRemote(t)
	hub := newFakeHub(t, true)
	cfg := workerConfig(t, hub, "stream")
	cfg.CLICommands = map[string]runner.Command{"codex": {Path: os.Args[0], Args: []string{"-test.run=^TestHelperCLI$", "--", "hive-helper", "stream"}, Input: runner.InputStreamJSON}}
	startWorker(t, cfg)
	c := hub.accept(t)
	c.offer(t, "run-1", jobSpecFor(remote, base, "ai/T-steer"))
	c.nextType(t, "job_accept")
	c.lease(t, "run-1", "tok-1")
	c.next(t, "pha running", func(m wmsg) bool { return m.Type == "run_event" && m.phase() == "running" })
	c.send(t, `{"type":"steer","v":1,"id":"s0","runId":"run-x","attempt":1,"steerId":"9","input":"nhầm run"}`)
	c.send(t, `{"type":"steer","v":1,"id":"s1","runId":"run-1","attempt":1,"steerId":"42","input":"thêm test"}`)
	var results []string
	for _, m := range c.untilResult(t, "run-1") {
		if m.Type == "run_event" && m.Event == "steer_result" {
			results = append(results, string(m.Data))
		}
		if m.Type == "run_result" && (m.Exit != 0 || m.report().Status != "no_changes") {
			t.Fatalf("run_result = %+v report %+v", m, m.report())
		}
	}
	if len(results) != 1 || results[0] != `{"steerId":"42","applied":true}` {
		t.Fatalf("steer_result = %v", results)
	}
}

func TestReconnectResendsUnackedAndKeepsRunAlive(t *testing.T) {
	remote, base := makeRemote(t)
	hub := newFakeHub(t, false)
	cfg := workerConfig(t, hub, "slow")
	startWorker(t, cfg)
	c1 := hub.accept(t)
	c1.offer(t, "run-2", jobSpecFor(remote, base, "ai/T-2"))
	c1.nextType(t, "job_accept")
	c1.lease(t, "run-2", "tok-2")
	first := c1.nextType(t, "run_event")
	c1.ack(t, "run-2", first.Seq)
	// Chờ CLI đang in log rồi hub mất kết nối.
	c1.nextType(t, "log_chunk")
	// Chờ worker xoá gói đã ack trước khi cắt, để kiểm gói đã ack không bị gửi lại.
	eventually(t, "worker xoá gói đã ack", func() bool {
		for _, it := range readPending(filepath.Join(cfg.DataDir, "pending")) {
			if it.head.Seq <= first.Seq {
				return false
			}
		}
		return true
	})
	_ = c1.conn.Close(websocket.StatusGoingAway, "restart")

	c2 := hub.accept(t)
	if !slices.Contains(c2.hello.ResumeRuns, "run-2") {
		t.Fatalf("hello.resumeRuns = %v", c2.hello.ResumeRuns)
	}
	msgs := c2.untilResult(t, "run-2")
	seen := map[int64]bool{}
	var last int64
	for _, m := range msgs {
		if m.Seq <= first.Seq {
			t.Fatalf("gửi lại gói đã ack seq %d", m.Seq)
		}
		// Gói ghi xuống đĩa đúng lúc nối lại có thể đi hai lần (hub bỏ trùng), nhưng không được đi lùi quá nó.
		if m.Seq < last && !seen[m.Seq] {
			t.Fatalf("seq đi lùi: %d sau %d", m.Seq, last)
		}
		seen[m.Seq] = true
		last = max(last, m.Seq)
	}
	for s := first.Seq + 1; s <= last; s++ {
		if !seen[s] {
			t.Fatalf("thiếu gói seq %d sau khi nối lại", s)
		}
	}
	// Mất kết nối không được huỷ run.
	if res := msgs[len(msgs)-1]; res.report().Status != "succeeded" {
		t.Fatalf("run sau khi nối lại = %+v", res.report())
	}
}

func TestCancelStopsRunAndCleansWorktree(t *testing.T) {
	remote, base := makeRemote(t)
	for _, tc := range []struct {
		name, mode string
		// fast: phải dừng nhanh hơn grace mặc định 10 giây.
		fast   bool
		cancel func(t *testing.T, c *hubConn, runID string)
	}{
		// CLI bỏ qua tín hiệu dừng nhẹ: graceSec 0 phải giết ngay, không chờ grace mặc định.
		{"cancel-grace-0", "hang", true, func(t *testing.T, c *hubConn, runID string) {
			c.send(t, `{"type":"cancel","v":1,"id":"c","runId":%q,"graceSec":0}`, runID)
		}},
		// Grace mặc định: trên Windows taskkill không /F không dừng được tiến trình console nên chờ hết grace.
		{"heartbeat-ack", "sleep", false, func(t *testing.T, c *hubConn, runID string) {
			c.send(t, `{"type":"heartbeat_ack","v":1,"id":"h","renewed":[],"cancel":[%q]}`, runID)
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			hub := newFakeHub(t, true)
			cfg := workerConfig(t, hub, tc.mode)
			startWorker(t, cfg)
			c := hub.accept(t)
			c.offer(t, tc.name, jobSpecFor(remote, base, "ai/"+tc.name))
			c.nextType(t, "job_accept")
			c.lease(t, tc.name, "tok")
			c.next(t, "pha running", func(m wmsg) bool { return m.Type == "run_event" && m.phase() == "running" })
			started := time.Now()
			tc.cancel(t, c, tc.name)
			res := c.nextType(t, "run_result")
			if res.report().Status != "cancelled" || res.Exit == 0 {
				t.Fatalf("run_result = %+v report %+v", res, res.report())
			}
			if took := time.Since(started); tc.fast && took > 8*time.Second {
				t.Fatalf("huỷ mất %v", took)
			}
			eventually(t, "worktree được gỡ", noFiles(filepath.Join(cfg.DataDir, "runs", "*")))
		})
	}
}

func TestRejectsAndDrain(t *testing.T) {
	remote, base := makeRemote(t)
	hub := newFakeHub(t, true)
	cfg := workerConfig(t, hub, "slow")
	cfg.Capacity = 1
	exited := startWorker(t, cfg)
	c := hub.accept(t)

	spec := jobSpecFor(remote, base, "ai/khac")
	spec["cli"] = "gemini"
	c.offer(t, "khong-cli", spec)
	if m := c.nextType(t, "job_reject"); m.RunID != "khong-cli" || !strings.Contains(m.Reason, "gemini") {
		t.Fatalf("job_reject = %+v", m)
	}

	c.offer(t, "run-a", jobSpecFor(remote, base, "ai/A"))
	c.nextType(t, "job_accept")
	c.lease(t, "run-a", "tok")
	c.next(t, "pha running", func(m wmsg) bool { return m.Type == "run_event" && m.phase() == "running" })

	c.offer(t, "run-b", jobSpecFor(remote, base, "ai/B"))
	if m := c.nextType(t, "job_reject"); m.RunID != "run-b" || m.Reason != "máy đã đầy" {
		t.Fatalf("job_reject = %+v", m)
	}

	c.send(t, `{"type":"drain","v":1,"id":"d"}`)
	c.offer(t, "run-c", jobSpecFor(remote, base, "ai/C"))
	if m := c.nextType(t, "job_reject"); m.RunID != "run-c" || m.Reason != "máy đang thoát" {
		t.Fatalf("job_reject = %+v", m)
	}
	// Drain không dừng run đang chạy: run xong bình thường rồi worker mới thoát.
	res := c.nextType(t, "run_result")
	if res.RunID != "run-a" || res.report().Status != "succeeded" {
		t.Fatalf("run_result = %+v report %+v", res, res.report())
	}
	select {
	case err := <-exited:
		if err != nil {
			t.Fatalf("worker thoát với lỗi %v", err)
		}
	case <-time.After(waitFor):
		t.Fatal("worker không thoát sau khi drain xong")
	}
}

func TestRestartReportsInterruptedRun(t *testing.T) {
	hub := newFakeHub(t, true)
	cfg := workerConfig(t, hub, "commit")
	for _, d := range []string{"pending", "active", filepath.Join("runs", "run-9-2")} {
		if err := os.MkdirAll(filepath.Join(cfg.DataDir, d), 0700); err != nil {
			t.Fatal(err)
		}
	}
	// Lần chạy trước: run-9 đã gửi tới seq 7, log seq 7 chưa được ack, rồi worker chết.
	if err := writeMarker(markerPath(filepath.Join(cfg.DataDir, "active"), "run-9"), runMarker{RunID: "run-9", Attempt: 2, LeaseID: "l9", Seq: 7}); err != nil {
		t.Fatal(err)
	}
	logMsg := LogChunk{Type: "log_chunk", V: 1, ID: "x", RunID: "run-9", Attempt: 2, Seq: 7, Bytes: []byte("cũ")}
	if err := writePending(filepath.Join(cfg.DataDir, "pending"), "run-9", 2, 7, logMsg); err != nil {
		t.Fatal(err)
	}
	startWorker(t, cfg)
	c := hub.accept(t)
	if !slices.Equal(c.hello.ResumeRuns, []string{"run-9"}) {
		t.Fatalf("hello.resumeRuns = %v", c.hello.ResumeRuns)
	}
	msgs := c.untilResult(t, "run-9")
	if len(msgs) != 2 || msgs[0].Type != "log_chunk" || msgs[0].Seq != 7 {
		t.Fatalf("gói gửi lại = %+v", msgs)
	}
	res := msgs[1]
	if res.Seq != 8 || res.Attempt != 2 || res.Exit == 0 || !strings.Contains(res.report().Error, "khởi động lại") {
		t.Fatalf("run_result = %+v report %+v", res, res.report())
	}
	// Worktree của run chết được dọn lúc khởi động.
	if _, err := os.Stat(filepath.Join(cfg.DataDir, "runs", "run-9-2")); !os.IsNotExist(err) {
		t.Fatalf("worktree cũ còn: %v", err)
	}
	eventually(t, "hàng đợi trống", noFiles(filepath.Join(cfg.DataDir, "pending", "*.json")))
}
