package secretstore_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/projects"
	"github.com/tdduydev/xdev-hive/worker/internal/runner"
	"github.com/tdduydev/xdev-hive/worker/internal/secretstore"
	"github.com/zalando/go-keyring"
)

func TestSC004NoValuesOnDisk(t *testing.T) {
	keyring.MockInit()
	root := t.TempDir()
	config := filepath.Join(root, "config", "worker.json")
	if os.MkdirAll(filepath.Dir(config), 0700) != nil {
		t.Fatal("không tạo được cấu hình tạm")
	}
	value := "fake-sc004-credential-123456"
	store := secretstore.NewStore()
	if store.Set("SC004_CREDENTIAL", value) != nil {
		t.Fatal("không tạo được kho giả")
	}
	if err := secretstore.ModifyCatalog(secretstore.CatalogPath(config), func(c *secretstore.Catalog) error {
		_, err := c.Add("SC004_CREDENTIAL", "Thử không ghi đĩa", time.Now())
		if err != nil {
			return err
		}
		_, err = c.Assign("SC004_CREDENTIAL", "local-sc004")
		return err
	}); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(root, "source")
	remote := filepath.Join(root, "remote.git")
	if os.MkdirAll(source, 0700) != nil {
		t.Fatal("không tạo được repo tạm")
	}
	git := func(args ...string) {
		t.Helper()
		if exec.Command("git", args...).Run() != nil {
			t.Fatal("không dựng được repo git tạm")
		}
	}
	git("-C", source, "init", "-b", "main")
	git("-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "initial")
	git("clone", "--bare", source, remote)
	if projects.WriteJSON(projects.DefaultPath(config), map[string]any{"projects": []projects.Project{{LocalID: "local-sc004", Name: "demo", Folder: source}}}) != nil {
		t.Fatal("không lưu dự án")
	}
	pending := filepath.Join(root, "pending")
	if os.MkdirAll(pending, 0700) != nil {
		t.Fatal("không tạo được pending")
	}
	n := 0
	sink := runner.SinkFunc(func(e runner.Event) error {
		n++
		b, err := json.Marshal(e)
		if err != nil {
			return err
		}
		return os.WriteFile(filepath.Join(pending, fmt.Sprintf("%03d.json", n)), b, 0600)
	})
	r := runner.Runner{DataDir: filepath.Join(root, "data"), WorkerConfig: config, CLICommands: map[string]runner.Command{"codex": {Path: os.Args[0], Args: []string{"-test.run=^TestSC004Agent$"}, ReadOnly: true}}}
	err := r.Run(context.Background(), runner.Job{RunID: "sc004", Attempt: 1, LocalID: "local-sc004", Kind: runner.KindPlan, RepoURL: filepath.ToSlash(remote), BaseBranch: "main", Branch: "ai/sc004", CLI: "codex", Prompt: "test", Env: map[string]string{"HIVE_SC004_AGENT": "1"}}, sink)
	if err != nil {
		t.Fatal("run giả không hoàn tất")
	}
	got, err := store.Get("SC004_CREDENTIAL")
	if err != nil || got != value {
		t.Fatal("reveal không khớp")
	}
	if _, err := secretstore.Append(secretstore.GrantsPath(config), secretstore.GrantRecord{Kind: secretstore.KindReveal, Names: []string{"SC004_CREDENTIAL"}}); err != nil {
		t.Fatal(err)
	}
	if store.Delete("SC004_CREDENTIAL") != nil {
		t.Fatal("không xoá được kho giả")
	}
	if err := secretstore.ModifyCatalog(secretstore.CatalogPath(config), func(c *secretstore.Catalog) error { return c.Remove("SC004_CREDENTIAL") }); err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{filepath.Dir(config), pending} {
		err := filepath.WalkDir(dir, func(path string, entry fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if entry.IsDir() {
				return nil
			}
			b, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			if strings.Contains(string(b), value) || strings.Contains(string(b), base64.StdEncoding.EncodeToString([]byte(value))) {
				t.Error("SC-004: giá trị đã được ghi vào file")
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
}

func TestSC004Agent(t *testing.T) {
	if os.Getenv("HIVE_SC004_AGENT") != "1" {
		return
	}
	value := os.Getenv("SC004_CREDENTIAL")
	if value != "fake-sc004-credential-123456" {
		os.Exit(23)
	}
	fmt.Print(value + "\n" + base64.StdEncoding.EncodeToString([]byte(value)) + "\n")
}
