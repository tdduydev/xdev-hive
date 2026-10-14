package optimizer

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

// attempts là số lần đọc lại khi file đổi giữa lúc đọc và lúc thay: CLI đang chạy tự ghi settings.json (đổi theme,
// model) bất cứ lúc nào.
const attempts = 3

// ErrBusy: file cấu hình đổi liên tục trong lúc ghi.
var ErrBusy = errors.New("file cấu hình đang bị chương trình khác ghi liên tục, thử lại sau")

// edit là kết quả tính từ nội dung đã đọc: to là nội dung mới, remove là xoá file, unchanged là không ghi gì.
type edit struct {
	to        []byte
	remove    bool
	unchanged bool
}

// beforeCheck cho test giả CLI ghi file đúng lúc Hive đang ghi.
var beforeCheck func(path string)

type snapshot struct {
	exists bool
	size   int64
	mtime  time.Time
	data   []byte
}

func read(path string) (snapshot, error) {
	st, err := os.Stat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return snapshot{}, nil
	}
	if err != nil {
		return snapshot{}, err
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return snapshot{}, err
	}
	return snapshot{exists: true, size: st.Size(), mtime: st.ModTime(), data: b}, nil
}

func (a snapshot) same(b snapshot) bool {
	return a.exists == b.exists && a.size == b.size && a.mtime.Equal(b.mtime) && bytes.Equal(a.data, b.data)
}

// update đọc path, gọi plan để tính nội dung mới, gọi commit (sao lưu, ghi manifest tạm) rồi thay file bằng file tạm +
// rename. File đổi từ lúc đọc tới trước khi rename thì làm lại từ đầu, tối đa attempts lần. Lỗi của plan (file hỏng)
// trả ngay, không ghi gì.
func update(path string, plan func(old snapshot) (edit, error), commit func(old snapshot, e edit) error) (snapshot, edit, error) {
	var lastErr error
	for range attempts {
		old, err := read(path)
		if err != nil {
			return old, edit{}, err
		}
		e, err := plan(old)
		if err != nil || e.unchanged {
			return old, e, err
		}
		tmp := ""
		if !e.remove {
			if tmp, err = writeTemp(path, e.to, old); err != nil {
				return old, e, err
			}
		}
		if beforeCheck != nil {
			beforeCheck(path)
		}
		now, err := read(path)
		if err != nil || !now.same(old) {
			removeTemp(tmp)
			lastErr = err
			continue
		}
		if commit != nil {
			if err := commit(old, e); err != nil {
				removeTemp(tmp)
				return old, e, err
			}
		}
		if e.remove {
			err = os.Remove(path)
			if errors.Is(err, fs.ErrNotExist) {
				err = nil
			}
		} else {
			err = os.Rename(tmp, path)
		}
		if err != nil {
			// Windows không thay được file đang mở (CLI, trình diệt virus đang đọc): thử lại như khi file đổi.
			removeTemp(tmp)
			lastErr = err
			continue
		}
		return old, e, nil
	}
	if lastErr != nil {
		return snapshot{}, edit{}, fmt.Errorf("%w: %v", ErrBusy, lastErr)
	}
	return snapshot{}, edit{}, ErrBusy
}

// writeTemp ghi file tạm cùng thư mục để rename là nguyên tử, giữ quyền của file cũ (settings.json có thể chứa token).
func writeTemp(path string, data []byte, old snapshot) (string, error) {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	f, err := os.CreateTemp(dir, "."+filepath.Base(path)+".hive-*")
	if err != nil {
		return "", err
	}
	mode := fs.FileMode(0o600)
	if old.exists {
		if st, err := os.Stat(path); err == nil {
			mode = st.Mode().Perm()
		}
	}
	_, err = f.Write(data)
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Chmod(f.Name(), mode)
	}
	if err != nil {
		_ = os.Remove(f.Name())
		return "", err
	}
	return f.Name(), nil
}

func removeTemp(tmp string) {
	if tmp != "" {
		_ = os.Remove(tmp)
	}
}

// writeAtomic ghi file của Hive (manifest, bản sao lưu): chỉ Hive ghi nên không cần kiểm file đổi.
func writeAtomic(path string, data []byte) error {
	tmp, err := writeTemp(path, data, snapshot{})
	if err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		removeTemp(tmp)
		return err
	}
	return nil
}
