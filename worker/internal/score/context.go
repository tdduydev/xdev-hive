package score

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Category là một nhóm trong bảng "Estimated usage by category" của /context.
type Category struct {
	Name   string `json:"name"`
	Tokens int64  `json:"tokens"`
}

// ContextReport là bảng /context của Claude Code: cửa sổ ngữ cảnh và token theo nhóm lúc mở phiên.
type ContextReport struct {
	Model      string     `json:"model,omitempty"`
	Used       int64      `json:"used"`
	Window     int64      `json:"window"`
	Categories []Category `json:"categories"`
}

// Category trả token của nhóm theo tên (không phân biệt hoa thường); 0 khi không có.
func (r *ContextReport) Category(name string) int64 {
	for _, c := range r.Categories {
		if strings.EqualFold(strings.TrimSpace(c.Name), name) {
			return c.Tokens
		}
	}
	return 0
}

// parseTokens đọc "12.7k", "1m", "~480", "1,234" kiểu CLI in (dấu phẩy là phân cách nghìn).
func parseTokens(s string) (int64, bool) {
	t := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(s), "~"))
	mul := 1.0
	switch {
	case strings.HasSuffix(t, "k"):
		mul, t = 1_000, strings.TrimSuffix(t, "k")
	case strings.HasSuffix(t, "m"):
		mul, t = 1_000_000, strings.TrimSuffix(t, "m")
	}
	n, err := strconv.ParseFloat(strings.ReplaceAll(t, ",", ""), 64)
	if err != nil {
		return 0, false
	}
	return int64(n*mul + 0.5), true
}

// ParseContext đọc output của `claude -p /context` như parse_context của app desktop (usage.rs). nil khi không thấy bảng.
func ParseContext(out string) *ContextReport {
	r := &ContextReport{Categories: []Category{}}
	inTable := false
	for _, line := range strings.Split(out, "\n") {
		l := strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(l, "**Model:**"):
			r.Model = strings.TrimSpace(strings.TrimPrefix(l, "**Model:**"))
		case strings.HasPrefix(l, "**Tokens:**"):
			used, window, _ := strings.Cut(strings.TrimPrefix(l, "**Tokens:**"), "/")
			r.Used, _ = parseTokens(used)
			window, _, _ = strings.Cut(window, "(")
			r.Window, _ = parseTokens(window)
		case strings.HasPrefix(l, "### "):
			inTable = strings.EqualFold(strings.TrimSpace(strings.TrimPrefix(l, "### ")), "Estimated usage by category")
		case inTable && strings.HasPrefix(l, "|"):
			cells := strings.Split(strings.Trim(l, "|"), "|")
			if len(cells) < 2 {
				continue
			}
			name := strings.TrimSpace(cells[0])
			if strings.EqualFold(name, "category") || strings.HasPrefix(name, "-") {
				continue
			}
			if n, ok := parseTokens(cells[1]); ok {
				r.Categories = append(r.Categories, Category{Name: name, Tokens: n})
			}
		}
	}
	if len(r.Categories) == 0 {
		return nil
	}
	return r
}

// ContextRunner chạy `claude -p /context` cho một gói và trả stdout.
type ContextRunner func(ctx context.Context, p Profile) ([]byte, error)

// `claude -p /context` gọi model: đo trên máy dev 2.1.300 tốn một lượt, khoảng 46k token ghi cache và 0,8k output. Vì
// vậy điểm không tự chạy nó; người dùng bấm đo thì kết quả được dùng lại 7 ngày, đủ lâu vì cấu hình ít khi đổi.
const (
	ContextTimeout = 30 * time.Second
	ContextTTL     = 7 * 24 * time.Hour
)

type contextEntry struct {
	At     time.Time      `json:"at"`
	Report *ContextReport `json:"report"`
}

// LoadContexts lấy /context của mọi gói Claude từ dir/context-cache.json. measure: chạy lại cho mọi gói, song song.
// Gói không chạy được (chưa đăng nhập, quá giờ) không có trong kết quả; lỗi đọc hay ghi cache không làm hỏng điểm.
func LoadContexts(ctx context.Context, dir string, profiles []Profile, run ContextRunner, now time.Time, measure bool) map[string]*ContextReport {
	path := filepath.Join(dir, "context-cache.json")
	cache := map[string]contextEntry{}
	if b, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(b, &cache)
	}
	out := map[string]*ContextReport{}
	var mu sync.Mutex
	var wg sync.WaitGroup
	changed := false
	for _, p := range profiles {
		if p.CLI != "claude" {
			continue
		}
		if !measure {
			if e, ok := cache[p.ID]; ok && e.Report != nil && now.Sub(e.At) < ContextTTL && !e.At.After(now) {
				out[p.ID] = e.Report
			}
			continue
		}
		wg.Add(1)
		go func(p Profile) {
			defer wg.Done()
			c, cancel := context.WithTimeout(ctx, ContextTimeout)
			defer cancel()
			b, _ := run(c, p)
			r := ParseContext(string(b))
			mu.Lock()
			defer mu.Unlock()
			if r != nil {
				out[p.ID] = r
				cache[p.ID] = contextEntry{At: now, Report: r}
				changed = true
			}
		}(p)
	}
	wg.Wait()
	if changed {
		if b, err := json.Marshal(cache); err == nil && os.MkdirAll(dir, 0o700) == nil {
			writeAtomic(path, b)
		}
	}
	return out
}

// writeAtomic ghi file tạm cùng thư mục rồi đổi tên, để hai lần chạy cùng lúc không để lại file dở.
func writeAtomic(path string, b []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+"-*")
	if err != nil {
		return err
	}
	_, werr := tmp.Write(b)
	cerr := tmp.Close()
	if werr != nil || cerr != nil {
		_ = os.Remove(tmp.Name())
		if werr != nil {
			return werr
		}
		return cerr
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		_ = os.Remove(tmp.Name())
		return err
	}
	return nil
}
