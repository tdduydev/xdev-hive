//go:build keyringit

package secretstore_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/secretstore"
)

// Tiến trình riêng tránh MockInit của unit test đổi provider, khiến bài kiểm kho thật vô tình dùng kho giả.
func TestKeyringIntegration(t *testing.T) {
	cmd := exec.Command(os.Args[0], "-test.run=^TestKeyringIntegrationHelper$")
	cmd.Env = append(os.Environ(), "HIVE_KEYRING_IT_HELPER=1")
	if cmd.Run() != nil {
		t.Fatal("Kiểm kho thật không đạt; kiểm phiên đăng nhập và trạng thái mở khoá của runner.")
	}
}

func TestKeyringIntegrationHelper(t *testing.T) {
	if os.Getenv("HIVE_KEYRING_IT_HELPER") != "1" {
		return
	}
	store := secretstore.NewSystemStore()
	name := "IT_SEC031_" + strings.ToUpper(strconv.FormatInt(time.Now().UnixNano(), 36))
	value := strings.Repeat("đ'\"$x\n", 1000)
	value += strings.Repeat("x", secretstore.MaxValueLen-len(value))
	cleanup := func(n string) {
		t.Cleanup(func() {
			if store.Delete(n) != nil {
				t.Error("không xoá được mục thử khỏi kho thật")
			}
		})
	}
	cleanup(name)
	if store.Set(name, value) != nil {
		t.Fatal("không ghi được 8 KiB vào kho thật")
	}
	got, err := store.Get(name)
	if err != nil || got != value {
		t.Fatal("giá trị nhiều dòng không khớp từng byte")
	}
	var names []string
	for i := range 10 {
		n := name + "_" + string(rune('A'+i))
		names = append(names, n)
		cleanup(n)
		if store.Set(n, "integration-fake-credential") != nil {
			t.Fatal("không ghi được mục thử")
		}
	}
	config := filepath.Join(t.TempDir(), "worker.json")
	if secretstore.ModifyCatalog(secretstore.CatalogPath(config), func(cat *secretstore.Catalog) error {
		for _, n := range names {
			if _, err := cat.Add(n, "", time.Now()); err != nil {
				return err
			}
			if _, err := cat.Assign(n, "integration-project"); err != nil {
				return err
			}
		}
		return nil
	}) != nil {
		t.Fatal("không tạo được danh mục thử")
	}
	start := time.Now()
	g, err := secretstore.Grant(t.Context(), secretstore.GrantRequest{WorkerConfig: config, LocalID: "integration-project", Kind: secretstore.KindRun, Store: store})
	if err != nil || len(g.Env) != len(names) {
		t.Fatal("không cấp được đủ bí mật từ kho thật")
	}
	if time.Since(start) > 500*time.Millisecond {
		t.Fatal("SC-008: đọc 10 bí mật quá 500 ms")
	}
}
