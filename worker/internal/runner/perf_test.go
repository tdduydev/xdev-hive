package runner

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// Đo thời gian từng pha của một run trên repo cỡ vừa (nhiều file, nhiều nhánh) với CLI giả. Chạy:
//
//	go test ./internal/runner -run '^$' -bench RunnerPhases -benchtime 10x
//
// Số báo theo pha: prepare (clone/fetch/worktree add), cli (CLI giả), verify (đếm commit, diff), publish (push),
// cleanup (gỡ worktree tới lúc gửi kết quả).
func BenchmarkRunnerPhases(b *testing.B) {
	remote, base := makeBigRemote(b, 4000, 200)
	data := b.TempDir()
	// Run đầu tạo repo cache; lần đo chỉ tính run đã có cache như phần lớn run thật.
	runTimed(b, Runner{DataDir: data, CLICommands: fakeCommands("commit")}, remote, base, "seed")
	totals := map[string]time.Duration{}
	b.ResetTimer()
	for i := range b.N {
		for phase, d := range runTimed(b, Runner{DataDir: data, CLICommands: fakeCommands("commit")}, remote, base, fmt.Sprintf("b%d", i)) {
			totals[phase] += d
		}
	}
	for phase, d := range totals {
		b.ReportMetric(float64(d.Microseconds())/1000/float64(b.N), phase+"-ms")
	}
}

// BenchmarkRunnerParallel đo bốn run cùng repo chạy song song (worker --capacity 4): khoá repo cache giữ lâu làm run
// sau chờ run trước chuẩn bị xong.
func BenchmarkRunnerParallel(b *testing.B) {
	remote, base := makeBigRemote(b, 4000, 200)
	data := b.TempDir()
	runTimed(b, Runner{DataDir: data, CLICommands: fakeCommands("commit")}, remote, base, "seed")
	var prepare time.Duration
	b.ResetTimer()
	for i := range b.N {
		var wg sync.WaitGroup
		var mu sync.Mutex
		for k := range 4 {
			wg.Go(func() {
				got := runTimed(b, Runner{DataDir: data, CLICommands: fakeCommands("commit")}, remote, base, fmt.Sprintf("p%d-%d", i, k))
				mu.Lock()
				prepare = max(prepare, got["prepare"])
				mu.Unlock()
			})
		}
		wg.Wait()
	}
	b.ReportMetric(float64(prepare.Microseconds())/1000, "max-prepare-ms")
}

func runTimed(tb testing.TB, r Runner, remote, base, id string) map[string]time.Duration {
	tb.Helper()
	var mu sync.Mutex
	marks := map[string]time.Time{"start": time.Now()}
	var result *Result
	job := Job{RunID: id, Attempt: 1, RepoURL: fileURL(remote), BaseBranch: base, Branch: "ai/" + id, CLI: "codex", Prompt: "p", Timeout: time.Minute, Env: map[string]string{"HIVE_RUNNER_HELPER": "1", "HIVE_FAKE_MODE": "commit"}}
	err := r.Run(context.Background(), job, SinkFunc(func(e Event) error {
		mu.Lock()
		defer mu.Unlock()
		switch e.Type {
		case "phase":
			marks[e.Phase] = time.Now()
		case "result":
			marks["result"] = time.Now()
			result = e.Result
		}
		return nil
	}))
	if err != nil || result == nil || result.Status != "succeeded" {
		tb.Fatalf("run %s: err = %v, result = %#v", id, err, result)
	}
	return map[string]time.Duration{
		"prepare": marks["running"].Sub(marks["start"]),
		"cli":     marks["verifying"].Sub(marks["running"]),
		"verify":  marks["publishing"].Sub(marks["verifying"]),
		"publish": marks["cleanup"].Sub(marks["publishing"]),
		"cleanup": marks["result"].Sub(marks["cleanup"]),
		"total":   marks["result"].Sub(marks["start"]),
	}
}

// makeBigRemote tạo remote có files file (4 KiB mỗi file, chia thư mục) và branches nhánh cũ như repo đã chạy nhiều run.
func makeBigRemote(tb testing.TB, files, branches int) (string, string) {
	tb.Helper()
	root := tb.TempDir()
	remote := filepath.Join(root, "remote.git")
	work := filepath.Join(root, "source")
	run := func(args ...string) {
		tb.Helper()
		if out, err := gitCmd(args...).CombinedOutput(); err != nil {
			tb.Fatalf("%v: %v\n%s", args, err, out)
		}
	}
	run("init", "--bare", remote)
	run("init", work)
	body := strings.Repeat("dòng nội dung mẫu cho file lớn\n", 128)
	for i := range files {
		dir := filepath.Join(work, fmt.Sprintf("pkg%02d", i%40))
		if err := os.MkdirAll(dir, 0o755); err != nil {
			tb.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("f%04d.txt", i)), []byte(fmt.Sprint(i)+body), 0o644); err != nil {
			tb.Fatal(err)
		}
	}
	run("-C", work, "add", ".")
	run("-C", work, "-c", "user.name=Runner Test", "-c", "user.email=runner@example.invalid", "commit", "-q", "-m", "base")
	var refs strings.Builder
	for i := range branches {
		fmt.Fprintf(&refs, "create refs/heads/ai/old-%03d HEAD\n", i)
	}
	c := gitCmd("-C", work, "update-ref", "--stdin")
	c.Stdin = strings.NewReader(refs.String())
	if out, err := c.CombinedOutput(); err != nil {
		tb.Fatalf("update-ref: %v\n%s", err, out)
	}
	out, err := gitCmd("-C", work, "branch", "--show-current").Output()
	if err != nil {
		tb.Fatal(err)
	}
	base := strings.TrimSpace(string(out))
	run("-C", work, "push", "-q", "--all", remote)
	return remote, base
}

func gitCmd(args ...string) *exec.Cmd { return exec.Command("git", args...) }
