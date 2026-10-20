package branches

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/tdduydev/xdev-hive/worker/internal/gitexec"
	"github.com/tdduydev/xdev-hive/worker/internal/gitgroups"
)

// fakeForge là máy chủ GitLab/GitHub giả: trả danh sách PR/MR theo đường dẫn API, đếm lời gọi, ghi token nhận được.
type fakeForge struct {
	*httptest.Server
	mu     sync.Mutex
	calls  int
	tokens []string
	status int
	body   map[string]string // đường dẫn API đã mã hoá → JSON
}

func newForge(t *testing.T) *fakeForge {
	t.Helper()
	f := &fakeForge{body: map[string]string{}}
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.calls++
		tok := r.Header.Get("PRIVATE-TOKEN")
		if tok == "" {
			tok = strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		}
		f.tokens = append(f.tokens, tok)
		if f.status != 0 {
			w.WriteHeader(f.status)
			return
		}
		b, ok := f.body[r.URL.EscapedPath()]
		if !ok {
			t.Errorf("gọi lạ %s", r.URL)
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(b))
	}))
	t.Cleanup(f.Close)
	return f
}

func (f *fakeForge) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

// useForge lưu kết nối Git tại máy trỏ vào máy chủ giả và đưa token qua biến môi trường như app.
func useForge(t *testing.T, env Env, kind, url, token string) {
	t.Helper()
	c := gitgroups.Config{Hosts: []gitgroups.Host{{ID: "h1", Kind: kind, URL: url, Name: "giả"}}, Groups: []gitgroups.Group{}}
	b, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(env.ConfigDir, "gitgroups.json"), b, 0o600); err != nil {
		t.Fatal(err)
	}
	tokens, _ := json.Marshal(map[string]string{"h1": token})
	t.Setenv(gitexec.TokensEnv, string(tokens))
}

// pointOrigin đổi origin thành URL của máy chủ giả; insteadOf đưa fetch về bare remote cục bộ, còn
// remote.origin.url vẫn là URL máy chủ để so với kết nối.
func pointOrigin(t *testing.T, folder, bare, url string) {
	t.Helper()
	gitT(t, folder, "config", "url."+bare+".insteadOf", url)
	gitT(t, folder, "remote", "set-url", "origin", url)
}

// pushedBranch tạo nhánh name từ main có một commit, đẩy lên origin; trả đỉnh.
func pushedBranch(t *testing.T, folder, name string) string {
	t.Helper()
	gitT(t, folder, "switch", "-q", "-c", name, "main")
	commit(t, folder, name)
	tip := gitT(t, folder, "rev-parse", "HEAD")
	gitT(t, folder, "push", "-q", "origin", name)
	gitT(t, folder, "switch", "-q", "main")
	return tip
}

func mr(iid int, branch, state, sha, updated string, fork bool) map[string]any {
	src := 7
	if fork {
		src = 99
	}
	return map[string]any{
		"iid": iid, "source_branch": branch, "state": state, "sha": sha, "updated_at": updated,
		"source_project_id": src, "project_id": 7, "web_url": "https://example.invalid/acme/shop/-/merge_requests/" + strconv.Itoa(iid),
	}
}

