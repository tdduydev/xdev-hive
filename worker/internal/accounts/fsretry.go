package accounts

import (
	"os"
	"time"
)

// fsRetry: thời gian chờ tối đa khi Windows tạm khoá file. Worker và lệnh của app cùng đọc và thay accounts-state.json;
// trên Windows file đang mở (kể cả bởi trình diệt virus) không thay được, và file vừa bị thay thì mở ra có thể báo
// "Access is denied" trong chốc lát. Unix không có lỗi này nên transient luôn false.
const fsRetry = 2 * time.Second

func retryTransient(fn func() error) error {
	deadline := time.Now().Add(fsRetry)
	for {
		err := fn()
		if err == nil || !transient(err) || time.Now().After(deadline) {
			return err
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func readFile(path string) ([]byte, error) {
	var b []byte
	err := retryTransient(func() (err error) {
		b, err = os.ReadFile(path)
		return err
	})
	return b, err
}

func rename(from, to string) error {
	return retryTransient(func() error { return os.Rename(from, to) })
}
