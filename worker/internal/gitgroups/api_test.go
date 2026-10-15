package gitgroups

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

func TestGitLabListReposFollowsPagesWithSubgroups(t *testing.T) {
	var tokens []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tokens = append(tokens, r.Header.Get("PRIVATE-TOKEN"))
		if r.URL.EscapedPath() != "/api/v4/groups/acme%2Fpay/projects" {
			http.NotFound(w, r)
			return
		}
		if r.URL.Query().Get("include_subgroups") != "true" {
			t.Errorf("thiếu include_subgroups: %s", r.URL.RawQuery)
		}
		page, _ := strconv.Atoi(r.URL.Query().Get("page"))
		if page == 0 {
			page = 1
		}
		var batch []map[string]any
		for i := range 2 {
			n := (page-1)*2 + i
			batch = append(batch, map[string]any{
				"name": fmt.Sprintf("r%d", n), "path_with_namespace": fmt.Sprintf("acme/pay/sub/r%d", n),
				"default_branch": "main", "archived": n == 3,
				"http_url_to_repo": "https://gl/acme/pay/sub/r" + strconv.Itoa(n) + ".git",
			})
		}
		if page < 3 {
			w.Header().Set("X-Next-Page", strconv.Itoa(page+1))
		}
		_ = json.NewEncoder(w).Encode(batch)
	}))
	defer srv.Close()
	c := Client{Host: Host{Kind: KindGitLab, URL: srv.URL}, Token: "glpat-x"}
	repos, err := c.ListRepos(context.Background(), "acme/pay")
	if err != nil {
		t.Fatal(err)
	}
	if len(repos) != 6 || repos[0].Path != "acme/pay/sub/r0" || !repos[3].Archived || repos[5].DefaultBranch != "main" {
		t.Fatalf("repos = %+v", repos)
	}
	if len(tokens) != 3 || tokens[2] != "glpat-x" {
		t.Fatalf("token gửi = %v", tokens)
	}
	if _, err := c.ListRepos(context.Background(), "khong/co"); err == nil || !strings.Contains(err.Error(), "Không tìm thấy group") {
		t.Fatalf("group mất: %v", err)
	}
}

func TestGitHubListReposFallsBackToUserAndFollowsLink(t *testing.T) {
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer ghp_x" {
			t.Errorf("Authorization = %q", got)
		}
		switch {
		case strings.HasPrefix(r.URL.Path, "/api/v3/orgs/"):
			http.NotFound(w, r)
		case r.URL.Path == "/api/v3/user":
			_, _ = w.Write([]byte(`{"login":"someone-else"}`))
		case r.URL.Path == "/api/v3/users/ha/repos":
			if r.URL.Query().Get("page") == "" {
				w.Header().Set("Link", fmt.Sprintf(`<%s/api/v3/users/ha/repos?page=2>; rel="next", <%s/x>; rel="last"`, srv.URL, srv.URL))
				_, _ = w.Write([]byte(`[{"name":"b","full_name":"ha/b","default_branch":"main","size":5,"clone_url":"https://ghe/ha/b.git","ssh_url":"git@ghe:ha/b.git"}]`))
				return
			}
			// Link sang máy chủ khác không được theo: token sẽ lọt ra ngoài.
			w.Header().Set("Link", `<https://evil.example/steal>; rel="next"`)
			_, _ = w.Write([]byte(`[{"name":"a","full_name":"ha/a","archived":true,"clone_url":"https://ghe/ha/a.git"}]`))
		default:
			t.Errorf("gọi lạ %s", r.URL)
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	c := Client{Host: Host{Kind: KindGitHub, URL: srv.URL}, Token: "ghp_x"}
	repos, err := c.ListRepos(context.Background(), "ha")
	if err != nil {
		t.Fatal(err)
	}
	if len(repos) != 2 || repos[0].Path != "ha/a" || !repos[0].Archived || repos[1].SSHURL != "git@ghe:ha/b.git" || !repos[0].Empty {
		t.Fatalf("repos = %+v", repos)
	}
}

func TestUserReportsBadToken(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()
	_, err := Client{Host: Host{Kind: KindGitLab, URL: srv.URL}, Token: "sai"}.User(context.Background())
	if err == nil || !strings.Contains(err.Error(), "Token không dùng được") {
		t.Fatalf("err = %v", err)
	}
}

func TestNativeCredentialIsNotSentThroughAPIRedirect(t *testing.T) {
	var received bool
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received = true
	}))
	defer target.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusFound)
	}))
	defer source.Close()
	_, err := (Client{Host: Host{Kind: KindGitLab, URL: source.URL, AuthMode: "git"}, Token: "fake-secret"}).User(context.Background())
	if err == nil || received {
		t.Fatal("API redirect was followed with a credential")
	}
}

func TestSuggestGitLabGroups(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("search") != "pay" || r.URL.Query().Get("min_access_level") != "10" {
			t.Errorf("query = %s", r.URL.RawQuery)
		}
		_, _ = w.Write([]byte(`[{"full_path":"acme/pay"},{"full_path":"acme/pay/sub"}]`))
	}))
	defer srv.Close()
	got, err := Client{Host: Host{Kind: KindGitLab, URL: srv.URL}, Token: "t"}.Suggest(context.Background(), "pay")
	if err != nil || strings.Join(got, ",") != "acme/pay,acme/pay/sub" {
		t.Fatalf("gợi ý = %v, %v", got, err)
	}
}

func TestAPIBase(t *testing.T) {
	cases := map[string]Host{
		"https://api.github.com":        {Kind: KindGitHub, URL: "https://github.com"},
		"https://ghe.acme.vn/api/v3":    {Kind: KindGitHub, URL: "https://ghe.acme.vn"},
		"https://git.acme.vn/gl/api/v4": {Kind: KindGitLab, URL: "https://git.acme.vn/gl"},
	}
	for want, h := range cases {
		if got := apiBase(h); got != want {
			t.Errorf("apiBase(%v) = %s", h, got)
		}
	}
}
