package runner

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

// Run sdlc ghi được vào worktree nên không chỉ đọc, nhưng vẫn là việc ngoài run code mà hub chỉ giao cho worker khai nó.
func TestSdlcIsWritableKindWithCapability(t *testing.T) {
	if readOnlyKind(KindSdlc) {
		t.Fatal("run sdlc phải ghi được file trong worktree")
	}
	found := false
	for _, c := range Capabilities {
		found = found || c == "sdlc"
	}
	if !found || KindSdlc != "sdlc" {
		t.Fatalf("Capabilities = %v", Capabilities)
	}
	// Quyền workspace: không bypass, không toàn quyền; vẫn là cờ ghi trong phạm vi worktree như run code.
	env := map[string]string{"HIVE_HUB_URL": "https://hub.example", "HIVE_RUN_TOKEN": "run-secret"}
	cmd, err := (Runner{}).cliCommand(Job{CLI: "claude", Kind: KindSdlc, RunPermissions: "workspace", Prompt: "p", Env: env})
	if err != nil {
		t.Fatal(err)
	}
	if cmd.cleanup != nil {
		defer cmd.cleanup()
	}
	joined := strings.Join(cmd.Args, " ")
	if !strings.Contains(joined, "--permission-mode acceptEdits") || strings.Contains(joined, "bypassPermissions") || strings.Contains(joined, "--permission-mode plan") {
		t.Fatalf("args = %q", cmd.Args)
	}
	// CLI cấu hình riêng không cần khai readOnly: chính nó phải ghi được.
	if _, err := (Runner{CLICommands: map[string]Command{"claude": {Path: "/bin/true"}}}).cliCommand(Job{CLI: "claude", Kind: KindSdlc, Prompt: "p"}); err != nil {
		t.Fatalf("override không readOnly: %v", err)
	}
	if !NeedsFull("antigravity", KindSdlc) {
		t.Fatal("antigravity không giới hạn được trong worktree nên run ghi chỉ chạy khi toàn quyền")
	}
}

func TestWorktreeFileRejectsPathsOutsideWorktree(t *testing.T) {
	root := t.TempDir()
	for _, rel := range []string{
		"",
		".",
		"..",
		"../x.md",
		"a/../../x.md",
		"a/../b.md",
		"/etc/passwd",
		"/abs/x.md",
		`..\x.md`,
		`docs\x.md`,
		`\x.md`,
		`C:\Users\x.md`,
		"C:/Users/x.md",
		".git/config",
		".GIT/hooks/pre-commit",
		"a\x00b.md",
	} {
		// "C:/Users/x.md" chỉ là tên thư mục hợp lệ trên Unix; trên đó chỉ dấu "\" và ".." mới bị chặn.
		if rel == "C:/Users/x.md" && runtime.GOOS != "windows" {
			continue
		}
		if path, _, err := worktreeFile(root, rel); err == nil {
			t.Errorf("%q được chấp nhận: %s", rel, path)
		}
	}
	for _, rel := range []string{"x.md", "docs/x.md", "a/b/c/d.md", "docs//x.md", "./x.md", ".github/x.md", "gitignore/x.md"} {
		path, exists, err := worktreeFile(root, rel)
		if err != nil || exists {
			t.Errorf("%q: path=%q exists=%v err=%v", rel, path, exists, err)
		}
		if r, err := filepath.Rel(root, path); err != nil || strings.HasPrefix(r, "..") {
			t.Errorf("%q thoát khỏi worktree: %s", rel, path)
		}
	}
	// Đường dẫn kiểu hub ("/") đổi đúng sang dấu phân cách của hệ điều hành, gồm cả Windows.
	if path, _, err := worktreeFile(root, "docs/sub/x.md"); err != nil || path != filepath.Join(root, "docs", "sub", "x.md") {
		t.Fatalf("path = %q, err = %v", path, err)
	}
}