func jsonOf(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestRemoteHostPath(t *testing.T) {
	cases := map[string][2]string{
		"https://GitLab.example.invalid/acme/Shop.git":     {"gitlab.example.invalid", "acme/Shop"},
		"ssh://git@gitlab.example.invalid:2222/acme/shop":  {"gitlab.example.invalid", "acme/shop"},
		"git@github.com:acme/shop.git":                     {"github.com", "acme/shop"},
		"http://192.0.2.10:8080/gl/acme/sub/shop.git/":     {"192.0.2.10", "gl/acme/sub/shop"},
		`C:\Users\ha\shop`:                                 {"", ""},
		"/home/ha/remote.git":                              {"", ""},
		"file:///home/ha/remote.git":                       {"", ""},
		"https://gitlab.example.invalid":                   {"gitlab.example.invalid", ""},
		"user@host.example.invalid:acme/shop.git":          {"host.example.invalid", "acme/shop"},
		"https://user:secret@gitlab.example.invalid/a/b":   {"gitlab.example.invalid", "a/b"},
		"https://gitlab.example.invalid/acme/shop.git?x=1": {"gitlab.example.invalid", "acme/shop"},
	}
	for in, want := range cases {
		h, p := remoteHostPath(in)
		if h != want[0] || p != want[1] {
			t.Errorf("remoteHostPath(%q) = %q, %q; muốn %q", in, h, p, want)
		}
	}
}

func TestAPIMatchNeedsTokenAndStripsSubpath(t *testing.T) {
	a := &apiSource{
		hosts: []gitgroups.Host{
			{ID: "x", Kind: gitgroups.KindGitLab, URL: "https://gitlab.example.invalid/gl"},
			{ID: "y", Kind: gitgroups.KindGitHub, URL: "https://github.com"},
		},
		tokens: map[string]string{"x": "t1"},
	}
	r, ok := a.match("https://gitlab.example.invalid/gl/acme/shop.git")
	if !ok || r.path != "acme/shop" || r.host.ID != "x" || r.token != "t1" {
		t.Fatalf("match = %+v, %v", r, ok)
	}
	if r, ok := a.match("git@gitlab.example.invalid:acme/shop.git"); !ok || r.path != "acme/shop" {
		t.Fatalf("ssh = %+v, %v", r, ok)
	}
	// Kết nối GitHub không có token: quét không gọi API.
	if _, ok := a.match("git@github.com:acme/shop.git"); ok {
		t.Fatal("không có token mà vẫn khớp")
	}
	if _, ok := a.match("https://other.example.invalid/acme/shop.git"); ok {
		t.Fatal("khác host mà vẫn khớp")
	}
}

// TestScanGitLabEvidence là US6 kịch bản 1 và 3 trên máy chủ GitLab giả.
func TestScanGitLabEvidence(t *testing.T) {
	isolateGit(t)
	bare, _, folder := newRemote(t)
	env := testEnv(t)
	forge := newForge(t)
	token := strings.Join([]string{"glpat", "scanevidence"}, "-")
	useForge(t, env, gitgroups.KindGitLab, forge.URL, token)
	pointOrigin(t, folder, bare, forge.URL+"/acme/shop.git")

	// Squash-merge: main có commit mới, đỉnh nhánh không vào main.
	sq := pushedBranch(t, folder, "ai/sq")
	commit(t, folder, "squash ai/sq")
	multi := pushedBranch(t, folder, "ai/multi")
	closed := pushedBranch(t, folder, "ai/closed")
	// Nhánh đã đóng mà remote đã xoá: commit vẫn còn ở nhánh khác nên không bị chặn chưa đẩy, chỉ thiếu bằng chứng.
	gone := pushedBranch(t, folder, "ai/gone")
	gitT(t, folder, "push", "-q", "origin", gone+":refs/heads/keep/gone", ":refs/heads/ai/gone")
	pushedBranch(t, folder, "ai/fork")
	after := pushedBranch(t, folder, "ai/after")
	gitT(t, folder, "switch", "-q", "ai/after")
	commit(t, folder, "sau khi merge")
	gitT(t, folder, "push", "-q", "origin", "ai/after")
	gitT(t, folder, "switch", "-q", "main")
	mergeNoFF(t, folder, "ai/git")
	gitT(t, folder, "push", "-q", "origin", "main", "ai/git")

	forge.body["/api/v4/projects/acme%2Fshop/merge_requests"] = jsonOf(t, []any{
		mr(1, "ai/sq", "merged", sq, "2026-10-01T00:00:00Z", false),
		// MR cũ đã merge đứng trước MR mở mới hơn: phải lấy theo updated_at, không theo thứ tự trả về.
		mr(2, "ai/multi", "merged", multi, "2026-09-01T00:00:00Z", false),
		mr(3, "ai/multi", "opened", multi, "2026-10-05T00:00:00Z", false),
		mr(4, "ai/closed", "closed", closed, "2026-10-01T00:00:00Z", false),
		mr(5, "ai/gone", "closed", gone, "2026-10-01T00:00:00Z", false),
		mr(6, "ai/fork", "merged", "", "2026-10-01T00:00:00Z", true),
		mr(7, "ai/after", "merged", after, "2026-10-01T00:00:00Z", false),
		mr(8, "ai/git", "opened", "", "2026-10-01T00:00:00Z", false),
	})

	r := scanOne(t, env, folder, false)
	if r.Error != nil || r.APIError != "" {
		t.Fatalf("repo: %+v", r)
	}
	if forge.count() != 1 || forge.tokens[0] != token {
		t.Fatalf("gọi %d lần, token %v", forge.count(), forge.tokens)
	}
	cands, blocked := byBranch(r)

	if c := cands["ai/sq"]; !c.Selected || c.Evidence.Kind != EvidenceMergedAPI || c.Evidence.Provider != "gitlab" ||
		c.Evidence.Number != 1 || c.Evidence.URL == "" {
		t.Fatalf("ai/sq: %+v", c)
	}
	if c := cands["ai/closed"]; c.Selected || c.Evidence.Kind != EvidenceClosedAPI || c.Evidence.Number != 4 {
		t.Fatalf("ai/closed: %+v", c)
	}
	b := blockCode(t, blocked, "ai/multi")
	if ev := blocked["ai/multi"].Evidence; b.Code != BlockPROpen || ev.Kind != EvidenceNone || ev.Note != NotePROpen ||
		ev.Number != 3 || b.Message != "MR !3 của nhánh đang mở." {
		t.Fatalf("ai/multi: %+v %+v", b, ev)
	}
	if b := blockCode(t, blocked, "ai/gone"); b.Code != BlockNoEvidence || !strings.Contains(b.Message, "MR !5 đã đóng") {
		t.Fatalf("ai/gone: %+v", b)
	}
	if b := blockCode(t, blocked, "ai/fork"); b.Code != BlockNoEvidence || blocked["ai/fork"].Evidence.Provider != "" {
		t.Fatalf("ai/fork phải bỏ MR từ fork: %+v %+v", b, blocked["ai/fork"].Evidence)
	}
	if b := blockCode(t, blocked, "ai/after"); b.Code != BlockNoEvidence || !strings.Contains(b.Message, "commit mới hơn") {
		t.Fatalf("ai/after: %+v", b)
	}
	// Đã có bằng chứng git vẫn bị chặn khi MR mới nhất đang mở (FR-020); bằng chứng giữ là của git.
	if b := blockCode(t, blocked, "ai/git"); b.Code != BlockPROpen || blocked["ai/git"].Evidence.Kind != EvidenceMergedGit {
		t.Fatalf("ai/git: %+v %+v", b, blocked["ai/git"].Evidence)
	}
}

func TestScanGitHubSquashMerged(t *testing.T) {
	isolateGit(t)
	bare, _, folder := newRemote(t)
	env := testEnv(t)
	forge := newForge(t)
	useForge(t, env, gitgroups.KindGitHub, forge.URL, strings.Join([]string{"ghp", "scanevidence"}, "_"))
	pointOrigin(t, folder, bare, forge.URL+"/acme/shop.git")
	tip := pushedBranch(t, folder, "ai/sq")
	commit(t, folder, "squash")
	gitT(t, folder, "push", "-q", "origin", "main")
	forge.body["/api/v3/repos/acme/shop/pulls"] = jsonOf(t, []any{
		map[string]any{"number": 4, "state": "open", "updated_at": "2026-10-03T00:00:00Z",
			"head": map[string]any{"ref": "ai/sq", "sha": tip, "repo": map[string]any{"id": 2}}, "base": map[string]any{"repo": map[string]any{"id": 1}}},
		map[string]any{"number": 3, "state": "closed", "merged_at": "2026-10-02T00:00:00Z", "updated_at": "2026-10-02T00:00:00Z",
			"html_url": "https://example.invalid/acme/shop/pull/3",
			"head":     map[string]any{"ref": "ai/sq", "sha": tip, "repo": map[string]any{"id": 1}}, "base": map[string]any{"repo": map[string]any{"id": 1}}},
	})
	r := scanOne(t, env, folder, false)
	cands, _ := byBranch(r)
	if c := cands["ai/sq"]; r.APIError != "" || !c.Selected || c.Evidence != (Evidence{Kind: EvidenceMergedAPI, Provider: "github", Number: 3, URL: "https://example.invalid/acme/shop/pull/3"}) {
		t.Fatalf("ai/sq: %+v, %+v", c, r)
	}
}

// TestScanAPIUnauthorizedOncePerHost là US6 kịch bản 2: token sai thì repo có nhãn, dùng bằng chứng git, không lộ
// token, và repo khác cùng máy chủ trong lượt không gọi lại.
func TestScanAPIUnauthorizedOncePerHost(t *testing.T) {
	isolateGit(t)
	env := testEnv(t)
	forge := newForge(t)
	forge.status = http.StatusUnauthorized
	token := strings.Join([]string{"glpat", "revokedtoken"}, "-")
	useForge(t, env, gitgroups.KindGitLab, forge.URL, token)
	var folders []string
	for _, name := range []string{"shop", "api"} {
		bare, _, folder := newRemote(t)
		pointOrigin(t, folder, bare, forge.URL+"/acme/"+name+".git")
		mergeNoFF(t, folder, "ai/git")
		gitT(t, folder, "push", "-q", "origin", "main")
		pushedBranch(t, folder, "ai/sq")
		folders = append(folders, folder)
	}
	var repos []ScanRepo
	var steps []string
	for _, ev := range scanAll(t, t.Context(), env, ScanOptions{Folders: folders}) {
		if ev.Type == EventRepo {
			repos = append(repos, *ev.Repo)
		}
		if ev.Type == EventProgress {
			steps = append(steps, ev.Step)
		}
	}
	if forge.count() != 1 {
		t.Fatalf("gọi %d lần, muốn 1", forge.count())
	}
	if len(repos) != 2 || !strings.Contains(strings.Join(steps, ","), StepAPI) {
		t.Fatalf("repos %d, bước %v", len(repos), steps)
	}
	for _, r := range repos {
		if r.Error != nil || !strings.HasPrefix(r.APIError, "Không đọc được PR/MR: ") || !strings.Contains(r.APIError, "401") ||
			strings.Contains(r.APIError, token) {
			t.Fatalf("repo %s: %+v", r.Folder, r)
		}
		cands, blocked := byBranch(r)
		if cands["ai/git"].Evidence.Kind != EvidenceMergedGit || blockCode(t, blocked, "ai/sq").Code != BlockNoEvidence {
			t.Fatalf("phải dùng bằng chứng git: %+v", r)
		}
	}
}

func TestScanSkipsAPIWithoutTokenOrNeed(t *testing.T) {
	isolateGit(t)
	bare, _, folder := newRemote(t)
	env := testEnv(t)
	forge := newForge(t)
	pointOrigin(t, folder, bare, forge.URL+"/acme/shop.git")
	mergeNoFF(t, folder, "ai/git")
	gitT(t, folder, "push", "-q", "origin", "main")

	// Có token nhưng mọi nhánh đã có bằng chứng git: không gọi.
	useForge(t, env, gitgroups.KindGitLab, forge.URL, "t")
	if r := scanOne(t, env, folder, false); r.APIError != "" || len(r.Candidates) != 1 {
		t.Fatalf("repo: %+v", r)
	}
	// Có nhánh thiếu bằng chứng mà không có token: không gọi, không nhãn.
	pushedBranch(t, folder, "ai/sq")
	t.Setenv(gitexec.TokensEnv, "")
	if r := scanOne(t, env, folder, false); r.APIError != "" {
		t.Fatalf("repo: %+v", r)
	}
	// Biến token hỏng: nhãn lỗi, không in nội dung biến.
	t.Setenv(gitexec.TokensEnv, "{không-phải-json")
	if r := scanOne(t, env, folder, false); !strings.Contains(r.APIError, "HIVE_GIT_TOKENS") || strings.Contains(r.APIError, "không-phải") {
		t.Fatalf("repo: %+v", r)
	}
	if forge.count() != 0 {
		t.Fatalf("gọi %d lần", forge.count())
	}
}
