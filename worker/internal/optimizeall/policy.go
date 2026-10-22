// Package optimizeall là nút "Tối ưu" của màn Token (spec 029 US2): dựng kế hoạch từ chính sách dự án, chạy các bước đã
// chọn, ghi nhật ký từng bước để hoàn tác một lần cho cả chuỗi. Gói chỉ gọi optimizer, memstore và các giao diện bên
// gọi truyền vào; lệnh CLI nằm ở cmd/hive-worker.
package optimizeall

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
)

// Mức tối ưu của chính sách. off chỉ có ở chính sách: optimizer không có mức off mà là "chưa bật".
const (
	LevelOff        = "off"
	LevelBalanced   = "balanced"
	LevelAggressive = "aggressive"
)

// Giới hạn trần nén như devOptimizerPolicy trên hub; file chính sách sửa tay ngoài khoảng này thì từ chối.
const (
	minAutoCompactWindow = 50_000
	maxAutoCompactWindow = 1_000_000
)

// Policy là devOptimizerPolicy của một dự án (contracts/hub-api.md). Ba trường cuối do ctxsync dùng; ở đây chỉ đọc
// cho khớp kiểu.
type Policy struct {
	Level               string `json:"level"`
	RTK                 bool   `json:"rtk"`
	Codegraph           bool   `json:"codegraph"`
	AutoCompactWindow   *int   `json:"autoCompactWindow"`
	ContextBudgetTokens int    `json:"contextBudgetTokens,omitempty"`
	MemoryAutoSync      bool   `json:"memoryAutoSync,omitempty"`
	MemorySyncMinutes   int    `json:"memorySyncMinutes,omitempty"`
}

// Target là đích sau khi gộp chính sách của mọi dự án đã gắn. *From là các dự án đòi giá trị đó, để xem trước ghi
// "Theo chính sách dự án …"; rỗng là giá trị mặc định.
type Target struct {
	Level             string
	LevelFrom         []string
	RTK               bool
	RTKFrom           []string
	Codegraph         bool
	CodegraphFrom     []string
	AutoCompactWindow *int
	AutoCompactFrom   []string
	Sources           []string
}

func levelRank(level string) int {
	switch level {
	case LevelOff:
		return 0
	case LevelBalanced:
		return 1
	case LevelAggressive:
		return 2
	}
	return -1
}

// ParsePolicies đọc file --policy-file: `{ [projectId]: DevOptimizerPolicy | null }`. null là dự án chưa đặt chính
// sách, bỏ qua để nó không kéo đích về balanced mặc định như một chính sách thật.
func ParsePolicies(data []byte) (map[string]Policy, error) {
	var raw map[string]*Policy
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("file chính sách không đọc được: %w", err)
	}
	if raw == nil {
		return nil, errors.New("file chính sách phải là đối tượng { dự án: chính sách }")
	}
	out := map[string]Policy{}
	for id, p := range raw {
		if p != nil {
			out[id] = *p
		}
	}
	return out, nil
}

// Merge gộp chính sách nhiều dự án (research mục 7): biến môi trường và hook nằm ở cấp gói CLI, không theo dự án, nên
// mức lấy cao nhất, rtk và codegraph là hoặc, trần nén lấy nhỏ nhất.
func Merge(policies map[string]Policy) (Target, error) {
	t := Target{Level: LevelBalanced}
	ids := make([]string, 0, len(policies))
	for id := range policies {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	best := -1
	for _, id := range ids {
		p := policies[id]
		level := p.Level
		if level == "" {
			level = LevelBalanced
		}
		r := levelRank(level)
		if r < 0 {
			return Target{}, fmt.Errorf("chính sách dự án %s có mức tối ưu không hợp lệ: %q", id, p.Level)
		}
		if w := p.AutoCompactWindow; w != nil && (*w < minAutoCompactWindow || *w > maxAutoCompactWindow) {
			return Target{}, fmt.Errorf("chính sách dự án %s có trần nén %d ngoài khoảng 50.000–1.000.000", id, *w)
		}
		t.Sources = append(t.Sources, id)
		switch {
		case r > best:
			best, t.Level, t.LevelFrom = r, level, []string{id}
		case r == best:
			t.LevelFrom = append(t.LevelFrom, id)
		}
		if p.RTK {
			t.RTK = true
			t.RTKFrom = append(t.RTKFrom, id)
		}
		if p.Codegraph {
			t.Codegraph = true
			t.CodegraphFrom = append(t.CodegraphFrom, id)
		}
		if w := p.AutoCompactWindow; w != nil {
			switch {
			case t.AutoCompactWindow == nil || *w < *t.AutoCompactWindow:
				v := *w
				t.AutoCompactWindow, t.AutoCompactFrom = &v, []string{id}
			case *w == *t.AutoCompactWindow:
				t.AutoCompactFrom = append(t.AutoCompactFrom, id)
			}
		}
	}
	return t, nil
}
