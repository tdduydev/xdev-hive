package gitgroups

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/tdduydev/xdev-hive/worker/internal/gitexec"
)

func TestBatchStopsCallingServerAfterAuthFailure(t *testing.T) {
	cases := map[string]bool{"token": false}
	if runtime.GOOS != "windows" {
		cases["git"] = true
	}
	for name, native := range cases {
		t.Run(name, func(t *testing.T) {
			isolateGit(t)
			if native {
				gitT(t, "", "config", "--global", "credential.helper", `!f() { printf 'username=test\npassword=expired\n'; }; f`)
			}
			var withAuth atomic.Int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "" {
					withAuth.Add(1)
				}
				w.Header().Set("WWW-Authenticate", `Basic realm="test"`)
				w.WriteHeader(http.StatusUnauthorized)
			}))
			defer srv.Close()
			g := Group{Root: filepath.Join(t.TempDir(), "code")}
			for i := range 6 {
				g.Repos = append(g.Repos, Repo{Path: fmt.Sprintf("acme/r%d", i), HTTPURL: fmt.Sprintf("%s/acme/r%d.git", srv.URL, i)})
			}
			got, done := runSync(t, Sync{Git: gitexec.Git{UseGitCredentials: native}, Group: g, Concurrency: 2}, context.Background(), ActionClone)
			// Chỉ các repo đang chạy cùng lúc với lần bị từ chối đầu tiên mới gọi máy chủ.
			if done.Summary[ResultFailed] < 1 || done.Summary[ResultFailed] > 2 || done.Summary[ResultSkipped] != 6-done.Summary[ResultFailed] {
				t.Fatalf("tổng = %+v", done.Summary)
			}
			if native && withAuth.Load() > 2 {
				t.Fatalf("gửi đăng nhập sai %d lần", withAuth.Load())
			}
			for path, e := range got {
				switch e.Result {
				case ResultSkipped:
					if e.Message != authStopped {
						t.Errorf("%s bỏ qua = %q", path, e.Message)
					}
				case ResultFailed:
					if native && !strings.Contains(e.Message, "từ chối đăng nhập") {
						t.Errorf("%s lỗi = %q", path, e.Message)
					}
				}
			}
		})
	}
}
