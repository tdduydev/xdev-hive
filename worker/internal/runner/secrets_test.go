package runner

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/secretmask"
	"github.com/tdduydev/xdev-hive/worker/internal/secretstore"
	"github.com/zalando/go-keyring"
)

func TestRunnerSecretAgentAndPublication(t *testing.T) {
	for _, mode := range []string{"safe", "leak", "base64"} {
		t.Run(mode, func(t *testing.T) {
			config, value := secretFixture(t)
			remote, base := makeRemote(t)
			r := Runner{DataDir: t.TempDir(), WorkerConfig: config, CLICommands: map[string]Command{"codex": {Path: os.Args[0], Args: []string{"-test.run=^TestSecretAgentProcess$"}}}}
			var logs bytes.Buffer
			var result *Result
			job := Job{RunID: "grant-" + mode, Attempt: 1, RepoURL: fileURL(remote), BaseBranch: base, Branch: "ai/grant-" + mode, CLI: "codex", Prompt: "test", LocalID: "local-demo", Env: map[string]string{"HIVE_SECRET_AGENT": mode, "DEMO_CREDENTIAL": "old"}}
			err := r.Run(context.Background(), job, SinkFunc(func(e Event) error {
				if e.Type == "log" {
					logs.Write(e.Data)
				}
				if e.Result != nil {
					result = e.Result
				}
				return nil
			}))
			if mode == "safe" && err != nil {
				t.Fatal("run được cấp env không hoàn tất")
			}
			if mode != "safe" && (err == nil || !strings.Contains(err.Error(), "đã chặn")) {
				t.Fatal("không chặn đẩy commit chứa bí mật")
			}
			if result == nil || result.SecretsInjected != 1 {
				t.Fatal("sai số lượng cấp")
			}
			if strings.Contains(logs.String(), value) || strings.Contains(logs.String(), base64.StdEncoding.EncodeToString([]byte(value))) {
				t.Fatal("giá trị lọt vào log")
			}
			if mode != "safe" {
				cmd := exec.Command("git", "--git-dir", remote, "show-ref", "--verify", "--quiet", "refs/heads/"+job.Branch)
				if cmd.Run() == nil {
					t.Fatal("đã đẩy nhánh chứa bí mật")
				}
			}
		})
	}
}

