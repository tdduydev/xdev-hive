package runner

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/procattr"
)

// Các run cùng repo dùng chung một repo cache bare. Hai lệnh git ghi vào cache cùng lúc (fetch cùng ref, worktree add
// sửa config chung) tranh file .lock của git và một bên hỏng với "cannot lock ref". Khoá chỉ giữ trong lúc một lệnh git
// chạy, nên CLI của các run vẫn chạy song song.

var (
	repoLocksMu sync.Mutex
	repoLocks   = map[string]chan struct{}{}
)

// filePollInterval là nhịp thử lại khoá file; khoá file không chờ theo context được nên thử không chặn rồi ngủ.
const filePollInterval = 50 * time.Millisecond

// lockRepo khoá repo cache trong tiến trình và giữa các tiến trình worker dùng chung DataDir (service và chạy tay
// cùng dùng os.UserCacheDir của một người dùng). Khoá file nằm cạnh cache vì lúc clone thư mục cache chưa có.
func lockRepo(ctx context.Context, cache string) (func(), error) {
	repoLocksMu.Lock()
	ch, ok := repoLocks[cache]
	if !ok {
		ch = make(chan struct{}, 1)
		repoLocks[cache] = ch
	}
	repoLocksMu.Unlock()
	select {
	case ch <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	f, err := lockFile(ctx, cache+".lock")
	if err != nil {
		<-ch
		return nil, err
	}
	return func() {
		_ = unlockFile(f)
		_ = f.Close()
		<-ch
	}, nil
}

func lockFile(ctx context.Context, path string) (*os.File, error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0600)
	if err != nil {
		return nil, err
	}
	for {
		locked, err := tryLockFile(f)
		if err != nil {
			_ = f.Close()
			return nil, err
		}
		if locked {
			return f, nil
		}
		select {
		case <-ctx.Done():
			_ = f.Close()
			return nil, ctx.Err()
		case <-time.After(filePollInterval):
		}
	}
}

// gitLockRetries và gitLockBackoff giới hạn việc thử lại: git của tiến trình ngoài worker (người dùng chạy tay, gc tự
// động) vẫn có thể giữ file .lock trong chốc lát dù worker đã tự tuần tự hoá.
const gitLockRetries = 5

var gitLockBackoff = 200 * time.Millisecond

// gitWrite chạy một lệnh git ghi vào repo cache dưới khoá của cache. dir là thư mục chạy lệnh (cache, DataDir khi
// clone, hoặc worktree khi push).
func gitWrite(ctx context.Context, cache, dir string, args ...string) error {
	unlock, err := lockRepo(ctx, cache)
	if err != nil {
		return err
	}
	defer unlock()
	return gitRetryLocked(ctx, dir, args...)
}

func gitRetryLocked(ctx context.Context, dir string, args ...string) error {
	for attempt := 1; ; attempt++ {
		var stderr bytes.Buffer
		c := procattr.CommandContext(ctx, "git", args...)
		c.Dir = dir
		c.Stdout = io.Discard
		c.Stderr = io.MultiWriter(os.Stderr, &stderr)
		err := c.Run()
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
