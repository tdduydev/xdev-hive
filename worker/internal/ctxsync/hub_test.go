package ctxsync

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/memstore"
)

func memory(id string, pinned bool, createdAt, content string) HubMemory {
	return HubMemory{ID: id, Kind: "decision", Pinned: pinned, CreatedAt: createdAt, Content: content}
}

func ids(items []HubItem) string {
	out := make([]string, 0, len(items))
	for _, it := range items {
		out = append(out, it.ID)
	}
	return strings.Join(out, ",")
}

// hubTokens là số token của mục "Từ hub" như khi ghi vào file đích.
func hubTokens(items []HubItem) int { return memstore.EstimateTokens(renderBody("", items, false)) }

// longMemory là memory tiếng Việt khoảng n ký tự, mỗi id một nội dung khác nhau.
func longMemory(id string, n int) string {
	s := "Bài học " + id + ": "
	for len([]rune(s)) < n {
		s += "chạy pnpm check trước khi mở PR, "
	}
	return string([]rune(s)[:n])
}

func readHubState(t *testing.T, m Manager, key string) hubState {
	t.Helper()
	h, err := m.loadHub(key)
	if err != nil || h == nil {
		t.Fatalf("hub.json = %+v, %v", h, err)
	}
	return *h
}

func TestSelectHubOrdersPinnedThenNewestAndDropsInactive(t *testing.T) {
	superseded := "m9"
	in := []HubMemory{
		memory("old", false, "2026-10-01T00:00:00Z", "Cũ"),
		memory("pin-old", true, "2026-09-01T00:00:00Z", "Ghim cũ"),
		memory("pin-new", true, "2026-10-10T00:00:00.123Z", "Ghim mới"),
		{ID: "replaced", Pinned: true, CreatedAt: "2026-10-20T00:00:00Z", Content: "Đã bị thay", SupersededBy: &superseded},
		{ID: "pending", CreatedAt: "2026-10-21T00:00:00Z", Content: "Chưa duyệt", Status: "pending"},
		memory("blank", true, "2026-10-21T00:00:00Z", "  \n"),
		memory("new", false, "2026-10-15T00:00:00Z", "Mới"),
		memory("no-date", false, "", "Không rõ ngày"),
	}
	items, om := selectHub(in, DefaultBudgetTokens)
	if got := ids(items); got != "pin-new,pin-old,new,old,no-date" {
		t.Fatalf("thứ tự = %s", got)
	}
	if om != (Omitted{}) {
		t.Fatalf("omitted = %+v", om)
	}
	if items[0].Tokens != memstore.EstimateTokens("Ghim mới") || items[0].Kind != "decision" {
		t.Fatalf("item = %+v", items[0])
	}
}

// FR-022: mục "Từ hub" không vượt ngân sách; mục quá to bị bỏ nhưng không chặn mục nhỏ phía sau.
func TestSelectHubKeepsWithinBudget(t *testing.T) {
	var in []HubMemory
	for i := 0; i < 12; i++ {
		id := fmt.Sprintf("m%02d", i)
		in = append(in, memory(id, false, fmt.Sprintf("2026-10-%02dT00:00:00Z", 20-i), longMemory(id, 400)))
	}
	items, om := selectHub(in, 500)
	if len(items) == 0 || om.Budget == 0 || len(items)+om.Budget != len(in) {
		t.Fatalf("giữ %d, bỏ %+v", len(items), om)
	}
	if n := hubTokens(items); n > 500 {
		t.Fatalf("mục Từ hub %d token > 500", n)
	}
	if !strings.HasPrefix(ids(items), "m00,m01") {
		t.Fatalf("mục mới nhất phải được giữ trước: %s", ids(items))
	}

	huge := memory("huge", true, "2026-10-22T00:00:00Z", longMemory("huge", 2000))
	items, om = selectHub([]HubMemory{huge, memory("small", false, "2026-10-01T00:00:00Z", "Dùng Hono cho hub.")}, 500)
	if ids(items) != "small" || om.Budget != 1 {
		t.Fatalf("giữ %s, bỏ %+v", ids(items), om)
	}
}

