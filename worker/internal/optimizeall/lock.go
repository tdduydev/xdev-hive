package optimizeall

import (
	"os"
	"path/filepath"

	"github.com/tdduydev/xdev-hive/worker/internal/repolock"
)

// ErrLocked: một chuỗi "Tối ưu" hay một lần đồng bộ ngữ cảnh đang chạy ở cửa sổ khác (FR-016).
var ErrLocked = &Error{Code: CodeLocked, Message: "Đang tối ưu ở cửa sổ khác"}

// Lock giữ ~/.xdev-hive/optimizer/optimize.lock (research mục 8), theo mẫu score.LockHistory nhưng không chờ: người
// dùng bấm lần hai thì báo ngay, đồng bộ định kỳ bỏ lượt. Khoá theo handle file nên hai lần gọi trong cùng tiến trình
// cũng loại trừ nhau. `context sync` (T006) dùng chung khoá này.
func Lock(dir string) (func(), error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(dir, "optimize.lock"), os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	ok, err := repolock.TryLockFile(f)
	if err != nil {
		_ = f.Close()
		return nil, err
	}
	if !ok {
		_ = f.Close()
		return nil, ErrLocked
	}
	return func() { _ = repolock.UnlockFile(f); _ = f.Close() }, nil
}
