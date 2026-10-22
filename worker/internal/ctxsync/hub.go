package ctxsync

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/tdduydev/xdev-hive/worker/internal/memstore"
)

// Giới hạn của devOptimizerPolicy (contracts/hub-api.md). Hub đã kiểm bằng zod, nhưng file chính sách đi qua desktop: một
// giá trị lạ không được làm khối phình ra hay lịch đồng bộ chạy liên tục.
const (
	minBudgetTokens = 500
	maxBudgetTokens = 8000
	minSyncMinutes  = 15
	maxSyncMinutes  = 1440
	maxErrorRunes   = 300
)

// HubMemory là một memory trong HubSnapshot. Nhận thêm supersededBy và status như hub trả để desktop đưa nguyên danh
// sách của memory.list, sidecar tự lọc.
type HubMemory struct {
	ID           string  `json:"id"`
	Kind         string  `json:"kind"`
	Pinned       bool    `json:"pinned"`
	CreatedAt    string  `json:"createdAt"`
	Content      string  `json:"content"`
	SupersededBy *string `json:"supersededBy,omitempty"`
	Status       string  `json:"status,omitempty"`
}

// HubSnapshot là memory đã duyệt app desktop lấy từ hub (bằng PAT) rồi đưa qua file. Error khác rỗng là desktop không lấy
// được (mất mạng, hub lỗi): sidecar giữ bản lần trước và ghi lỗi để màn Memory hiện (FR-025).
type HubSnapshot struct {
	ProjectID string      `json:"projectId"`
	Items     []HubMemory `json:"items"`
	Error     string      `json:"error,omitempty"`
}

// Policy là phần chính sách dự án (devOptimizerPolicy) mà ngữ cảnh dùng chung cần.
type Policy struct {
	ContextBudgetTokens int  `json:"contextBudgetTokens,omitempty"`
	MemoryAutoSync      bool `json:"memoryAutoSync"`
	MemorySyncMinutes   int  `json:"memorySyncMinutes,omitempty"`
}

// hubState là context/<khoá>/hub.json: các mục đã chọn vào "Từ hub" và số mục bị bỏ.
type hubState struct {
	ProjectID    string    `json:"projectId"`
	SyncedAt     *string   `json:"syncedAt"`
	LastError    *string   `json:"lastError"`
	BudgetTokens int       `json:"budgetTokens"`
	Items        []HubItem `json:"items"`
	Omitted      Omitted   `json:"omitted"`
}

func (m Manager) hubPath(key string) string { return filepath.Join(m.dir(key), "hub.json") }

func (m Manager) loadHub(key string) (*hubState, error) {
	raw, err := os.ReadFile(m.hubPath(key))
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var h hubState
	if err := json.Unmarshal(raw, &h); err != nil {
		return nil, fmt.Errorf("hub.json của %s hỏng: %w", key, err)
	}
	return &h, nil
}

func (m Manager) hubItems(key string) ([]HubItem, error) {
	h, err := m.loadHub(key)
	if err != nil || h == nil {
		return nil, err
	}
	return h.Items, nil
}

// updateHub ghi hub.json theo bản hub và chính sách mới. Bản hợp lệ thay cả mục "Từ hub": memory bị thay hay gỡ trên hub
// tự biến mất (FR-023). Bản báo lỗi giữ các mục và thời điểm đồng bộ cũ, chỉ ghi lastError (FR-025). policy nil là chưa
// biết chính sách, giữ ngân sách lần trước; chỉ có chính sách thì cắt lại các mục đã lưu theo ngân sách mới (FR-022).
func (m Manager) updateHub(key string, st State, snap *HubSnapshot, policy *Policy) error {
	prev, err := m.loadHub(key)
	if err != nil && (snap == nil || snap.Error != "") {
		return err
	}
	budget := budgetFor(policy, prev)
	projectID := st.ProjectID
	if snap != nil && projectID == "" {
		projectID = snap.ProjectID
	}
	var h hubState
	switch {
	case snap != nil && snap.Error == "" && !mismatched(st, snap):
		now := m.now().UTC().Format(time.RFC3339)
		items, omitted := selectHub(snap.Items, budget)
		h = hubState{ProjectID: projectID, SyncedAt: &now, BudgetTokens: budget, Items: items, Omitted: omitted}
	case snap != nil:
		msg := hubError(snap.Error)
		if snap.Error == "" {
			msg = fmt.Sprintf("Memory hub gửi tới thuộc dự án %s, không phải %s; giữ bản lần trước.", snap.ProjectID, st.ProjectID)
		}
		h = hubState{ProjectID: projectID, Items: []HubItem{}}
		if prev != nil {
			h = *prev
		}
		h.LastError = &msg
		h.BudgetTokens = budget
		h.trim()
	case prev == nil:
		return nil
	default:
		h = *prev
		h.BudgetTokens = budget
		h.trim()
	}
	if h.Items == nil {
		h.Items = []HubItem{}
	}
	return writeJSON(m.hubPath(key), h)
}