// FR-024: mục trông như bí mật bị bỏ, được đếm, và không nằm trong hub.json hay file đích.
func TestSyncDropsSecretHubItems(t *testing.T) {
	fx := newFixture(t)
	p := fx.enable(t, "Nguồn tại máy.\n")
	pat := fakeKey("gh"+"p_", 36)
	hub := &HubSnapshot{ProjectID: "x", Items: []HubMemory{
		memory("ok", false, "2026-10-20T00:00:00Z", "Dùng Hono cho hub."),
		memory("pat", true, "2026-10-21T00:00:00Z", "PAT của bot: "+pat),
		memory("key", false, "2026-10-19T00:00:00Z", "-----BEGIN "+"RSA PRIVATE KEY-----\nabc\n"),
	}}
	p, _, err := fx.m.Sync(p.Key, hub, nil)
	if err != nil {
		t.Fatal(err)
	}
	if p.Hub == nil || p.Hub.Items != 1 || p.Hub.Omitted != (Omitted{Secret: 2}) {
		t.Fatalf("hub = %+v", p.Hub)
	}
	raw, err := os.ReadFile(fx.m.hubPath(p.Key))
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range []string{string(raw), fx.read(t, "CLAUDE.local.md")} {
		if strings.Contains(s, pat) || strings.Contains(s, "PRIVATE KEY") {
			t.Fatalf("bí mật lọt ra file:\n%s", s)
		}
	}
	if !strings.Contains(fx.read(t, "CLAUDE.local.md"), "- Dùng Hono cho hub.") {
		t.Fatal("thiếu mục hợp lệ")
	}
}

// FR-022: ngân sách lấy từ chính sách (kẹp trong 500–8000); chỉ đổi chính sách cũng cắt lại các mục đã lưu.
func TestSyncHubBudgetFollowsPolicy(t *testing.T) {
	fx := newFixture(t)
	p := fx.enable(t, "")
	var items []HubMemory
	for i := 0; i < 20; i++ {
		id := fmt.Sprintf("m%02d", i)
		items = append(items, memory(id, false, fmt.Sprintf("2026-10-%02dT00:00:00Z", 21-i), longMemory(id, 300)))
	}
	hub := &HubSnapshot{Items: items}

	p, _, err := fx.m.Sync(p.Key, hub, &Policy{ContextBudgetTokens: 99999})
	if err != nil {
		t.Fatal(err)
	}
	h := readHubState(t, fx.m, p.Key)
	if h.BudgetTokens != maxBudgetTokens || len(h.Items) != 20 || h.Omitted.Budget != 0 {
		t.Fatalf("budget %d, giữ %d, bỏ %+v", h.BudgetTokens, len(h.Items), h.Omitted)
	}

	// Chỉ có chính sách (không có bản hub mới): cắt lại theo ngân sách nhỏ nhất.
	p, _, err = fx.m.Sync(p.Key, nil, &Policy{ContextBudgetTokens: 1})
	if err != nil {
		t.Fatal(err)
	}
	h = readHubState(t, fx.m, p.Key)
	if h.BudgetTokens != minBudgetTokens || hubTokens(h.Items) > minBudgetTokens || h.Omitted.Budget != 20-len(h.Items) {
		t.Fatalf("budget %d, %d token, giữ %d, bỏ %+v", h.BudgetTokens, hubTokens(h.Items), len(h.Items), h.Omitted)
	}
	if p.Hub.Items != len(h.Items) || p.Hub.Omitted != h.Omitted {
		t.Fatalf("view = %+v, hub.json = %+v", p.Hub, h)
	}
	body := blockOf(t, fx.read(t, "CLAUDE.local.md")).Body
	if n := memstore.EstimateTokens(body); n > minBudgetTokens {
		t.Fatalf("khối %d token > %d", n, minBudgetTokens)
	}

	// Không có chính sách thì giữ ngân sách lần trước.
	if _, _, err := fx.m.Sync(p.Key, hub, nil); err != nil {
		t.Fatal(err)
	}
	if h = readHubState(t, fx.m, p.Key); h.BudgetTokens != minBudgetTokens || h.Omitted.Budget == 0 {
		t.Fatalf("budget %d, bỏ %+v", h.BudgetTokens, h.Omitted)
	}
	// Chính sách không ghi ngân sách thì về mặc định.
	if _, _, err := fx.m.Sync(p.Key, hub, &Policy{}); err != nil {
		t.Fatal(err)
	}
	if h = readHubState(t, fx.m, p.Key); h.BudgetTokens != DefaultBudgetTokens {
		t.Fatalf("budget %d", h.BudgetTokens)
	}
}