func TestWriteSdlcSeedWritesFilesInsideWorktree(t *testing.T) {
	work := t.TempDir()
	mustDir(t, work, "old.md", "cũ")
	err := writeSdlcSeed(work, []SdlcSeed{
		{Path: "docs/baseline/spec.md", Content: "# Nền\nTiếng Việt có dấu\n"},
		{Path: "old.md", Content: "mới"},
		{Path: "rong.md", Content: ""},
	})
	if err != nil {
		t.Fatal(err)
	}
	for rel, want := range map[string]string{"docs/baseline/spec.md": "# Nền\nTiếng Việt có dấu\n", "old.md": "mới", "rong.md": ""} {
		got, err := os.ReadFile(filepath.Join(work, filepath.FromSlash(rel)))
		if err != nil || string(got) != want {
			t.Errorf("%s = %q, %v", rel, got, err)
		}
	}
	if err := writeSdlcSeed(work, nil); err != nil {
		t.Fatal(err)
	}
}

func TestWriteSdlcSeedRejectsEscapes(t *testing.T) {
	outer := t.TempDir()
	work := filepath.Join(outer, "work")
	if err := os.MkdirAll(work, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, rel := range []string{"../escape.md", "a/../../escape.md", "/tmp/escape.md", `..\escape.md`, `docs\escape.md`, ".git/config"} {
		if err := writeSdlcSeed(work, []SdlcSeed{{Path: rel, Content: "x"}}); err == nil || !strings.Contains(err.Error(), "không hợp lệ") {
			t.Errorf("%q: err = %v", rel, err)
		}
	}
	if _, err := os.Stat(filepath.Join(outer, "escape.md")); !os.IsNotExist(err) {
		t.Fatalf("file lọt ra ngoài worktree: %v", err)
	}
	if entries, _ := os.ReadDir(work); len(entries) != 0 {
		t.Fatalf("worktree còn file dở: %v", entries)
	}
}

func TestWriteSdlcSeedLimits(t *testing.T) {
	work := t.TempDir()
	long := strings.Repeat("a", sdlcMaxFileChars+1)
	if err := writeSdlcSeed(work, []SdlcSeed{{Path: "a.md", Content: long}}); err == nil || !strings.Contains(err.Error(), "giới hạn") {
		t.Fatalf("seed quá dài: %v", err)
	}
	many := make([]SdlcSeed, sdlcMaxSeed+1)
	for i := range many {
		many[i] = SdlcSeed{Path: "f" + string(rune('a'+i%26)) + ".md"}
	}
	if err := writeSdlcSeed(work, many); err == nil || !strings.Contains(err.Error(), "giới hạn") {
		t.Fatalf("quá nhiều seed: %v", err)
	}
}

func symlinkOrSkip(t *testing.T, target, link string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("tạo symlink trên Windows cần quyền riêng")
	}
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("không tạo được symlink: %v", err)
	}
}

