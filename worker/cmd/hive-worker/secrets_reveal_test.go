package main

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/tdduydev/xdev-hive/worker/internal/secretstore"
)

func TestSecretsRevealAndPurge(t *testing.T) {
	cfg := secretsEnv(t)
	for _, args := range [][]string{{"set", "--name", "DEMO_CREDENTIAL"}, {"assign", "--name", "DEMO_CREDENTIAL", "--project", appLocalID}} {
		r := secretsCall(t, valueJSON(fakeValue), append(args, "--config", cfg)...)
		if r.code != 0 || strings.Contains(r.stdout, fakeValue) {
			t.Fatal("ghi/gán làm lộ giá trị hoặc lỗi")
		}
	}
	r := secretsCall(t, "", "reveal", "--config", cfg, "--name", "DEMO_CREDENTIAL", "--copy")
	var value struct {
		Value string `json:"value"`
	}
	if r.code != 0 || json.Unmarshal([]byte(r.stdout), &value) != nil || value.Value != fakeValue {
		t.Fatal("reveal trả sai giá trị")
	}
	cat, _ := secretstore.LoadCatalog(secretstore.CatalogPath(cfg))
	log, err := secretstore.ReadLog(secretstore.GrantsPath(cfg), secretstore.LogFilter{}, cat)
	if err != nil || len(log) != 1 || log[0].Kind != "reveal" || !log[0].Copy {
		t.Fatal("không ghi lịch sử sao chép")
	}
	r = secretsCall(t, "", "purge", "--config", cfg, "--project", appLocalID)
	if r.code != 0 || strings.Contains(r.stdout, fakeValue) {
		t.Fatal("gỡ gán lỗi")
	}
	cat, _ = secretstore.LoadCatalog(secretstore.CatalogPath(cfg))
	if len(cat.ForProject(appLocalID)) != 0 {
		t.Fatal("còn gán dự án")
	}
	if _, err := secretsStore().Get("DEMO_CREDENTIAL"); err != nil {
		t.Fatal("gỡ dự án đã xoá giá trị")
	}
	r = secretsCall(t, "", "purge", "--config", cfg, "--all")
	var purged struct{ Removed, Left []string }
	if r.code != 0 || json.Unmarshal([]byte(r.stdout), &purged) != nil || len(purged.Removed) != 1 || len(purged.Left) != 0 {
		t.Fatal("xoá mọi bí mật lỗi")
	}
	if _, err := secretsStore().Get("DEMO_CREDENTIAL"); err == nil {
		t.Fatal("giá trị vẫn trong kho")
	}
}