// FR-023: memory bị thay hay gỡ trên hub biến mất ở lần đồng bộ sau.
func TestSyncRemovesSupersededHubItems(t *testing.T) {
	fx := newFixture(t)
	p := fx.enable(t, "")
	first := memory("a", true, "2026-10-01T00:00:00Z", "Dùng Express cho hub.")
	if _, _, err := fx.m.Sync(p.Key, &HubSnapshot{Items: []HubMemory{first}}, nil); err != nil {
		t.Fatal(err)
	}
	next := "b"
	first.SupersededBy = &next
	snap := &HubSnapshot{Items: []HubMemory{first, memory("b", true, "2026-10-21T00:00:00Z", "Dùng Hono cho hub.")}}
	p, _, err := fx.m.Sync(p.Key, snap, nil)
	if err != nil {
		t.Fatal(err)
	}
	file := fx.read(t, "CLAUDE.local.md")
	if strings.Contains(file, "Express") || !strings.Contains(file, "Hono") || p.Hub.Items != 1 {
		t.Fatalf("hub = %+v, file:\n%s", p.Hub, file)
	}
}

// FR-025: không lấy được memory thì giữ bản cũ và thời điểm đồng bộ cũ, ghi lỗi; lần sau lấy được thì xoá lỗi.
func TestSyncHubErrorKeepsPreviousCopy(t *testing.T) {
	fx := newFixture(t)
	p := fx.enable(t, "")
	snap := &HubSnapshot{Items: []HubMemory{memory("a", true, "2026-10-01T00:00:00Z", "Dùng Hono cho hub.")}}
	p, _, err := fx.m.Sync(p.Key, snap, nil)
	if err != nil {
		t.Fatal(err)
	}
	syncedAt := *p.Hub.SyncedAt

	later := time.Date(2026, 10, 22, 11, 0, 0, 0, time.UTC)
	fx.m.Now = func() time.Time { return later }
	p, _, err = fx.m.Sync(p.Key, &HubSnapshot{Error: "Không kết nối được hub: dial tcp: connection refused"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if p.Hub.Items != 1 || p.Hub.SyncedAt == nil || *p.Hub.SyncedAt != syncedAt || p.Hub.LastError == nil ||
		!strings.Contains(*p.Hub.LastError, "connection refused") {
		t.Fatalf("hub = %+v", p.Hub)
	}
	if !strings.Contains(fx.read(t, "CLAUDE.local.md"), "Dùng Hono cho hub.") {
		t.Fatal("mất mục hub cũ khi hub lỗi")
	}

	p, _, err = fx.m.Sync(p.Key, snap, nil)
	if err != nil {
		t.Fatal(err)
	}
	if p.Hub.LastError != nil || p.Hub.SyncedAt == nil || *p.Hub.SyncedAt != "2026-10-22T11:00:00Z" {
		t.Fatalf("hub = %+v", p.Hub)
	}
}

func TestSyncHubErrorWithoutPreviousCopy(t *testing.T) {
	fx := newFixture(t)
	p := fx.enable(t, "")
	pat := fakeKey("gh"+"p_", 36)
	p, _, err := fx.m.Sync(p.Key, &HubSnapshot{Error: "GET https://bot:" + pat + "@hub.local/api: 401"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if p.Hub == nil || p.Hub.Items != 0 || p.Hub.SyncedAt != nil || p.Hub.LastError == nil {
		t.Fatalf("hub = %+v", p.Hub)
	}
	raw, err := os.ReadFile(fx.m.hubPath(p.Key))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), pat) || strings.Contains(*p.Hub.LastError, pat) {
		t.Fatal("lỗi hub lưu nguyên token")
	}
	if !strings.Contains(string(raw), `"items": []`) {
		t.Fatalf("hub.json = %s", raw)
	}
}

func TestSyncHubOtherProjectKeepsPreviousCopy(t *testing.T) {
	fx := newFixture(t)
	id := "7f3c1b52-0a1e-4c0e-9d57-2f4c8f0b6a11"
	p, err := fx.m.Enable(fx.folder, id)
	if err != nil {
		t.Fatal(err)
	}
	ok := &HubSnapshot{ProjectID: strings.ToUpper(id), Items: []HubMemory{memory("a", false, "", "Dùng Hono cho hub.")}}
	if p, _, err = fx.m.Sync(p.Key, ok, nil); err != nil || p.Hub.Items != 1 || p.Hub.LastError != nil {
		t.Fatalf("hub = %+v, %v", p.Hub, err)
	}
	other := &HubSnapshot{ProjectID: "0b6c6a3e-1f7e-4c55-9a64-1c8d0f2b9a10", Items: []HubMemory{memory("z", false, "", "Của dự án khác.")}}
	p, _, err = fx.m.Sync(p.Key, other, nil)
	if err != nil {
		t.Fatal(err)
	}
	if p.Hub.Items != 1 || p.Hub.LastError == nil || strings.Contains(fx.read(t, "CLAUDE.local.md"), "dự án khác") {
		t.Fatalf("hub = %+v", p.Hub)
	}
}

// Desktop có thể đưa nguyên kết quả memory.list của hub: trường lạ bị bỏ qua, supersededBy null là memory đang dùng.
func TestHubSnapshotAcceptsHubMemoryShape(t *testing.T) {
	raw := `{"projectId":"p","items":[
		{"id":"a","kind":"decision","status":"approved","content":"Dùng Hono.","files":["apps/hub"],"scope":"project",
		 "author":{"id":"u1","name":"An"},"createdAt":"2026-10-20T00:00:00.000Z","supersededBy":null,"pinned":false},
		{"id":"b","kind":"decision","status":"approved","content":"Dùng Express.","files":[],"scope":"project",
		 "author":{"id":"u1","name":"An"},"createdAt":"2026-10-01T00:00:00.000Z","supersededBy":"a","pinned":true}]}`
	var snap HubSnapshot
	if err := json.Unmarshal([]byte(raw), &snap); err != nil {
		t.Fatal(err)
	}
	items, om := selectHub(snap.Items, DefaultBudgetTokens)
	if ids(items) != "a" || om != (Omitted{}) {
		t.Fatalf("giữ %s, bỏ %+v", ids(items), om)
	}
}

func TestAutoSyncFromPolicyOrMachine(t *testing.T) {
	machine := AutoSync{Enabled: true, Minutes: 30, Source: "machine"}
	cases := []struct {
		cur    AutoSync
		policy Policy
		want   AutoSync
	}{
		{machine, Policy{}, machine},
		{machine, Policy{MemoryAutoSync: true}, AutoSync{Enabled: true, Minutes: defaultSyncMinutes, Source: "policy"}},
		{machine, Policy{MemoryAutoSync: true, MemorySyncMinutes: 1}, AutoSync{Enabled: true, Minutes: minSyncMinutes, Source: "policy"}},
		{machine, Policy{MemoryAutoSync: true, MemorySyncMinutes: 99999}, AutoSync{Enabled: true, Minutes: maxSyncMinutes, Source: "policy"}},
		{AutoSync{Enabled: true, Minutes: 15, Source: "policy"}, Policy{}, defaultAutoSync()},
	}
	for i, c := range cases {
		if got := autoSyncFor(c.cur, &c.policy); got != c.want {
			t.Errorf("#%d: %+v, muốn %+v", i, got, c.want)
		}
	}
}

func TestProjectCarriesSource(t *testing.T) {
	fx := newFixture(t)
	p := fx.enable(t, "")
	if p.Source != "" {
		t.Fatalf("source = %q", p.Source)
	}
	if p, _ = fx.m.SaveSource(p.Key, "# Nguồn\n\nDùng pnpm.\n"); p.Source != "# Nguồn\n\nDùng pnpm.\n" {
		t.Fatalf("source = %q", p.Source)
	}
	if got := status(t, fx.m, p.Key).Source; got != "# Nguồn\n\nDùng pnpm.\n" {
		t.Fatalf("status source = %q", got)
	}
}
