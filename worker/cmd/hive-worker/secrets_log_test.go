package main

import (
	"encoding/json"
	"testing"

	"github.com/tdduydev/xdev-hive/worker/internal/secretstore"
)

func TestSecretsLogCommands(t *testing.T) {
	cfg := secretsEnv(t)
	for _, p := range []string{appLocalID, apiLocalID} {
		if _, err := secretstore.Append(secretstore.GrantsPath(cfg), secretstore.GrantRecord{Kind: "run", Project: p, Names: []string{"DEMO_CREDENTIAL"}, Policy: "allow", Outcome: "granted"}); err != nil {
			t.Fatal(err)
		}
	}
	r := secretsCall(t, "", "log", "--config", cfg, "--json", "--project", appLocalID, "--name", "DEMO_CREDENTIAL", "--limit", "1")
	var result struct {
		Entries []secretstore.LogEntry `json:"entries"`
	}
	if r.code != 0 || json.Unmarshal([]byte(r.stdout), &result) != nil || len(result.Entries) != 1 || result.Entries[0].Project != appLocalID {
		t.Fatal("lệnh log không lọc đúng")
	}
	r = secretsCall(t, "", "log", "clear", "--config", cfg, "--json")
	var cleared struct {
		Cleared int `json:"cleared"`
	}
	if r.code != 0 || json.Unmarshal([]byte(r.stdout), &cleared) != nil || cleared.Cleared != 2 {
		t.Fatal("không xoá nhật ký")
	}
}
