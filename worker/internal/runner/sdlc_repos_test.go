package runner

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
)

// allowFileRepos cho test clone từ repo bare cục bộ (file://); worker thật chỉ nhận https, http, ssh.
func allowFileRepos(t *testing.T) {
	t.Helper()
	sdlcRepoSchemes["file"] = true
	t.Cleanup(func() { delete(sdlcRepoSchemes, "file") })
}

func repoFor(key, remote, branch string) SdlcRepo {
	return SdlcRepo{ProjectKey: key, CloneURL: fileURL(remote), Branch: branch, Dir: SdlcReposDir + "/" + key}
}

func TestMachineCapabilitiesDeclareMultiRepoOutsideSandbox(t *testing.T) {
	if !slices.Contains(MachineCapabilities(false), CapSdlcMultiRepo) {
		t.Fatalf("máy dev phải khai %s: %v", CapSdlcMultiRepo, MachineCapabilities(false))
	}
	if slices.Contains(MachineCapabilities(true), CapSdlcMultiRepo) {
		t.Fatal("runner host không giữ đăng nhập Git của đội nên không khai checkout nhiều repo")
	}
}

// Bản checkout nông nằm trong .hive/repos/<key>/, không có .git (không có gì để đẩy), khoá ghi, và STATUS.md cho agent
// biết repo nào có.
func TestCheckoutSdlcReposShallowReadOnly(t *testing.T) {
	allowFileRepos(t)
	remote, base := makeRemote(t)
	work := t.TempDir()
	st, err := checkoutSdlcRepos(context.Background(), work, []SdlcRepo{repoFor("billing", remote, base)})
	if err != nil {
		t.Fatal(err)
	}
	if len(st) != 1 || st[0].Reason != "" {
		t.Fatalf("status = %+v", st)
	}
	dir := filepath.Join(work, ".hive", "repos", "billing")
	if b, err := os.ReadFile(filepath.Join(dir, "README")); err != nil || string(b) != "init" {
		t.Fatalf("README = %q, %v", b, err)
	}
	if _, err := os.Stat(filepath.Join(dir, ".git")); !os.IsNotExist(err) {
		t.Fatalf("bản checkout còn .git: %v", err)
	}
	status, err := os.ReadFile(filepath.Join(work, ".hive", "repos", "STATUS.md"))
	if err != nil || !strings.Contains(string(status), "- billing: `.hive/repos/billing/`") {
		t.Fatalf("STATUS.md = %q, %v", status, err)
	}
	// Không kiểm bit quyền trên Windows; root bỏ qua quyền file nên cũng không kiểm.
	if runtime.GOOS != "windows" && os.Geteuid() != 0 {
		if err := os.WriteFile(filepath.Join(dir, "README"), []byte("sửa"), 0o644); err == nil {
			t.Fatal("bản checkout phải chỉ đọc")
		}
		if err := os.WriteFile(filepath.Join(dir, "moi.txt"), []byte("x"), 0o644); err == nil {
			t.Fatal("không được tạo file mới trong bản checkout")
		}
	}
	if err := removeSdlcRepos(work); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(work, ".hive", "repos")); !os.IsNotExist(err) {
		t.Fatalf(".hive/repos còn lại: %v", err)
	}
}

