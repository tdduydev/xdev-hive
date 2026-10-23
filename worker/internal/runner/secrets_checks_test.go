package runner

import (
	"io"
	"runtime"
	"strings"
	"testing"

	"github.com/tdduydev/xdev-hive/worker/internal/secretmask"
	"github.com/tdduydev/xdev-hive/worker/internal/secretstore"
)

func TestSecretCheckMasksBeforeTailTruncation(t *testing.T) {
	value := "unique-prefix-" + strings.Repeat("a", 1600) + "-unique-end"
	config, _ := secretFixture(t)
	store := secretstore.NewStore()
	if store.Set("DEMO_CREDENTIAL", value) != nil {
		t.Fatal("không tạo được giá trị dài trong kho giả")
	}
	g, err := secretstore.Grant(t.Context(), secretstore.GrantRequest{WorkerConfig: config, LocalID: "local-demo", Kind: secretstore.KindRun, Store: store})
	if err != nil {
		t.Fatal("không cấp được bí mật giả")
	}
	run := `printf %s "$DEMO_CREDENTIAL"`
	if runtime.GOOS == "windows" {
		run = "echo %DEMO_CREDENTIAL%"
	}
	secure := newSecretSink(nil, secretmask.New(g.Values), config, g)
	job := Job{RunID: "secret-check", grantedEnv: g.Env, grantedValues: g.Values, secretSink: secure, Checks: []CheckCommand{{Run: run}}}
	results, err := (Runner{}).runChecks(t.Context(), job, t.TempDir(), io.Discard)
	if err != nil || len(results) != 1 || results[0].Exit != 0 {
		t.Fatal("lệnh kiểm không nhận được bí mật")
	}
	if strings.Contains(results[0].Tail, "unique-prefix-") || !strings.Contains(results[0].Tail, redacted) {
		t.Fatal("cắt đuôi trước khi che làm lộ phần đầu giá trị")
	}
	cat, _ := secretstore.LoadCatalog(secretstore.CatalogPath(config))
	entries, err := secretstore.ReadLog(secretstore.GrantsPath(config), secretstore.LogFilter{}, cat)
	if err != nil || len(entries) != 1 || !entries[0].Names[0].Leaked {
		t.Fatal("lệnh kiểm đã che nhưng nhật ký cấp chưa đánh dấu")
	}
}
