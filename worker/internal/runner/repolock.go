package runner

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"strings"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/procattr"
	"github.com/tdduydev/xdev-hive/worker/internal/repolock"
)

// Khoá repo nằm ở gói repolock để lệnh `hive-worker branches` của app desktop khoá cùng file với run. Các wrapper giữ
// tên cũ cho code và test của runner.

const filePollInterval = repolock.FilePollInterval

func lockRepo(ctx context.Context, cache string) (func(), error) {
	return repolock.LockRepo(ctx, cache)
}

func lockFile(ctx context.Context, path string) (*os.File, error) {
	return repolock.LockFile(ctx, path)
}

func tryLockFile(f *os.File) (bool, error) { return repolock.TryLockFile(f) }

func unlockFile(f *os.File) error { return repolock.UnlockFile(f) }

// gitLockRetries và gitLockBackoff giới hạn việc thử lại: git của tiến trình ngoài worker (người dùng chạy tay, gc tự
// động) vẫn có thể giữ file .lock trong chốc lát dù worker đã tự tuần tự hoá.
const gitLockRetries = 5

var gitLockBackoff = 200 * time.Millisecond

// gitWrite chạy một lệnh git ghi vào repo cache dưới khoá của cache. dir là thư mục chạy lệnh (cache, DataDir khi
// clone, hoặc worktree khi push).
func gitWrite(ctx context.Context, cache, dir string, args ...string) error {
	return gitWriteAuth(ctx, gitAuth{}, cache, dir, args...)
}

func gitWriteAuth(ctx context.Context, auth gitAuth, cache, dir string, args ...string) error {
	unlock, err := lockRepo(ctx, cache)
	if err != nil {
		return err
	}
	defer unlock()
	return gitRetryAuth(ctx, auth, dir, args...)
}

func gitRetryLocked(ctx context.Context, dir string, args ...string) error {
	return gitRetryAuth(ctx, gitAuth{}, dir, args...)
}

// gitRetryAuth chạy git với token của run khi auth có: token chỉ nằm trong môi trường của git (askpass đọc), không trong
// tham số hay URL, và stderr đã che token trước khi ra log của worker.
func gitRetryAuth(ctx context.Context, auth gitAuth, dir string, args ...string) error {
	full, env := args, []string(nil)
	if auth.git != nil {
		full, env = auth.git.Prepare(auth.host, args...)
	}
	for attempt := 1; ; attempt++ {
		var stderr bytes.Buffer
		c := procattr.CommandContext(ctx, "git", full...)
		c.Dir = dir
		c.Env = env
		c.Stdout = io.Discard
		out := auth.mask.Writer(io.MultiWriter(os.Stderr, &stderr))
		c.Stderr = out
		err := c.Run()
		_ = out.Flush()
		if err == nil || attempt >= gitLockRetries || ctx.Err() != nil || !isGitLockError(stderr.String()) {
			return err
		}
		select {
		case <-ctx.Done():
			return errors.Join(err, ctx.Err())
		case <-time.After(time.Duration(attempt) * gitLockBackoff):
		}
	}
}

// isGitLockError nhận ra lỗi do file .lock của git đang bị giữ. Lỗi khác (mạng, nhánh không có, xác thực) không thử
// lại để không che lỗi thật và không làm run chậm vô ích.
func isGitLockError(stderr string) bool {
	s := strings.ToLower(stderr)
	return strings.Contains(s, "cannot lock ref") ||
		strings.Contains(s, "could not lock config file") ||
		(strings.Contains(s, "unable to create") && strings.Contains(s, ".lock': file exists")) ||
		// git 2.53 báo ref đang bị khoá trong fetch theo lô bằng câu này thay cho "cannot lock ref".
		(strings.Contains(s, "fetching ref") && strings.Contains(s, "reference already exists"))
}
