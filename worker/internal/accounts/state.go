package accounts

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// State là trạng thái chạy của các tài khoản, ở accounts-state.json cạnh accounts.json. Nằm trên đĩa chứ không trong bộ
// nhớ worker để giờ nghỉ còn sau khi worker khởi động lại, và để lệnh `hive-worker accounts` (tiến trình khác, do app
// gọi) đọc được quota, số run đang chạy và ghi được "Dùng tiếp".
type State struct {
	CoolUntil   map[string]time.Time `json:"coolUntil"`
	ResumeUntil map[string]time.Time `json:"resumeUntil"`
	Usage       map[string]Usage     `json:"usage"`
	// Active do worker ghi mỗi lần giữ hay trả tài khoản; chỉ để hiện, worker đếm bằng bộ nhớ của nó.
	Active map[string]int `json:"active"`
}

// StatePath là accounts-state.json cạnh accounts.json.
func StatePath(accountsPath string) string {
	return filepath.Join(filepath.Dir(accountsPath), "accounts-state.json")
}

// LoadState đọc trạng thái; file không có thì trả rỗng, không lỗi.
func LoadState(path string) (State, error) {
	var s State
	b, err := readFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return s, err
	}
	if err == nil {
		if err := json.Unmarshal(b, &s); err != nil {
			return s, fmt.Errorf("đọc %s: %w", path, err)
		}
	}
	s.init()
	return s, nil
}

func (s *State) init() {
	if s.CoolUntil == nil {
		s.CoolUntil = map[string]time.Time{}
	}
	if s.ResumeUntil == nil {
		s.ResumeUntil = map[string]time.Time{}
	}
	if s.Usage == nil {
		s.Usage = map[string]Usage{}
	}
	if s.Active == nil {
		s.Active = map[string]int{}
	}
}

// prune bỏ giờ nghỉ và "Dùng tiếp" đã hết, để file không lớn dần theo thời gian.
func (s *State) prune(now time.Time) {
	for id, at := range s.CoolUntil {
		if !at.After(now) {
			delete(s.CoolUntil, id)
		}
	}
	for id, at := range s.ResumeUntil {
		if !at.After(now) {
			delete(s.ResumeUntil, id)
		}
	}
	for id, n := range s.Active {
		if n <= 0 {
			delete(s.Active, id)
		}
	}
}

// UpdateState đọc, sửa rồi ghi trạng thái trong lúc giữ khoá: worker và lệnh của app cùng ghi file này.
func UpdateState(path string, now time.Time, change func(*State)) error {
	return withLock(path, func() error {
		s, err := LoadState(path)
		if err != nil {
			return err
		}
		change(&s)
		s.prune(now)
		return writeJSON(path, s)
	})
}

// staleLock: khoá cũ hơn chừng này là của tiến trình đã chết giữa chừng; giữ khoá chỉ tốn vài mili giây.
const staleLock = 10 * time.Second

// withLock giữ path+".lock" trong lúc chạy fn. Tạo file với O_EXCL chạy được trên mọi hệ điều hành worker hỗ trợ,
// khác flock chỉ có trên Unix.
func withLock(path string, fn func() error) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	lock := path + ".lock"
	deadline := time.Now().Add(5 * time.Second)
	for {
		f, err := os.OpenFile(lock, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			_ = f.Close()
			break
		}
		// Windows: file khoá vừa bị xoá mà còn handle mở (trình diệt virus) thì tạo lại báo "Access is denied" như đang bị giữ.
		if !errors.Is(err, os.ErrExist) && !transient(err) {
			return err
		}
		if st, err := os.Stat(lock); err == nil && time.Since(st.ModTime()) > staleLock {
			_ = os.Remove(lock)
			continue
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("%s đang bị tiến trình khác giữ, thử lại sau", path)
		}
		time.Sleep(20 * time.Millisecond)
	}
	defer func() { _ = os.Remove(lock) }()
	return fn()
}

// writeJSON ghi file (0600, thay nguyên file) để tiến trình khác không bao giờ đọc phải file ghi dở.
func writeJSON(path string, v any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+"-*")
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(tmp.Name()) }()
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(append(b, '\n')); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return rename(tmp.Name(), path)
}