func TestWriteSdlcSeedRefusesSymlinks(t *testing.T) {
	outer := t.TempDir()
	work := filepath.Join(outer, "work")
	secret := filepath.Join(outer, "secret")
	if err := os.MkdirAll(work, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(secret, 0o755); err != nil {
		t.Fatal(err)
	}
	mustDir(t, secret, "keep.md", "giữ nguyên")
	// Thư mục trong repo là symlink ra ngoài, và file là symlink tới file ngoài.
	symlinkOrSkip(t, secret, filepath.Join(work, "docs"))
	symlinkOrSkip(t, filepath.Join(secret, "keep.md"), filepath.Join(work, "link.md"))
	for _, rel := range []string{"docs/x.md", "docs/new/x.md", "link.md"} {
		if err := writeSdlcSeed(work, []SdlcSeed{{Path: rel, Content: "ghi đè"}}); err == nil || !strings.Contains(err.Error(), "symlink") {
			t.Errorf("%q: err = %v", rel, err)
		}
	}
	if got, _ := os.ReadFile(filepath.Join(secret, "keep.md")); string(got) != "giữ nguyên" {
		t.Fatalf("file ngoài worktree bị ghi: %q", got)
	}
	if _, err := os.Stat(filepath.Join(secret, "x.md")); !os.IsNotExist(err) {
		t.Fatalf("file lọt qua symlink: %v", err)
	}
}

func sha(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func TestCollectSdlcArtifactsReadsFilesWithSha256(t *testing.T) {
	work := t.TempDir()
	if err := os.MkdirAll(filepath.Join(work, "specs", "011"), 0o755); err != nil {
		t.Fatal(err)
	}
	spec := "# Đặc tả\n\nNội dung tiếng Việt\n"
	mustDir(t, filepath.Join(work, "specs"), "plan.md", "kế hoạch")
	mustDir(t, filepath.Join(work, "specs", "011"), "spec.md", spec)
	got, err := collectSdlcArtifacts(work, []SdlcCollect{
		{ArtifactID: "a-1", Path: "specs/011/spec.md"},
		{ArtifactID: "a-2", Path: "specs/011/khong-co.md"},
		{ArtifactID: "a-3", Path: "specs/plan.md"},
		{ArtifactID: "a-4", Path: "khong-co/thu-muc/x.md"},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []SdlcArtifact{
		{ArtifactID: "a-1", Path: "specs/011/spec.md", Content: spec, SHA256: sha(spec)},
		{ArtifactID: "a-3", Path: "specs/plan.md", Content: "kế hoạch", SHA256: sha("kế hoạch")},
	}
	if len(got) != len(want) {
		t.Fatalf("artifacts = %+v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("artifacts[%d] = %+v, muốn %+v", i, got[i], want[i])
		}
	}
	// Không có gì để thu thì không lỗi và không có phần tử nào.
	if none, err := collectSdlcArtifacts(work, nil); err != nil || len(none) != 0 {
		t.Fatalf("none = %v, %v", none, err)
	}
	if none, err := collectSdlcArtifacts(work, []SdlcCollect{{ArtifactID: "x", Path: "khong-co.md"}}); err != nil || len(none) != 0 {
		t.Fatalf("file thiếu: %v, %v", none, err)
	}
}

func TestCollectSdlcArtifactsCountsRunesAndKeepsHashConsistent(t *testing.T) {
	work := t.TempDir()
	// 200 000 ký tự nhưng 600 000 byte: giới hạn tính theo ký tự như hợp đồng.
	exact := strings.Repeat("ế", sdlcMaxFileChars)
	mustDir(t, work, "exact.md", exact)
	mustDir(t, work, "over.md", exact+"ế")
	// Byte hỏng (không phải UTF-8): JSON sẽ đổi chúng thành U+FFFD, nên sha256 phải tính trên bản đã đổi.
	if err := os.WriteFile(filepath.Join(work, "bad.md"), []byte("a\xffb"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := collectSdlcArtifacts(work, []SdlcCollect{{ArtifactID: "e", Path: "exact.md"}, {ArtifactID: "b", Path: "bad.md"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Content != exact || got[0].SHA256 != sha(exact) {
		t.Fatalf("exact = %d artifact", len(got))
	}
	if got[1].Content != "a\ufffdb" || got[1].SHA256 != sha("a\ufffdb") {
		t.Fatalf("bad = %+v", got[1])
	}
	var roundTrip []SdlcArtifact
	b, _ := json.Marshal(got)
	if err := json.Unmarshal(b, &roundTrip); err != nil || roundTrip[1].SHA256 != sha(roundTrip[1].Content) {
		t.Fatalf("sha256 không khớp sau JSON: %+v, %v", roundTrip, err)
	}
	if _, err := collectSdlcArtifacts(work, []SdlcCollect{{ArtifactID: "o", Path: "over.md"}}); err == nil || !strings.Contains(err.Error(), "200000 ký tự") {
		t.Fatalf("over.md: %v", err)
	}
}

func TestCollectSdlcArtifactsLimits(t *testing.T) {
	work := t.TempDir()
	chunk := strings.Repeat("a", sdlcMaxFileChars)
	for i := 0; i < 11; i++ {
		mustDir(t, work, "f"+string(rune('a'+i))+".md", chunk)
	}
	mustDir(t, work, "one.md", "a")
	mustDir(t, work, "huge.md", strings.Repeat("a", sdlcMaxFileChars*4+1))
	at := func(n int) []SdlcCollect {
		out := make([]SdlcCollect, n)
		for i := range out {
			out[i] = SdlcCollect{ArtifactID: "id", Path: "f" + string(rune('a'+i%11)) + ".md"}
		}
		return out
	}
	// Đúng 10 file 200 000 byte là 2 000 000 byte: còn trong giới hạn.
	if got, err := collectSdlcArtifacts(work, at(10)); err != nil || len(got) != 10 {
		t.Fatalf("10 file: %d, %v", len(got), err)
	}
	// Vượt tổng chỉ vì thêm một byte.
	over := append(at(10), SdlcCollect{ArtifactID: "one", Path: "one.md"})
	if _, err := collectSdlcArtifacts(work, over); err == nil || !strings.Contains(err.Error(), "tổng 2000000 byte") {
		t.Fatalf("vượt tổng: %v", err)
	}
	// 21 file: vượt số file trước khi đọc bất cứ file nào, kể cả khi các file không tồn tại.
	missing := make([]SdlcCollect, sdlcMaxFiles+1)
	for i := range missing {
		missing[i] = SdlcCollect{ArtifactID: "id", Path: "khong-co.md"}
	}
	if _, err := collectSdlcArtifacts(work, missing); err == nil || !strings.Contains(err.Error(), "20 file") {
		t.Fatalf("vượt số file: %v", err)
	}
	if got, err := collectSdlcArtifacts(work, missing[:sdlcMaxFiles]); err != nil || len(got) != 0 {
		t.Fatalf("đúng 20 file thiếu: %d, %v", len(got), err)
	}
	if _, err := collectSdlcArtifacts(work, []SdlcCollect{{ArtifactID: "h", Path: "huge.md"}}); err == nil || !strings.Contains(err.Error(), "quá lớn") {
		t.Fatalf("file khổng lồ: %v", err)
	}
	if _, err := collectSdlcArtifacts(work, []SdlcCollect{{ArtifactID: "x", Path: "fa.md"}, {ArtifactID: "y", Path: "fb.md"}, {ArtifactID: "z", Path: "docs"}}); err != nil {
		t.Fatalf("thư mục không có: %v", err)
	}
}

func TestCollectSdlcArtifactsRejectsEscapesAndSymlinks(t *testing.T) {
	outer := t.TempDir()
	work := filepath.Join(outer, "work")
	if err := os.MkdirAll(filepath.Join(work, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	mustDir(t, outer, "secret.txt", "bí mật")
	for _, rel := range []string{"../secret.txt", "docs/../../secret.txt", "/etc/hosts", `..\secret.txt`, `docs\x.md`} {
		if _, err := collectSdlcArtifacts(work, []SdlcCollect{{ArtifactID: "x", Path: rel}}); err == nil || !strings.Contains(err.Error(), "không hợp lệ") {
			t.Errorf("%q: err = %v", rel, err)
		}
	}
	// Thư mục (không phải file thường) bị từ chối thay vì đọc.
	if _, err := collectSdlcArtifacts(work, []SdlcCollect{{ArtifactID: "d", Path: "docs"}}); err == nil || !strings.Contains(err.Error(), "không phải file thường") {
		t.Errorf("thư mục: %v", err)
	}
	// Agent (hay repo) đặt symlink ra ngoài worktree để lấy file khác của máy.
	symlinkOrSkip(t, filepath.Join(outer, "secret.txt"), filepath.Join(work, "docs", "leak.md"))
	symlinkOrSkip(t, outer, filepath.Join(work, "outside"))
	for _, rel := range []string{"docs/leak.md", "outside/secret.txt"} {
		if got, err := collectSdlcArtifacts(work, []SdlcCollect{{ArtifactID: "x", Path: rel}}); err == nil || !strings.Contains(err.Error(), "symlink") {
			t.Errorf("%q: got = %+v, err = %v", rel, got, err)
		}
	}
}

// --- Chạy trọn vẹn qua Runner với CLI giả ---

// TestFakeSdlcCLI đóng vai CLI của run sdlc: kiểm file seed có trong worktree, rồi ghi file theo HIVE_FAKE_SDLC_WRITE.
// Chạy trong tiến trình con của binary test (Windows không chạy được shell script), nên chỉ hoạt động khi có biến này.
func TestFakeSdlcCLI(t *testing.T) {
	if os.Getenv("HIVE_RUNNER_HELPER_SDLC") != "1" {
		return
	}
	if raw := os.Getenv("HIVE_FAKE_SDLC_EXPECT"); raw != "" {
		var want map[string]string
		if json.Unmarshal([]byte(raw), &want) != nil {
			os.Exit(10)
		}
		for path, content := range want {
			got, err := os.ReadFile(filepath.FromSlash(path))
			if err != nil || string(got) != content {
				os.Exit(11)
			}
		}
	}
	if raw := os.Getenv("HIVE_FAKE_SDLC_WRITE"); raw != "" {
		var files map[string]string
		if json.Unmarshal([]byte(raw), &files) != nil {
			os.Exit(12)
		}
		for path, content := range files {
			p := filepath.FromSlash(path)
			if os.MkdirAll(filepath.Dir(p), 0o755) != nil || os.WriteFile(p, []byte(content), 0o600) != nil {
				os.Exit(13)
			}
		}
	}
	// Biến môi trường trên Windows tối đa ~32 000 ký tự, nên file lớn do CLI giả tự sinh: "đường dẫn=số ký tự".
	if big := os.Getenv("HIVE_FAKE_SDLC_BIG"); big != "" {
		path, n, _ := strings.Cut(big, "=")
		count, err := strconv.Atoi(n)
		if err != nil || os.WriteFile(filepath.FromSlash(path), []byte(strings.Repeat("a", count)), 0o600) != nil {
			os.Exit(17)
		}
	}
	if link := os.Getenv("HIVE_FAKE_SDLC_SYMLINK"); link != "" {
		name, target, _ := strings.Cut(link, "=")
		if os.Symlink(target, name) != nil {
			os.Exit(14)
		}
	}
	if os.Getenv("HIVE_FAKE_SDLC_COMMIT") == "1" {
		if exec.Command("git", "add", "-A").Run() != nil {
			os.Exit(15)
		}
		if exec.Command("git", "-c", "user.name=Runner Test", "-c", "user.email=runner@example.invalid", "commit", "-m", "do agent").Run() != nil {
			os.Exit(16)
		}
	}
	os.Exit(0)
}

func sdlcCommands() map[string]Command {
	return map[string]Command{"codex": {Path: os.Args[0], Args: []string{"-test.run=^TestFakeSdlcCLI$", "--", "helper"}}}
}

func jsonEnv(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func sdlcJob(id, remote, base string, spec *SdlcJob, env map[string]string) Job {
	e := map[string]string{"HIVE_RUNNER_HELPER_SDLC": "1"}
	for k, v := range env {
		e[k] = v
	}
	return Job{RunID: id, Kind: KindSdlc, Attempt: 1, RepoURL: fileURL(remote), BaseBranch: base, Branch: "ai/SDLC", CLI: "codex", Prompt: "soạn", Timeout: 30 * time.Second, SDLC: spec, Env: e}
}

func runSdlc(t *testing.T, data string, job Job) (*Result, []Event, error) {
	t.Helper()
	var events []Event
	err := Runner{DataDir: data, CLICommands: sdlcCommands()}.Run(context.Background(), job, SinkFunc(func(e Event) error { events = append(events, e); return nil }))
	return lastResult(events), events, err
}

// Seed có mặt trước khi CLI chạy, file CLI ghi được thu về trong report.artifacts, và dù agent có commit thì không có
// gì lên remote: run sdlc không commit, không đẩy.
func TestRunnerSdlcSeedsRunsAndCollectsWithoutPublishing(t *testing.T) {
	remote, base := makeRemote(t)
	baseSHA := strings.TrimSpace(mustOut(t, "git", "--git-dir", remote, "rev-parse", "refs/heads/"+base))
	data := t.TempDir()
	spec := &SdlcJob{
		Step:    "spec",
		Seed:    []SdlcSeed{{Path: "docs/baseline.md", Content: "nền của hub"}, {Path: "README", Content: "bản nháp"}},
		Collect: []SdlcCollect{{ArtifactID: "art-spec", Path: "specs/011/spec.md"}, {ArtifactID: "art-none", Path: "specs/011/khong-co.md"}},
	}
	job := sdlcJob("sdlc-ok", remote, base, spec, map[string]string{
		"HIVE_FAKE_SDLC_EXPECT": jsonEnv(t, map[string]string{"docs/baseline.md": "nền của hub", "README": "bản nháp"}),
		"HIVE_FAKE_SDLC_WRITE":  jsonEnv(t, map[string]string{"specs/011/spec.md": "# Đặc tả\n"}),
		"HIVE_FAKE_SDLC_COMMIT": "1",
	})
	res, events, err := runSdlc(t, data, job)
	if err != nil {
		t.Fatal(err)
	}
	if res == nil || res.Status != "succeeded" || res.CommitCount != 0 || len(res.ChangedFiles) != 0 || res.DiffStats != nil {
		t.Fatalf("result = %#v", res)
	}
	if len(res.Artifacts) != 1 || res.Artifacts[0] != (SdlcArtifact{ArtifactID: "art-spec", Path: "specs/011/spec.md", Content: "# Đặc tả\n", SHA256: sha("# Đặc tả\n")}) {
		t.Fatalf("artifacts = %+v", res.Artifacts)
	}
	b, _ := json.Marshal(res)
	var report struct {
		Artifacts []map[string]string `json:"artifacts"`
	}
	if err := json.Unmarshal(b, &report); err != nil || len(report.Artifacts) != 1 || report.Artifacts[0]["artifactId"] != "art-spec" || report.Artifacts[0]["sha256"] != sha("# Đặc tả\n") {
		t.Fatalf("report = %s, %v", b, err)
	}
	for _, e := range events {
		if e.Type == "phase" && e.Phase == "publishing" {
			t.Fatal("run sdlc không được đẩy")
		}
	}
	if refExists(remote, "refs/heads/ai/SDLC") {
		t.Fatal("run sdlc tạo nhánh trên remote")
	}
	if now := strings.TrimSpace(mustOut(t, "git", "--git-dir", remote, "rev-parse", "refs/heads/"+base)); now != baseSHA {
		t.Fatalf("nhánh chính bị đổi: %s → %s", baseSHA, now)
	}
	if _, err := os.Stat(filepath.Join(data, "runs", "sdlc-ok-1")); !os.IsNotExist(err) {
		t.Fatalf("worktree còn lại: %v", err)
	}
}

// Dự án gắn thư mục trên máy (ADR 0020) cũng chạy qua worktree tách HEAD: không tạo nhánh trong repo người dùng, file
// seed không lọt vào thư mục làm việc của họ.
func TestRunnerSdlcOnLocalRepoDetachesWithoutBranch(t *testing.T) {
	remote, base := makeRemote(t)
	repo := userRepo(t, remote)
	job := sdlcJob("sdlc-local", remote, base, &SdlcJob{
		Step:    "spec",
		Seed:    []SdlcSeed{{Path: "seed.md", Content: "s"}},
		Collect: []SdlcCollect{{ArtifactID: "a", Path: "out.md"}},
	}, map[string]string{"HIVE_FAKE_SDLC_WRITE": jsonEnv(t, map[string]string{"out.md": "kết quả"}), "HIVE_FAKE_SDLC_COMMIT": "1"})
	job.LocalRepo = repo
	res, _, err := runSdlc(t, t.TempDir(), job)
	if err != nil || res == nil || res.Status != "succeeded" || len(res.Artifacts) != 1 || res.Artifacts[0].Content != "kết quả" {
		t.Fatalf("result = %#v, err = %v", res, err)
	}
	if refExists(repo, "refs/heads/ai/SDLC") || refExists(remote, "refs/heads/ai/SDLC") {
		t.Fatal("run sdlc tạo nhánh")
	}
	for _, name := range []string{"seed.md", "out.md"} {
		if _, err := os.Stat(filepath.Join(repo, name)); !os.IsNotExist(err) {
			t.Fatalf("%s lọt vào thư mục làm việc của người dùng: %v", name, err)
		}
	}
	if left, _ := os.ReadDir(filepath.Join(repo, ".git", "worktrees")); len(left) != 0 {
		t.Fatalf("còn siêu dữ liệu worktree: %v", left)
	}
}

// Lỗi seed, vượt giới hạn, symlink đều làm run hỏng với thông báo rõ (hub báo bước thất bại), không trả file nào.
func TestRunnerSdlcFailsRunOnBadSeedOrCollect(t *testing.T) {
	remote, base := makeRemote(t)
	data := t.TempDir()
	cases := []struct {
		name    string
		spec    *SdlcJob
		env     map[string]string
		wantErr string
	}{
		{"seed ra ngoài worktree", &SdlcJob{Step: "s", Seed: []SdlcSeed{{Path: "../x.md", Content: "x"}}}, nil, "không hợp lệ"},
		{"seed tuyệt đối", &SdlcJob{Step: "s", Seed: []SdlcSeed{{Path: "/tmp/x.md", Content: "x"}}}, nil, "không hợp lệ"},
		{"collect ra ngoài worktree", &SdlcJob{Step: "s", Collect: []SdlcCollect{{ArtifactID: "a", Path: "../x.md"}}}, nil, "không hợp lệ"},
		{"file quá dài", &SdlcJob{Step: "s", Collect: []SdlcCollect{{ArtifactID: "a", Path: "dai.md"}}}, map[string]string{"HIVE_FAKE_SDLC_BIG": "dai.md=" + strconv.Itoa(sdlcMaxFileChars+1)}, "giới hạn 200000"},
		{"quá 20 file", &SdlcJob{Step: "s", Collect: func() []SdlcCollect {
			out := make([]SdlcCollect, sdlcMaxFiles+1)
			for i := range out {
				out[i] = SdlcCollect{ArtifactID: "a", Path: "x.md"}
			}
			return out
		}()}, nil, "20 file"},
	}
	if runtime.GOOS != "windows" {
		cases = append(cases, struct {
			name    string
			spec    *SdlcJob
			env     map[string]string
			wantErr string
		}{"agent đặt symlink ra ngoài", &SdlcJob{Step: "s", Collect: []SdlcCollect{{ArtifactID: "a", Path: "leak.md"}}}, map[string]string{"HIVE_FAKE_SDLC_SYMLINK": "leak.md=" + filepath.Join(t.TempDir(), "x")}, "symlink"})
	}
	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res, _, err := runSdlc(t, data, sdlcJob("sdlc-bad-"+string(rune('a'+i)), remote, base, tc.spec, tc.env))
			if err == nil || res == nil || res.Status != "failed" || !strings.Contains(res.Error, tc.wantErr) || len(res.Artifacts) != 0 {
				t.Fatalf("result = %#v, err = %v, muốn lỗi chứa %q", res, err, tc.wantErr)
			}
			if refExists(remote, "refs/heads/ai/SDLC") {
				t.Fatal("run sdlc tạo nhánh trên remote")
			}
		})
	}
}

// Hub cũ hay run sdlc không có spec.sdlc vẫn chạy được: không seed, không file thu về, vẫn không đẩy.
func TestRunnerSdlcWithoutSpecStillSucceeds(t *testing.T) {
	remote, base := makeRemote(t)
	res, _, err := runSdlc(t, t.TempDir(), sdlcJob("sdlc-nospec", remote, base, nil, map[string]string{"HIVE_FAKE_SDLC_COMMIT": "1", "HIVE_FAKE_SDLC_WRITE": jsonEnv(t, map[string]string{"x.md": "x"})}))
	if err != nil || res == nil || res.Status != "succeeded" || len(res.Artifacts) != 0 || res.CommitCount != 0 {
		t.Fatalf("result = %#v, err = %v", res, err)
	}
	if refExists(remote, "refs/heads/ai/SDLC") {
		t.Fatal("run sdlc tạo nhánh trên remote")
	}
}
