// Package runlogs giữ output run trên máy, tách khỏi worktree bị dọn ngay khi run xong.
package runlogs

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"time"
)

const DefaultRetentionDays = 365

// JSON của localipc giới hạn 64 KiB, nên chừa chỗ cho base64 và thông tin con trỏ.
const MaxRead = 32 * 1024

var validID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,100}$`)

type Entry struct {
	RunID         string    `json:"runId"`
	Attempt       int       `json:"attempt"`
	ProjectID     string    `json:"projectId,omitempty"`
	CLI           string    `json:"cli,omitempty"`
	CreatedAt     time.Time `json:"createdAt"`
	RetentionDays int       `json:"retentionDays"`
	Size          int64     `json:"size"`
}

type Page struct {
	RunID      string `json:"runId"`
	Attempt    int    `json:"attempt"`
	Offset     int64  `json:"offset"`
	NextOffset int64  `json:"nextOffset"`
	Size       int64  `json:"size"`
	Bytes      []byte `json:"bytes"`
}

type Store struct{ Dir string }

func (s Store) path(id string, attempt int) (string, error) {
	if !validID.MatchString(id) || attempt < 1 {
		return "", errors.New("Mã run hoặc lần thử không hợp lệ.")
	}
	return filepath.Join(s.Dir, fmt.Sprintf("%s-%d", id, attempt)), nil
}

func (s Store) Open(entry Entry) (*os.File, error) {
	p, err := s.path(entry.RunID, entry.Attempt)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(s.Dir, 0700); err != nil {
		return nil, err
	}
	if runtime.GOOS != "windows" {
		if err := os.Chmod(s.Dir, 0700); err != nil {
			return nil, err
		}
	}
	for _, ext := range []string{".log", ".json"} {
		info, err := os.Lstat(p + ext)
		if err == nil && !info.Mode().IsRegular() {
			return nil, errors.New("File log hoặc metadata không phải file thường.")
		}
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
	}
	if entry.RetentionDays != 30 && entry.RetentionDays != 90 && entry.RetentionDays != 365 {
		entry.RetentionDays = DefaultRetentionDays
	}
	if entry.CreatedAt.IsZero() {
		entry.CreatedAt = time.Now().UTC()
	}
	b, err := json.Marshal(entry)
	if err != nil {
		return nil, err
	}
	tmp, err := os.CreateTemp(s.Dir, ".index-*")
	if err != nil {
		return nil, err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return nil, err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return nil, err
	}
	if err := tmp.Close(); err != nil {
		return nil, err
	}
	if err := os.Rename(tmp.Name(), p+".json"); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(p+".log", os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err == nil && runtime.GOOS != "windows" {
		if err := f.Chmod(0600); err != nil {
			f.Close()
			return nil, err
		}
	}
	return f, err
}

func (s Store) List() ([]Entry, error) {
	files, err := os.ReadDir(s.Dir)
	if errors.Is(err, os.ErrNotExist) {
		return []Entry{}, nil
	}
	if err != nil {
		return nil, err
	}
	entries := []Entry{}
	for _, f := range files {
		if f.Type()&os.ModeSymlink != 0 || filepath.Ext(f.Name()) != ".json" {
			continue
		}
		b, err := os.ReadFile(filepath.Join(s.Dir, f.Name()))
		var entry Entry
		if err != nil || json.Unmarshal(b, &entry) != nil {
			continue
		}
		p, err := s.path(entry.RunID, entry.Attempt)
		if err != nil || filepath.Base(p)+".json" != f.Name() {
			continue
		}
		info, err := os.Lstat(p + ".log")
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		entry.Size = info.Size()
		entries = append(entries, entry)
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].CreatedAt.Equal(entries[j].CreatedAt) {
			return entries[i].Attempt > entries[j].Attempt
		}
		return entries[i].CreatedAt.After(entries[j].CreatedAt)
	})
	return entries, nil
}

// Attempt 0 chọn lần thử mới nhất có trên máy này; không hỏi hub hay máy khác.
func (s Store) Read(id string, attempt int, offset int64, limit int) (Page, error) {
	if !validID.MatchString(id) || attempt < 0 || offset < 0 || limit < 0 {
		return Page{}, errors.New("Tham số đọc log không hợp lệ.")
	}
	if attempt == 0 {
		entries, err := s.List()
		if err != nil {
			return Page{}, err
		}
		for _, entry := range entries {
			if entry.RunID == id {
				attempt = max(attempt, entry.Attempt)
			}
		}
	}
	if attempt == 0 {
		return Page{}, errors.New("Log không có trên máy này hoặc đã hết hạn giữ.")
	}
	p, err := s.path(id, attempt)
	if err != nil {
		return Page{}, err
	}
	info, err := os.Lstat(p + ".log")
	if err != nil || !info.Mode().IsRegular() {
		return Page{}, errors.New("Log không có trên máy này hoặc đã hết hạn giữ.")
	}
	f, err := os.Open(p + ".log")
	if err != nil {
		return Page{}, err
	}
	defer f.Close()
	if limit == 0 || limit > MaxRead {
		limit = MaxRead
	}
	b := make([]byte, limit)
	n, err := f.ReadAt(b, offset)
	if err != nil && !errors.Is(err, io.EOF) {
		return Page{}, err
	}
	return Page{RunID: id, Attempt: attempt, Offset: offset, NextOffset: offset + int64(n), Size: info.Size(), Bytes: b[:n]}, nil
}

// Dùng lần ghi cuối để run dài ngày không bị xoá giữa chừng. File lỗi không được suy ra thành đường dẫn để xoá.
func (s Store) Cleanup(now time.Time) error {
	entries, err := s.List()
	if err != nil {
		return err
	}
	for _, entry := range entries {
		p, _ := s.path(entry.RunID, entry.Attempt)
		info, err := os.Stat(p + ".log")
		if err != nil {
			return err
		}
		days := entry.RetentionDays
		if days != 30 && days != 90 && days != 365 {
			days = DefaultRetentionDays
		}
		if !info.ModTime().Before(now.AddDate(0, 0, -days)) {
			continue
		}
		if err := os.Remove(p + ".log"); err != nil {
			return err
		}
		if err := os.Remove(p + ".json"); err != nil {
			return err
		}
	}
	return nil
}
