package branches

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func collect(f func(Emit)) []Event {
	var got []Event
	f(func(ev Event) { got = append(got, ev) })
	return got
}

func TestFetchRecordsRemotes(t *testing.T) {
	isolateGit(t)
	_, seed, folder := newRemote(t)
	gitT(t, seed, "switch", "-q", "-c", "ai/old")
	gitT(t, seed, "push", "-q", "origin", "ai/old")
	gitT(t, folder, "fetch", "-q")
	gitT(t, seed, "push", "-q", "origin", "--delete", "ai/old")
	gitT(t, seed, "switch", "-q", "main")
	commit(t, seed, "mới")
	gitT(t, seed, "push", "-q", "origin", "main")
	// Remote thứ hai trỏ tới thư mục không có: lỗi riêng của nó, không làm hỏng origin.
	gitT(t, folder, "remote", "add", "broken", filepath.Join(t.TempDir(), "không-có.git"))

	env := testEnv(t)
	at := time.Date(2026, 10, 20, 10, 15, 0, 0, time.FixedZone("ICT", 7*3600))
	env.Now = func() time.Time { return at }
	got := collect(func(emit Emit) { Fetch(context.Background(), env, folder, nil, emit) })
	if len(got) != 3 {
		t.Fatalf("muốn 2 progress và done: %+v", got)
	}
	if p := got[0]; p.Type != EventProgress || p.Step != StepFetch || p.Remote != "broken" || p.Result != ResultFailed ||
		p.Error.Code != CodeFetchFailed || p.Error.Remote != "broken" {
		t.Fatalf("remote lỗi: %+v %+v", p, p.Error)
	}
	if p := got[1]; p.Remote != "origin" || p.Result != ResultDone || p.Error != nil {
		t.Fatalf("origin: %+v", p)
	}
	done := got[2]
	if done.Type != EventDone || done.Error != nil || len(done.Fetched) != 1 || done.Fetched[0] != "origin" ||
		len(done.FetchFailed) != 1 || done.FetchFailed[0].Auth || done.FetchedAt != "2026-10-20T03:15:00Z" {
		t.Fatalf("done: %+v", done)
	}
	if gitT(t, folder, "rev-parse", "refs/remotes/origin/main") != gitT(t, seed, "rev-parse", "main") {
		t.Fatal("origin/main phải lên bản mới")
	}
	if _, err := gitTry(folder, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/ai/old"); err == nil {
		t.Fatal("--prune phải gỡ ref của nhánh đã xoá trên remote")
	}
}

func TestFetchAllFailedHasEmptyFetched(t *testing.T) {
	isolateGit(t)
	repo := newRepo(t)
	gitT(t, repo, "remote", "add", "origin", filepath.Join(t.TempDir(), "không-có.git"))
	got := collect(func(emit Emit) { Fetch(context.Background(), testEnv(t), repo, []string{"origin"}, emit) })
	done := got[len(got)-1]
	raw, _ := json.Marshal(done)
	if !strings.Contains(string(raw), `"fetched":[]`) || strings.Contains(string(raw), "fetchedAt") {
		t.Fatalf("không remote nào được: %s", raw)
	}
}

// --remote chỉ nhận tên đã cấu hình: URL hay cờ của git không được đi tới lệnh fetch.
func TestFetchUnknownRemote(t *testing.T) {
	isolateGit(t)
	_, _, folder := newRemote(t)
	for _, r := range []string{"nope", "--upload-pack=x", filepath.Join(t.TempDir(), "x.git")} {
		got := collect(func(emit Emit) { Fetch(context.Background(), testEnv(t), folder, []string{r}, emit) })
		if len(got) != 1 || got[0].Error == nil || got[0].Error.Code != CodeNotFound {
			t.Fatalf("%q: %+v", r, got)
		}
	}
}

func TestFetchNotRepoAndCancelled(t *testing.T) {
	isolateGit(t)
	got := collect(func(emit Emit) { Fetch(context.Background(), testEnv(t), t.TempDir(), nil, emit) })
	if got[0].Error == nil || got[0].Error.Code != CodeNotRepo {
		t.Fatalf("thư mục không phải repo: %+v", got)
	}

	_, _, folder := newRemote(t)
	ctx, cancel := context.WithCancel(context.Background())
	env := testEnv(t)
	outcome, stop := env.fetchRemotes(ctx, folder, []string{"origin"}, func(Event) { cancel() })
	if stop != nil || len(outcome.Fetched) != 1 {
		t.Fatalf("remote đầu đã xong trước khi huỷ: %+v %+v", outcome, stop)
	}
	outcome, stop = env.fetchRemotes(ctx, folder, []string{"origin"}, func(Event) {})
	if stop == nil || stop.Code != CodeCancelled || len(outcome.Fetched) != 0 {
		t.Fatalf("đã huỷ thì dừng: %+v %+v", outcome, stop)
	}
}

func TestHostOf(t *testing.T) {
	cases := map[string]string{
		"https://GitHub.example.invalid/org/repo.git":  "github.example.invalid",
		"https://user@192.0.2.10:8443/x.git":           "192.0.2.10",
		"ssh://git@git.example.invalid:2222/org/r.git": "git.example.invalid",
		"git@git.example.invalid:org/r.git":            "git.example.invalid",
		"git.example.invalid:r.git":                    "git.example.invalid",
		"file:///tmp/r.git":                            "",
		"/tmp/r.git":                                   "",
		"../r.git":                                     "",
		`C:\repos\r.git`:                               "",
		"C:/repos/r.git":                               "",
	}
	for raw, want := range cases {
		if got := hostOf(raw); got != want {
			t.Fatalf("%q: %q, muốn %q", raw, got, want)
		}
	}
}