// Repo không lấy được thì bỏ kèm lý do, các repo khác vẫn checkout và run không hỏng: agent dùng tóm tắt hub seed.
func TestCheckoutSdlcReposSkipsWhatItCannotFetch(t *testing.T) {
	allowFileRepos(t)
	remote, base := makeRemote(t)
	work := t.TempDir()
	missing := filepath.Join(t.TempDir(), "khong-co.git")
	repos := []SdlcRepo{
		repoFor("ok", remote, base),
		repoFor("missing", missing, base),
		{ProjectKey: "ext", CloneURL: "ext::sh -c touch% /tmp/pwned", Branch: base, Dir: SdlcReposDir + "/ext"},
		{ProjectKey: "flag", CloneURL: fileURL(remote), Branch: "--upload-pack=touch", Dir: SdlcReposDir + "/flag"},
		{ProjectKey: "escape", CloneURL: fileURL(remote), Branch: base, Dir: "../escape"},
		{ProjectKey: "../up", CloneURL: fileURL(remote), Branch: base, Dir: SdlcReposDir + "/../up"},
		repoFor("OK", remote, base),
		repoFor("nobranch", remote, "khong-co-nhanh"),
	}
	st, err := checkoutSdlcRepos(context.Background(), work, repos)
	if err != nil {
		t.Fatal(err)
	}
	if len(st) != len(repos) || st[0].Reason != "" {
		t.Fatalf("status = %+v", st)
	}
	for _, s := range st[1:] {
		if s.Reason == "" {
			t.Fatalf("%s phải bị bỏ: %+v", s.ProjectKey, st)
		}
		if s.ProjectKey == "OK" && s.Reason != "trùng dự án" {
			t.Fatalf("OK = %q", s.Reason)
		}
	}
	entries, err := os.ReadDir(filepath.Join(work, ".hive", "repos"))
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	if !slices.Equal(names, []string{"STATUS.md", "ok"}) {
		t.Fatalf(".hive/repos = %v", names)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(work), "escape")); !os.IsNotExist(err) {
		t.Fatal("checkout ra ngoài worktree")
	}
	status, _ := os.ReadFile(filepath.Join(work, ".hive", "repos", "STATUS.md"))
	if !strings.Contains(string(status), "- missing: không có bản checkout (không clone được") {
		t.Fatalf("STATUS.md = %s", status)
	}
	_ = removeSdlcRepos(work)
}

func TestCheckoutSdlcReposLimits(t *testing.T) {
	allowFileRepos(t)
	remote, base := makeRemote(t)

	t.Run("kích thước mỗi repo", func(t *testing.T) {
		old := sdlcRepoMaxBytes
		sdlcRepoMaxBytes = 3
		t.Cleanup(func() { sdlcRepoMaxBytes = old })
		work := t.TempDir()
		st, err := checkoutSdlcRepos(context.Background(), work, []SdlcRepo{repoFor("big", remote, base)})
		if err != nil || len(st) != 1 || !strings.Contains(st[0].Reason, "vượt giới hạn kích thước") {
			t.Fatalf("status = %+v, %v", st, err)
		}
		if _, err := os.Stat(filepath.Join(work, ".hive", "repos", "big")); !os.IsNotExist(err) {
			t.Fatal("repo quá cỡ phải bị xoá")
		}
	})

	t.Run("tổng kích thước", func(t *testing.T) {
		old := sdlcReposMaxBytes
		// README "init" + .gitkeep "x" = 5 byte: repo đầu vừa, repo thứ hai vượt tổng.
		sdlcReposMaxBytes = 7
		t.Cleanup(func() { sdlcReposMaxBytes = old })
		work := t.TempDir()
		st, err := checkoutSdlcRepos(context.Background(), work, []SdlcRepo{repoFor("a", remote, base), repoFor("b", remote, base)})
		if err != nil || len(st) != 2 || st[0].Reason != "" || !strings.Contains(st[1].Reason, "vượt giới hạn kích thước") {
			t.Fatalf("status = %+v, %v", st, err)
		}
		_ = removeSdlcRepos(work)
	})

	t.Run("số repo", func(t *testing.T) {
		old := sdlcMaxRepos
		sdlcMaxRepos = 1
		t.Cleanup(func() { sdlcMaxRepos = old })
		work := t.TempDir()
		st, err := checkoutSdlcRepos(context.Background(), work, []SdlcRepo{repoFor("a", remote, base), repoFor("b", remote, base)})
		if err != nil || len(st) != 2 || st[0].Reason != "" || !strings.Contains(st[1].Reason, "giới hạn 1 repo") {
			t.Fatalf("status = %+v, %v", st, err)
		}
		_ = removeSdlcRepos(work)
	})

	t.Run("repo đã có .hive/repos", func(t *testing.T) {
		work := t.TempDir()
		if err := os.MkdirAll(filepath.Join(work, ".hive", "repos"), 0o755); err != nil {
			t.Fatal(err)
		}
		if _, err := checkoutSdlcRepos(context.Background(), work, []SdlcRepo{repoFor("a", remote, base)}); err == nil {
			t.Fatal("không được trộn bản checkout vào thư mục có sẵn của repo")
		}
	})
}

