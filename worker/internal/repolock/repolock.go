// Package repolock là khoá repo dùng chung giữa run của worker và lệnh `hive-worker branches` của app desktop, cùng
// các hàm so đường dẫn và đọc danh sách worktree mà hai bên cần giống hệt nhau.
package repolock

import (
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/registry"
)

// Các run cùng repo dùng chung một repo cache bare. Hai lệnh git ghi vào cache cùng lúc (fetch cùng ref, worktree add
// sửa config chung) tranh file .lock của git và một bên hỏng với "cannot lock ref". Khoá chỉ giữ trong lúc một lệnh git
// chạy, nên CLI của các run vẫn chạy song song.

var (
	repoLocksMu sync.Mutex
	repoLocks   = map[string]chan struct{}{}
)

// FilePollInterval là nhịp thử lại khoá file; khoá file không chờ theo context được nên thử không chặn rồi ngủ.
const FilePollInterval = 50 * time.Millisecond

// DataDir là thư mục dữ liệu của đăng ký đang chọn (spec 034): mỗi tổ chức một repo cache và worktree riêng. Service,
// worker chạy tay và lệnh `hive-worker branches` của app desktop chọn cùng một đăng ký thì ra cùng một thư mục, mới khoá
// cùng một file và nhận ra worktree của run.
func DataDir() (string, error) {
	_, dir, err := registry.Paths("")
	return dir, err
}

// LockRepo khoá repo cache trong tiến trình và giữa các tiến trình worker dùng chung DataDir (service và chạy tay
// cùng dùng os.UserCacheDir của một người dùng). Khoá file nằm cạnh cache vì lúc clone thư mục cache chưa có.
func LockRepo(ctx context.Context, cache string) (func(), error) {
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
	f, err := LockFile(ctx, cache+".lock")
	if err != nil {
		<-ch
		return nil, err
	}
	return func() {
		_ = UnlockFile(f)
		_ = f.Close()
		<-ch
	}, nil
}

// LocalLock là khoá của repo đã gắn, theo thư mục git chung: worktree nào của repo cũng ra cùng một khoá. File khoá nằm
// trong DataDir chứ không trong thư mục của người dùng.
func LocalLock(dataDir, common string) string {
	digest := sha256.Sum256([]byte(CleanAbs(common)))
	return filepath.Join(dataDir, "repos", fmt.Sprintf("local-%x", digest[:12]))
}

func LockFile(ctx context.Context, path string) (*os.File, error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0600)
	if err != nil {
		return nil, err
	}
	for {
		locked, err := TryLockFile(f)
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
		case <-time.After(FilePollInterval):
		}
	}
}
