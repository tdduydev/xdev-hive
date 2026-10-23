package channel

import (
	"context"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/runner"
)

// capRunGitToken: worker dùng được token git theo run trong lease.git (spec 027 R9). Hub chỉ cấp token cho máy khai
// capability này, và chính sách git.requireRunGitToken chỉ giao run cho máy có nó.
const capRunGitToken = "run_git_token"

const (
	// gitTokenRefreshBefore: xin token mới trước khi hết hạn chừng này, đủ cho hub gọi GitHub/GitLab và cho lệnh git đang
	// chạy (push lớn) xong bằng token cũ.
	gitTokenRefreshBefore = 5 * time.Minute
	// gitTokenRetry: hub không trả lời (mất kết nối, GitHub lỗi) thì xin lại sau chừng này, không dồn gói.
	gitTokenRetry = time.Minute
)

// runCredential đổi lease.git thành token của runner. expiresAt hỏng thì vẫn dùng token, chỉ không xin token mới.
func runCredential(c GitCredential) runner.GitCredential {
	expires, _ := time.Parse(time.RFC3339Nano, c.ExpiresAt)
	return runner.GitCredential{Host: c.Host, Username: c.Username, Token: c.Token, Repo: c.Repo, ExpiresAt: expires}
}

// refreshGit xin token git mới cho run khi token sắp hết hạn, tới khi run xong. Chỉ chạy khi lease có git: hub cũ không
// biết git_token_request và đóng kết nối.
func (j *jobs) refreshGit(ctx context.Context, run *activeRun, send func(any) error) {
	var asked time.Time
	for {
		expires := run.git.Credential().ExpiresAt
		if expires.IsZero() {
			return
		}
		now := j.now()
		wait := expires.Add(-gitTokenRefreshBefore).Sub(now)
		if wait <= 0 {
			// Hub có thể trả token còn ít hạn (cấp lại token đang có); không xin dồn mỗi lần nhận.
			if since := now.Sub(asked); !asked.IsZero() && since < gitTokenRetry {
				wait = gitTokenRetry - since
			} else {
				err := send(GitTokenRequest{Type: "git_token_request", V: protocolVersion, ID: newID(), RunID: run.runID, Attempt: run.attempt})
				if err != nil {
					j.log.Debug("Chưa xin được token git mới, sẽ thử lại", "run", run.runID, "error", err)
				}
				asked, wait = now, gitTokenRetry
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-run.gitWake:
		case <-j.after(wait):
		}
	}
}

// onGitToken thay token của run đang chạy. Run đã xong hay khác lần thử thì bỏ: token đó không ai dùng nữa.
func (j *jobs) onGitToken(m *GitToken) {
	j.mu.Lock()
	run := j.active[m.RunID]
	j.mu.Unlock()
	if run == nil || run.attempt != m.Attempt || run.git == nil {
		j.log.Debug("Bỏ token git của run không chạy trên máy", "run", m.RunID, "attempt", m.Attempt)
		return
	}
	run.git.Set(runCredential(m.Git))
	select {
	case run.gitWake <- struct{}{}:
	default:
	}
}
