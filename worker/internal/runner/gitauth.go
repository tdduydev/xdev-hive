package runner

import (
	"context"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/gitexec"
	"github.com/tdduydev/xdev-hive/worker/internal/procattr"
	"github.com/tdduydev/xdev-hive/worker/internal/secretmask"
)

// GitCredential là token git hub cấp riêng cho một lần thử của run (lease.git, spec 027 R9).
type GitCredential struct {
	Host, Username, Token string
	// Repo là "owner/name" (GitLab có thể nhiều cấp nhóm) của repo token được phép dùng.
	Repo      string
	ExpiresAt time.Time
}

// RunGit giữ token git của một run. Hub cấp lại token trước khi hết hạn (git_token) trong lúc run còn chạy, nên mỗi lệnh
// git mạng đọc token tại lúc chạy thay vì lúc nhận lease.
type RunGit struct {
	mu   sync.Mutex
	cred GitCredential
	// askpass thay os.Executable() làm GIT_ASKPASS; test đặt chính binary test.
	askpass string
}

func NewRunGit(c GitCredential) *RunGit { return &RunGit{cred: c} }

// Set thay token đang dùng; lệnh git đang chạy giữ token cũ tới khi xong.
func (g *RunGit) Set(c GitCredential) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.cred = c
}

func (g *RunGit) Credential() GitCredential {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.cred
}

// gitAuth là cách chạy một lệnh git mạng của run. Giá trị rỗng là dùng thông tin git của máy như trước spec 027.
type gitAuth struct {
	git  *gitexec.Git
	host string
	mask *secretmask.Masker
}

// auth trả cách chạy lệnh git tới remote. Token chỉ đi với URL HTTPS đúng máy chủ và đúng repo của token: submodule hay
// chuyển hướng sang máy chủ khác không nhận token, và repo khác (repo tham gia của run SDLC) vẫn cần credential helper
// của máy, mà lệnh có token thì đã tắt helper.
func (g *RunGit) auth(remote string) gitAuth {
	if g == nil {
		return gitAuth{}
	}
	c := g.Credential()
	if c.Token == "" || c.Host == "" {
		return gitAuth{}
	}
	u, err := url.Parse(strings.TrimSpace(remote))
	if err != nil || !strings.EqualFold(u.Scheme, "https") {
		return gitAuth{}
	}
	if !strings.EqualFold(u.Host, c.Host) && !strings.EqualFold(u.Hostname(), c.Host) {
		return gitAuth{}
	}
	if c.Repo != "" && !strings.EqualFold(repoPath(u.Path), repoPath(c.Repo)) {
		return gitAuth{}
	}
	askpass := g.askpass
	if askpass == "" {
		if askpass, err = os.Executable(); err != nil {
			return gitAuth{}
		}
	}
	return gitAuth{
		git:  &gitexec.Git{Askpass: askpass, Token: c.Token, User: c.Username},
		host: u.Host,
		mask: secretmask.New([]string{c.Token}, secretmask.WithMask(secretmask.Stars)),
	}
}

func repoPath(p string) string {
	return strings.TrimSuffix(strings.Trim(p, "/"), ".git")
}

// remoteURL đọc URL của origin trong dir (lệnh tại máy, không gọi mạng). push đọc pushurl nếu repo đặt riêng.
func remoteURL(ctx context.Context, dir string, push bool) string {
	args := []string{"remote", "get-url"}
	if push {
		args = append(args, "--push")
	}
	c := procattr.CommandContext(ctx, "git", append(args, "origin")...)
	c.Dir = dir
	out, err := c.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// originAuth là auth của lệnh fetch/push qua origin của dir. Không có token thì không đọc remote.
func (g *RunGit) originAuth(ctx context.Context, dir string, push bool) gitAuth {
	if g == nil || g.Credential().Token == "" {
		return gitAuth{}
	}
	return g.auth(remoteURL(ctx, dir, push))
}