func TestValidSdlcRepoURL(t *testing.T) {
	for raw, want := range map[string]bool{
		"https://gitlab.com/xdev-team/repo-a.git": true,
		"ssh://git@github.com/org/repo.git":       true,
		"git@github.com:org/repo.git":             true,
		"file:///tmp/repo.git":                    false,
		"/tmp/repo.git":                           false,
		"ext::sh -c id":                           false,
		"https:///khong-host":                     false,
	} {
		if got := validSdlcRepoURL(raw); got != want {
			t.Errorf("validSdlcRepoURL(%q) = %v", raw, got)
		}
	}
}

// Qua Runner: CLI thấy bản checkout trong worktree, rồi worktree (kể cả bản chỉ đọc) được dọn hết sau run.
func TestRunnerSdlcChecksOutParticipantReposAndCleansUp(t *testing.T) {
	allowFileRepos(t)
	remote, base := makeRemote(t)
	other, otherBase := makeRemote(t)
	data := t.TempDir()
	spec := &SdlcJob{
		Step:    "spec",
		Seed:    []SdlcSeed{{Path: ".hive/sdlc/projects/billing.md", Content: "tóm tắt"}},
		Collect: []SdlcCollect{{ArtifactID: "art-spec", Path: "specs/011/spec.md"}},
		Repos:   []SdlcRepo{repoFor("billing", other, otherBase)},
	}
	job := sdlcJob("sdlc-repos", remote, base, spec, map[string]string{
		"HIVE_FAKE_SDLC_EXPECT": jsonEnv(t, map[string]string{".hive/repos/billing/README": "init", ".hive/sdlc/projects/billing.md": "tóm tắt"}),
		"HIVE_FAKE_SDLC_WRITE":  jsonEnv(t, map[string]string{"specs/011/spec.md": "# Đặc tả\n"}),
	})
	res, _, err := runSdlc(t, data, job)
	if err != nil {
		t.Fatal(err)
	}
	if res == nil || res.Status != "succeeded" || len(res.Artifacts) != 1 {
		t.Fatalf("result = %#v", res)
	}
	runs, err := os.ReadDir(filepath.Join(data, "runs"))
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range runs {
		if strings.Contains(e.Name(), "sdlc-repos") {
			t.Fatalf("worktree còn lại: %s", e.Name())
		}
	}
}

// Seed không ghi được vào bản checkout chỉ đọc của repo khác: run lỗi thay vì lặng lẽ sửa repo tham gia.
func TestRunnerSdlcSeedCannotOverwriteCheckout(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("kiểm quyền file chỉ trên Unix, không chạy bằng root")
	}
	allowFileRepos(t)
	remote, base := makeRemote(t)
	other, otherBase := makeRemote(t)
	spec := &SdlcJob{
		Step:  "spec",
		Seed:  []SdlcSeed{{Path: ".hive/repos/billing/README", Content: "ghi đè"}},
		Repos: []SdlcRepo{repoFor("billing", other, otherBase)},
	}
	res, _, err := runSdlc(t, t.TempDir(), sdlcJob("sdlc-seed-ro", remote, base, spec, nil))
	if err == nil || res == nil || res.Status != "failed" {
		t.Fatalf("result = %#v, err = %v", res, err)
	}
}
