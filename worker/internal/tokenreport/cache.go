package tokenreport

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// cacheVersion tăng mỗi khi cách đọc transcript đổi, để số liệu cũ trong cache không bị dùng lại.
const cacheVersion = 1

type cacheEntry struct {
	MtimeNs int64    `json:"mtimeNs"`
	Size    int64    `json:"size"`
	Session *session `json:"session"`
}

// cache giữ kết quả đọc từng transcript theo (file, mtime, cỡ) để mở báo cáo lần sau chỉ đọc lại file mới đổi.
// Mọi lỗi đọc/ghi cache chỉ làm báo cáo chậm đi, không làm nó hỏng.
type cache struct {
	path    string
	Version int                    `json:"version"`
	Entries map[string]*cacheEntry `json:"entries"`
	dirty   bool
}

func loadCache(path string) *cache {
	c := &cache{path: path, Version: cacheVersion, Entries: map[string]*cacheEntry{}}
	if path == "" {
		return c
	}
	body, err := os.ReadFile(path)
	if err != nil {
		return c
	}
	var loaded cache
	if json.Unmarshal(body, &loaded) != nil || loaded.Version != cacheVersion || loaded.Entries == nil {
		return c
	}
	c.Entries = loaded.Entries
	return c
}

func (c *cache) get(file string, mtimeNs, size int64) *session {
	e := c.Entries[file]
	if e == nil || e.Session == nil || e.MtimeNs != mtimeNs || e.Size != size {
		return nil
	}
	return e.Session
}

func (c *cache) put(file string, mtimeNs, size int64, s *session) {
	c.Entries[file] = &cacheEntry{MtimeNs: mtimeNs, Size: size, Session: s}
	c.dirty = true
}

// save bỏ mục của file đã biến mất rồi ghi nguyên tử (file tạm + rename) để hai lần chạy cùng lúc không làm hỏng nhau.
func (c *cache) save() {
	if c.path == "" {
		return
	}
	for file := range c.Entries {
		if _, err := os.Stat(file); err != nil {
			delete(c.Entries, file)
			c.dirty = true
		}
	}
	if !c.dirty {
		return
	}
	body, err := json.Marshal(c)
	if err != nil {
		return
	}
	if os.MkdirAll(filepath.Dir(c.path), 0o700) != nil {
		return
	}
	tmp, err := os.CreateTemp(filepath.Dir(c.path), ".report-cache-*")
	if err != nil {
		return
	}
	_, werr := tmp.Write(body)
	cerr := tmp.Close()
	if werr != nil || cerr != nil || os.Rename(tmp.Name(), c.path) != nil {
		_ = os.Remove(tmp.Name())
	}
}
