package delivery

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

var jobIDPattern = regexp.MustCompile(`^[A-Za-z0-9-]{1,64}$`)

// JobLog ghi log đầy đủ của một việc ra đĩa máy chạy (FR-053). Hub không nhận log. Giá trị bí mật đã biết bị che trước khi
// ghi, vì log deploy hay in lại header hoặc tham số.
type JobLog struct {
	mu      sync.Mutex
	f       *os.File
	secrets []string
}

// OpenJobLog mở (hoặc nối thêm) <dir>/<jobID>.log. jobID được kiểm để không thoát khỏi dir.
func OpenJobLog(dir, jobID string, secrets ...string) (*JobLog, error) {
	if !jobIDPattern.MatchString(jobID) {
		return nil, newError(CodeBadRequest, 0, "Id việc %q không hợp lệ.", jobID)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(dir, jobID+".log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil, err
	}
	var kept []string
	for _, s := range secrets {
		if s != "" {
			kept = append(kept, s)
		}
	}
	// Che chuỗi dài trước để bí mật chứa bí mật ngắn hơn không để lại phần đuôi.
	sort.Slice(kept, func(i, j int) bool { return len(kept[i]) > len(kept[j]) })
	return &JobLog{f: f, secrets: kept}, nil
}

// Mask thay mọi giá trị bí mật đã biết bằng ***.
func (l *JobLog) Mask(s string) string {
	for _, sec := range l.secrets {
		s = strings.ReplaceAll(s, sec, "***")
	}
	return s
}

// Write cho phép dùng JobLog làm io.Writer.
func (l *JobLog) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if _, err := l.f.WriteString(l.Mask(string(p))); err != nil {
		return 0, err
	}
	return len(p), nil
}

// Printf ghi một dòng có mốc thời gian.
func (l *JobLog) Printf(format string, args ...any) {
	line := fmt.Sprintf(format, args...)
	_, _ = l.Write([]byte(time.Now().UTC().Format(time.RFC3339) + " " + line + "\n"))
}

func (l *JobLog) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.f.Close()
}
