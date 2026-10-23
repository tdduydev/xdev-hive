package secretstore

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/zalando/go-keyring"
)

const grantLocalID = "3f9a1c0e7b2d4a55"

// slowKeyring là kho giả có trễ mỗi lần đọc, đếm số lần đọc cùng lúc. block khác nil thì mọi lần đọc chờ nó đóng.
type slowKeyring struct {
	delay time.Duration
	block chan struct{}

	mu      sync.Mutex
	items   map[string]string
	active  atomic.Int32
	maxSeen atomic.Int32
}

func newSlowKeyring(delay time.Duration) *slowKeyring {
	return &slowKeyring{delay: delay, items: map[string]string{}}
}

func (k *slowKeyring) Get(s, u string) (string, error) {
	n := k.active.Add(1)
	defer k.active.Add(-1)
	for {
		m := k.maxSeen.Load()
		if n <= m || k.maxSeen.CompareAndSwap(m, n) {
			break
		}
	}
	if k.block != nil {
		<-k.block
	}
	time.Sleep(k.delay)
	k.mu.Lock()
	defer k.mu.Unlock()
	v, ok := k.items[s+"/"+u]
	if !ok {
		return "", keyring.ErrNotFound
	}
	return v, nil
}

func (k *slowKeyring) Set(s, u, p string) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.items[s+"/"+u] = p
	return nil
}

func (k *slowKeyring) Delete(s, u string) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	delete(k.items, s+"/"+u)
	return nil
}

// grantFixture viết danh mục gán names cho grantLocalID và projects.json có dự án đó, trả file cấu hình worker.
func grantFixture(t *testing.T, names ...string) string {
	t.Helper()
	dir := t.TempDir()
	cfg := filepath.Join(dir, "config.json")
	cat := Catalog{Version: CatalogVersion}
	for _, n := range names {
		cat.Secrets = append(cat.Secrets, Secret{Name: n, CreatedAt: t0, ValueChangedAt: t0, Projects: []string{grantLocalID}})
	}
	writeTestJSON(t, CatalogPath(cfg), cat)
	writeTestJSON(t, filepath.Join(dir, "projects.json"), map[string]any{
		"projects": []map[string]any{{"localId": grantLocalID, "name": "shop-api", "folder": dir}},
	})
	return cfg
}

func writeTestJSON(t *testing.T, path string, v any) {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatal(err)
	}
}

func grantLog(t *testing.T, cfg string) []GrantRecord {
	t.Helper()
	recs, err := readRecords(GrantsPath(cfg))
	if err != nil {
		t.Fatal(err)
	}
	return recs
}

// SC-008: 10 bí mật, kho trễ 60 ms mỗi lần đọc. Đọc lần lượt mất 600 ms, quá giới hạn; 4 song song mất 180 ms.
func TestGrantReadsAllInParallel(t *testing.T) {
	kr := newSlowKeyring(60 * time.Millisecond)
	store := &Store{kr: kr}
	var names []string
	for i := range 10 {
		n := fmt.Sprintf("KEY_%02d", i)
		names = append(names, n)
		if err := store.Set(n, "value-"+n); err != nil {
			t.Fatal(err)
		}
	}
	cfg := grantFixture(t, names...)

	start := time.Now()
	g, err := Grant(t.Context(), GrantRequest{WorkerConfig: cfg, Kind: KindRun, SessionID: "run_1", LocalID: grantLocalID, Store: store})
	took := time.Since(start)
	if err != nil {
		t.Fatal(err)
	}
	if took > 500*time.Millisecond {
		t.Fatalf("cấp 10 bí mật mất %v, muốn ≤ 500ms", took)
	}
	if got := kr.maxSeen.Load(); got > readParallel {
		t.Fatalf("đọc %d mục cùng lúc, tối đa %d", got, readParallel)
	}
	if !slices.Equal(g.Names, names) || len(g.Values) != len(names) || len(g.Env) != len(names) {
		t.Fatalf("kết quả thiếu mục: %v", g.Names)
	}
	for i, n := range g.Names {
		if g.Values[i] != "value-"+n || g.Env[n] != g.Values[i] {
			t.Fatalf("giá trị của %s không khớp vị trí", n)
		}
	}

	recs := grantLog(t, cfg)
	if len(recs) != 1 {
		t.Fatalf("muốn 1 dòng nhật ký, có %d", len(recs))
	}
	r := recs[0]
	if r.ID != g.ID || r.Outcome != OutcomeGranted || r.Policy != PolicyAllow || r.ProjectName != "shop-api" ||
		r.Project != grantLocalID || r.SessionID != "run_1" || !slices.Equal(r.Names, names) {
		t.Fatalf("dòng nhật ký sai: %+v", r)
	}
}

func TestGrantNoAssignmentWritesNoLog(t *testing.T) {
	store := &Store{kr: newSlowKeyring(0)}
	cfg := grantFixture(t, "API_TOKEN")
	for _, localID := range []string{"", "khongcogan000000"} {
		g, err := Grant(t.Context(), GrantRequest{WorkerConfig: cfg, Kind: KindRun, LocalID: localID, Store: store})
		if err != nil {
			t.Fatalf("localId %q: %v", localID, err)
		}
		if g.ID != "" || len(g.Env) != 0 || len(g.Names) != 0 {
			t.Fatalf("localId %q: cấp %v", localID, g.Names)
		}
	}
	if _, err := os.Stat(GrantsPath(cfg)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("không có gán mà vẫn tạo nhật ký: %v", err)
	}
}

