package main

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/secretstore"
)

func TestSecretsApprovalCommands(t *testing.T) {
	cfg := secretsEnv(t)
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	done := make(chan bool, 1)
	go func() {
		ok, _ := secretstore.AwaitApproval(ctx, cfg, secretstore.ApprovalRequest{Names: []string{"DEMO_CREDENTIAL"}})
		done <- ok
	}()
	var view struct {
		Pending []secretstore.ApprovalRequest `json:"pending"`
	}
	for deadline := time.Now().Add(time.Second); time.Now().Before(deadline); {
		r := secretsCall(t, "", "approvals", "--config", cfg, "--json")
		if r.code != 0 {
			t.Fatal("lệnh approvals chưa có")
		}
		if json.Unmarshal([]byte(r.stdout), &view) != nil {
			t.Fatal("JSON duyệt sai")
		}
		if len(view.Pending) > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if len(view.Pending) != 1 {
		t.Fatal("thiếu yêu cầu duyệt")
	}
	if r := secretsCall(t, "", "approve", "--config", cfg, "--id", view.Pending[0].ID, "--allow"); r.code != 0 {
		t.Fatal("không trả lời được")
	}
	if !<-done {
		t.Fatal("không nhận câu trả lời")
	}
	if r := secretsCall(t, "", "approve", "--config", cfg, "--id", view.Pending[0].ID, "--allow", "--deny"); r.code == 0 {
		t.Fatal("nhận hai lựa chọn cùng lúc")
	}
}
