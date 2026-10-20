package branches

import (
	"context"
	"net/url"
	"slices"
	"strings"
	"time"
)

// StepFetch là bước fetch trong sự kiện progress.
const StepFetch = "fetch"

// Kết quả của một bước trong sự kiện progress.
const (
	ResultDone   = "done"
	ResultFailed = "failed"
)

// FetchOutcome là kết quả fetch các remote của một repo; scan, pull dùng lại để biết remote nào có ref mới (FR-027).
type FetchOutcome struct {
	Fetched []string
	Failed  []FetchFailure
	At      time.Time
}

// Fetch là job `fetch` (FR-004): fetch từng remote, mỗi remote một progress, cuối là done kèm remote fetch được.
// remotes rỗng là mọi remote của `git remote`.
func Fetch(ctx context.Context, env Env, folder string, remotes []string, emit Emit) {
	done := Event{Type: EventDone, Folder: folder, Fetched: []string{}, FetchFailed: []FetchFailure{}}
	if !isDir(folder) {
		done.Error = notRepo(folder)
		emit(done)
		return
	}
	all, err := env.remotes(ctx, folder)
	if err != nil {
		done.Error = repoError(folder, err)
		emit(done)
		return
	}
	if len(remotes) == 0 {
		remotes = all
	}
	for _, r := range remotes {
		// Chỉ nhận tên remote đã cấu hình: --remote là URL hay "--upload-pack=…" thì git sẽ gọi tới chỗ khác.
		if !slices.Contains(all, r) {
			done.Error = &Error{Code: CodeNotFound, Message: "Không có remote " + r + " trong repo.", Remote: r}
			emit(done)
			return
		}
	}
	out, stop := env.fetchRemotes(ctx, folder, remotes, emit)
	done.Fetched = append(done.Fetched, out.Fetched...)
	done.FetchFailed = append(done.FetchFailed, out.Failed...)
	if len(out.Fetched) > 0 {
		done.FetchedAt = out.At.UTC().Format(time.RFC3339)
	}
	done.Error = stop
	emit(done)
}

func (e Env) remotes(ctx context.Context, dir string) ([]string, error) {
	out, err := e.read(ctx, dir, "remote")
	if err != nil {
		return nil, err
	}
	var names []string
	for _, n := range strings.Split(out, "\n") {
		if n = strings.TrimSpace(n); n != "" {
			names = append(names, n)
		}
	}
	return names, nil
}

// fetchRemotes fetch lần lượt từng remote, ngoài khoá repo: fetch chỉ ghi ref remote, git tự khoá từng ref, mà giữ khoá
// 120 giây thì chặn worker. Lỗi đăng nhập thì bỏ các remote khác cùng máy chủ trong lượt (FR-042). Trả lỗi khác nil
// chỉ khi bị huỷ hay hết --timeout của cả lệnh; lỗi của một remote nằm trong Failed.
func (e Env) fetchRemotes(ctx context.Context, dir string, remotes []string, emit Emit) (FetchOutcome, *Error) {
	out := FetchOutcome{Fetched: []string{}, Failed: []FetchFailure{}}
	denied := map[string]bool{}
	for _, r := range remotes {
		if err := ctx.Err(); err != nil {
			return out, gitFailure(err)
		}
		host := e.remoteHost(ctx, dir, r)
		var ferr *Error
		if host != "" && denied[host] {
			ferr = &Error{Code: CodeAuth, Message: "Remote từ chối đăng nhập.", Remote: r,
				Detail: "Bỏ qua vì máy chủ " + host + " vừa từ chối đăng nhập."}
		} else if _, err := e.git(FetchTimeout).Run(ctx, dir, "", "fetch", "--prune", "--quiet", "--end-of-options", r); err != nil {
			if ctx.Err() != nil {
				return out, gitFailure(ctx.Err())
			}
			ferr = gitFailure(err)
			ferr.Remote = r
			if ferr.Code == CodeAuth && host != "" {
				denied[host] = true
			} else if ferr.Code != CodeAuth && ferr.Code != CodeTimeout {
				ferr.Code, ferr.Message = CodeFetchFailed, "Không fetch được "+r+"."
			}
		}
		ev := Event{Type: EventProgress, Folder: dir, Step: StepFetch, Remote: r, Result: ResultDone}
		if ferr != nil {
			ev.Result, ev.Error = ResultFailed, ferr
			out.Failed = append(out.Failed, FetchFailure{Remote: r, Message: ferr.Message, Auth: ferr.Code == CodeAuth})
		} else {
			out.Fetched = append(out.Fetched, r)
			out.At = e.now()
		}
		emit(ev)
	}
	return out, nil
}

// remoteHost là máy chủ của URL remote, để nhận ra hai remote cùng máy chủ; rỗng khi là đường dẫn trên máy hay
// không đọc được.
func (e Env) remoteHost(ctx context.Context, dir, remote string) string {
	out, err := e.read(ctx, dir, "remote", "get-url", "--end-of-options", remote)
	if err != nil {
		return ""
	}
	return hostOf(strings.TrimSpace(out))
}

// hostOf đọc https://host/…, ssh://user@host:22/… và dạng scp user@host:path của git.
func hostOf(raw string) string {
	if strings.Contains(raw, "://") {
		u, err := url.Parse(raw)
		if err != nil || u.Scheme == "file" {
			return ""
		}
		return strings.ToLower(u.Hostname())
	}
	// Dạng scp: có ":" trước "/" đầu tiên. C:\repo, C:/repo trên Windows là đường dẫn, không phải máy chủ.
	before, _, ok := strings.Cut(raw, ":")
	if !ok || strings.Contains(before, "/") || strings.Contains(before, `\`) || len(before) <= 1 {
		return ""
	}
	if i := strings.LastIndex(before, "@"); i >= 0 {
		before = before[i+1:]
	}
	return strings.ToLower(strings.Trim(before, "[]"))
}