func TestGrantSkipsReservedNames(t *testing.T) {
	store := &Store{kr: newSlowKeyring(0)}
	if err := store.Set("API_TOKEN", "tok-12345678"); err != nil {
		t.Fatal(err)
	}
	// Danh mục sửa tay: PATH không qua được ValidName nên không có trong kho, nhưng cũng không được đòi đọc.
	cfg := grantFixture(t, "API_TOKEN", "PATH")
	g, err := Grant(t.Context(), GrantRequest{WorkerConfig: cfg, Kind: KindRun, LocalID: grantLocalID, Store: store})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(g.Names, []string{"API_TOKEN"}) {
		t.Fatalf("cấp %v, muốn chỉ API_TOKEN", g.Names)
	}
	if _, ok := g.Env["PATH"]; ok {
		t.Fatal("tên dành riêng lọt vào env")
	}
}

func TestGrantStoreErrorListsNames(t *testing.T) {
	store := &Store{kr: newSlowKeyring(0)}
	const value = "tok-giatribimat-12345678"
	if err := store.Set("API_TOKEN", value); err != nil {
		t.Fatal(err)
	}
	cfg := grantFixture(t, "API_TOKEN", "DB_URL", "SMTP_PASS")
	g, err := Grant(t.Context(), GrantRequest{WorkerConfig: cfg, Kind: KindRun, LocalID: grantLocalID, Store: store})
	if !errors.Is(err, ErrMissing) {
		t.Fatalf("muốn ErrMissing, có %v", err)
	}
	var e *Error
	errors.As(err, &e)
	if !slices.Equal(e.Names, []string{"DB_URL", "SMTP_PASS"}) {
		t.Fatalf("lỗi phải kê đủ tên thiếu: %v", e.Names)
	}
	if strings.Contains(err.Error(), value) || g.Env != nil || g.Values != nil {
		t.Fatal("lỗi kho không được kèm giá trị")
	}
	recs := grantLog(t, cfg)
	if len(recs) != 1 || recs[0].Outcome != OutcomeStoreError {
		t.Fatalf("muốn 1 dòng store_error, có %+v", recs)
	}
}

func TestGrantStoreErrorPrefersWholeStore(t *testing.T) {
	errs := []error{missing("A"), locked("B"), corrupt("C"), errors.New("lạ"), locked("E")}
	err := mergeErrors([]string{"A", "B", "C", "D", "E"}, errs)
	var e *Error
	if !errors.As(err, &e) || e.Code != CodeStoreUnavailable || !slices.Equal(e.Names, []string{"D"}) {
		t.Fatalf("lỗi lạ phải thành store_unavailable và được báo trước: %+v", err)
	}
	err = mergeErrors([]string{"A", "B", "C", "E"}, []error{missing("A"), locked("B"), corrupt("C"), locked("E")})
	if !errors.As(err, &e) || e.Code != CodeStoreLocked || !slices.Equal(e.Names, []string{"B", "E"}) {
		t.Fatalf("kho khoá phải báo trước lỗi từng mục: %+v", err)
	}
}

func TestGrantWindowsEnvLimit(t *testing.T) {
	orig := envBudget
	t.Cleanup(func() { envBudget = orig })
	envBudget = func() int { return 100 }
	store := &Store{kr: newSlowKeyring(0)}
	small, big := strings.Repeat("s", 30), strings.Repeat("b", 80)
	for n, v := range map[string]string{"A_KEY": small, "B_KEY": big} {
		if err := store.Set(n, v); err != nil {
			t.Fatal(err)
		}
	}
	cfg := grantFixture(t, "A_KEY", "B_KEY")
	_, err := Grant(t.Context(), GrantRequest{WorkerConfig: cfg, Kind: KindRun, LocalID: grantLocalID, Store: store})
	if !errors.Is(err, ErrEnvTooLarge) {
		t.Fatalf("muốn ErrEnvTooLarge, có %v", err)
	}
	var e *Error
	errors.As(err, &e)
	if !slices.Equal(e.Names, []string{"B_KEY", "A_KEY"}) {
		t.Fatalf("tên phải xếp từ giá trị lớn nhất: %v", e.Names)
	}
	if strings.Contains(err.Error(), small) || strings.Contains(err.Error(), big) {
		t.Fatal("lỗi không được kèm giá trị")
	}

	envBudget = func() int { return 200 }
	if _, err := Grant(t.Context(), GrantRequest{WorkerConfig: cfg, Kind: KindRun, LocalID: grantLocalID, Store: store}); err != nil {
		t.Fatalf("vừa giới hạn mà vẫn lỗi: %v", err)
	}
}

func TestGrantCancelledIsLocked(t *testing.T) {
	kr := newSlowKeyring(0)
	store := &Store{kr: kr}
	if err := store.Set("API_TOKEN", "tok-12345678"); err != nil {
		t.Fatal(err)
	}
	kr.block = make(chan struct{})
	t.Cleanup(func() { close(kr.block) })
	cfg := grantFixture(t, "API_TOKEN")
	ctx, cancel := context.WithTimeout(t.Context(), 50*time.Millisecond)
	defer cancel()
	_, err := Grant(ctx, GrantRequest{WorkerConfig: cfg, Kind: KindRun, LocalID: grantLocalID, Store: store})
	if !errors.Is(err, ErrLocked) {
		t.Fatalf("kho treo phải báo store_locked, có %v", err)
	}
}