// trim cắt các mục đã lưu khi ngân sách nhỏ đi; mục bị cắt cộng vào số bỏ vì ngân sách.
func (h *hubState) trim() {
	kept, dropped := fitBudget(h.Items, h.BudgetTokens)
	h.Items = kept
	h.Omitted.Budget += dropped
}

func mismatched(st State, snap *HubSnapshot) bool {
	return st.ProjectID != "" && snap.ProjectID != "" && !strings.EqualFold(st.ProjectID, snap.ProjectID)
}

func budgetFor(policy *Policy, prev *hubState) int {
	switch {
	case policy != nil && policy.ContextBudgetTokens > 0:
		return clamp(policy.ContextBudgetTokens, minBudgetTokens, maxBudgetTokens)
	case policy != nil:
		return DefaultBudgetTokens
	case prev != nil && prev.BudgetTokens > 0:
		return prev.BudgetTokens
	}
	return DefaultBudgetTokens
}

// autoSyncFor là lịch tự đồng bộ khi có chính sách: chính sách bật thì theo chính sách; không bật thì trả về lịch của máy
// (FR-021: tự đồng bộ khi người dùng hay chính sách bật).
func autoSyncFor(cur AutoSync, policy *Policy) AutoSync {
	switch {
	case policy.MemoryAutoSync:
		min := defaultSyncMinutes
		if policy.MemorySyncMinutes > 0 {
			min = clamp(policy.MemorySyncMinutes, minSyncMinutes, maxSyncMinutes)
		}
		return AutoSync{Enabled: true, Minutes: min, Source: "policy"}
	case cur.Source == "policy":
		return defaultAutoSync()
	}
	return cur
}

// hubError là lỗi desktop báo, rút gọn để hiện. Lỗi trông như có bí mật (URL kèm token…) thì không lưu nguyên văn.
func hubError(msg string) string {
	msg = strings.Join(strings.Fields(msg), " ")
	if msg == "" {
		return "Không lấy được memory từ hub."
	}
	if looksSecret(msg) {
		return "Không lấy được memory từ hub (đã ẩn chi tiết lỗi vì có thể chứa bí mật)."
	}
	if utf8.RuneCountInString(msg) > maxErrorRunes {
		msg = string([]rune(msg)[:maxErrorRunes]) + "…"
	}
	return msg
}

// selectHub chọn memory vào mục "Từ hub": bỏ bản đã bị thay, chưa duyệt hay rỗng (không đếm, vì không còn là memory
// đang dùng); bỏ mục trông như bí mật (FR-024); xếp ghim trước, mới trước; lấy tới khi hết ngân sách (FR-022).
func selectHub(in []HubMemory, budget int) ([]HubItem, Omitted) {
	var om Omitted
	cands := make([]HubMemory, 0, len(in))
	for _, it := range in {
		if (it.SupersededBy != nil && *it.SupersededBy != "") || (it.Status != "" && it.Status != "approved") ||
			strings.TrimSpace(it.Content) == "" {
			continue
		}
		cands = append(cands, it)
	}
	sort.SliceStable(cands, func(i, j int) bool {
		if cands[i].Pinned != cands[j].Pinned {
			return cands[i].Pinned
		}
		return createdAt(cands[i]).After(createdAt(cands[j]))
	})
	items := make([]HubItem, 0, len(cands))
	for _, it := range cands {
		if looksSecret(it.Content) {
			om.Secret++
			continue
		}
		items = append(items, HubItem{ID: it.ID, Kind: it.Kind, Pinned: it.Pinned, CreatedAt: it.CreatedAt,
			Content: it.Content, Tokens: memstore.EstimateTokens(it.Content)})
	}
	items, om.Budget = fitBudget(items, budget)
	return items, om
}

// fitBudget giữ các mục theo thứ tự đã xếp miễn mục "Từ hub" còn trong ngân sách. Đo cả mục đã dựng (tiêu đề, gạch đầu
// dòng) vì ước lượng token không cộng dồn được: một chữ có dấu đổi hệ số của cả đoạn. Mục quá to được bỏ qua chứ không
// chặn các mục nhỏ hơn phía sau; mục đứng trước vẫn được giữ chỗ trước.
func fitBudget(items []HubItem, budget int) ([]HubItem, int) {
	kept := make([]HubItem, 0, len(items))
	dropped := 0
	for _, it := range items {
		if memstore.EstimateTokens(renderBody("", append(kept, it), false)) > budget {
			dropped++
			continue
		}
		kept = append(kept, it)
	}
	return kept, dropped
}

func createdAt(it HubMemory) time.Time {
	t, err := time.Parse(time.RFC3339Nano, it.CreatedAt)
	if err != nil {
		return time.Time{}
	}
	return t
}

func clamp(v, lo, hi int) int {
	return max(lo, min(v, hi))
}