func TestSecretAgentProcess(t *testing.T) {
	mode := os.Getenv("HIVE_SECRET_AGENT")
	if mode == "" {
		return
	}
	value := os.Getenv("DEMO_CREDENTIAL")
	if value != "giá-trị-thử-'\"-$\nnguyên-vẹn" {
		os.Exit(25)
	}
	for _, form := range []string{value, base64.StdEncoding.EncodeToString([]byte(value))} {
		fmt.Print(strings.Repeat("x", (16<<10)-3) + form + " end\n")
	}
	content := "safe"
	if mode == "leak" {
		content = value
	}
	if mode == "base64" {
		content = base64.StdEncoding.EncodeToString([]byte(value))
	}
	if os.WriteFile("result.txt", []byte(content), 0600) != nil {
		os.Exit(26)
	}
	for _, args := range [][]string{{"add", "."}, {"-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "agent result"}} {
		if exec.Command("git", args...).Run() != nil {
			os.Exit(27)
		}
	}
}

func TestSecretSinkMasksBeforePersistence(t *testing.T) {
	config, value := secretFixture(t)
	g, err := secretstore.Grant(context.Background(), secretstore.GrantRequest{WorkerConfig: config, LocalID: "local-demo", Kind: "run"})
	if err != nil {
		t.Fatal(err)
	}
	var wire bytes.Buffer
	sink := newSecretSink(SinkFunc(func(e Event) error { return json.NewEncoder(&wire).Encode(e) }), secretmask.New(g.Values), config, g)
	forms := []string{value, base64.StdEncoding.EncodeToString([]byte(value)), strings.ReplaceAll(value, "\n", "\r\n")}
	for _, form := range forms {
		data := strings.Repeat("x", (16<<10)-4) + form + " end"
		for i := 0; i < len(data); i += 16 << 10 {
			if err := sink.Emit(Event{Type: "log", Stream: "stdout", Data: []byte(data[i:min(i+(16<<10), len(data))])}); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := sink.Emit(Event{Type: "result", Result: &Result{Error: value, Commands: []CommandResult{{Tail: value}}, Artifacts: []SdlcArtifact{{Content: value}}}}); err != nil {
		t.Fatal(err)
	}
	for _, form := range forms {
		escaped, _ := json.Marshal(form)
		if bytes.Contains(wire.Bytes(), escaped[1:len(escaped)-1]) {
			t.Fatal("giá trị lọt vào nơi ghi bền")
		}
	}
	cat, _ := secretstore.LoadCatalog(secretstore.CatalogPath(config))
	entries, err := secretstore.ReadLog(secretstore.GrantsPath(config), secretstore.LogFilter{}, cat)
	if err != nil || len(entries) != 1 || !entries[0].Names[0].Leaked {
		t.Fatal("thiếu nhật ký che giá trị")
	}
}

func TestScanDiffBlocksStagedAndAgentCommits(t *testing.T) {
	value := "fake-local-credential-123456"
	for _, mode := range []string{"staged", "committed", "base64", "binary"} {
		t.Run(mode, func(t *testing.T) {
			dir := t.TempDir()
			must(t, "git", "-C", dir, "init")
			mustDir(t, dir, "README", "safe")
			must(t, "git", "-C", dir, "add", ".")
			must(t, "git", "-C", dir, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial")
			base := strings.TrimSpace(mustOut(t, "git", "-C", dir, "rev-parse", "HEAD"))
			data := value
			if mode == "base64" {
				data = base64.StdEncoding.EncodeToString([]byte(value))
			}
			if mode == "binary" {
				data = "\x00" + value + "\x00"
			}
			mustDir(t, dir, "leak.txt", data)
			must(t, "git", "-C", dir, "add", ".")
			if mode != "staged" {
				must(t, "git", "-C", dir, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "agent change")
			}
			hits, err := scanDiffForSecrets(context.Background(), dir, base, secretmask.New([]string{value}))
			if err != nil || len(hits) != 1 {
				t.Fatal("không chặn giá trị trong index/lịch sử git")
			}
		})
	}
}

func secretFixture(t *testing.T) (string, string) {
	t.Helper()
	keyring.MockInit()
	config := filepath.Join(t.TempDir(), "worker.json")
	value := "giá-trị-thử-'\"-$\nnguyên-vẹn"
	if err := secretstore.NewStore().Set("DEMO_CREDENTIAL", value); err != nil {
		t.Fatal("không tạo được kho giả")
	}
	err := secretstore.ModifyCatalog(secretstore.CatalogPath(config), func(c *secretstore.Catalog) error {
		_, err := c.Add("DEMO_CREDENTIAL", "Dùng thử", time.Now())
		if err != nil {
			return err
		}
		_, err = c.Assign("DEMO_CREDENTIAL", "local-demo")
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return config, value
}

func TestRunnerSecretGrantIsolation(t *testing.T) {
	config, value := secretFixture(t)
	r := Runner{WorkerConfig: config}
	for _, tc := range []struct {
		local   string
		sandbox bool
		want    bool
	}{
		{"local-demo", false, true}, {"other", false, false}, {"", false, false}, {"local-demo", true, false},
	} {
		job := Job{LocalID: tc.local, RunID: "demo", Attempt: 1}
		if tc.sandbox {
			job.Execution = "sandbox"
		}
		g, err := r.grantSecrets(context.Background(), job)
		if err != nil {
			t.Fatal(err)
		}
		if (g.Env["DEMO_CREDENTIAL"] == value) != tc.want {
			t.Fatal("cấp sai phạm vi dự án")
		}
		if !tc.want {
			continue
		}
		env := mergeSecretEnv(map[string]string{"DEMO_CREDENTIAL": "old"}, g.Env)
		cmd := exec.Command(os.Args[0], "-test.run=^TestSecretChildEnv$")
		cmd.Env = mergeEnv(os.Environ(), mergeMap(env, map[string]string{"HIVE_SECRET_CHILD": "1"}))
		if err := cmd.Run(); err != nil {
			t.Fatal("tiến trình con không nhận đúng env")
		}
	}
	if got := mergeSecretEnv(nil, map[string]string{"PATH": "bad", "DEMO_CREDENTIAL": value}); got["PATH"] != "" {
		t.Fatal("đã cấp tên dành riêng")
	}
}

func TestSecretChildEnv(t *testing.T) {
	if os.Getenv("HIVE_SECRET_CHILD") != "1" {
		return
	}
	if os.Getenv("DEMO_CREDENTIAL") != "giá-trị-thử-'\"-$\nnguyên-vẹn" {
		os.Exit(21)
	}
}

func TestRunnerMissingSecretStopsBeforeSpawn(t *testing.T) {
	config, _ := secretFixture(t)
	if err := secretstore.NewStore().Delete("DEMO_CREDENTIAL"); err != nil {
		t.Fatal(err)
	}
	remote, base := makeRemote(t)
	r := Runner{DataDir: t.TempDir(), WorkerConfig: config, CLICommands: fakeCommands("commit")}
	var events []Event
	err := r.Run(context.Background(), Job{RunID: "missing", Attempt: 1, RepoURL: fileURL(remote), BaseBranch: base, Branch: "ai/missing", CLI: "codex", Prompt: "test", LocalID: "local-demo"}, SinkFunc(func(e Event) error { events = append(events, e); return nil }))
	if err == nil {
		t.Fatal("kho thiếu vẫn chạy agent")
	}
	res := lastResult(events)
	if res == nil || res.Status != "failed" || res.SecretsInjected != 0 {
		t.Fatal("thiếu kết quả lỗi an toàn")
	}
}
