package runner

import (
	"context"
	"testing"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/secretstore"
)

func TestRunnerBackgroundApproval(t *testing.T) {
	for _, allow := range []bool{true, false} {
		t.Run(map[bool]string{true: "allow", false: "deny"}[allow], func(t *testing.T) {
			config, _ := secretFixture(t)
			r := Runner{WorkerConfig: config, SecretStore: secretstore.NewStore()}
			ctx, cancel := context.WithTimeout(t.Context(), 4*time.Second)
			defer cancel()
			done := make(chan secretstore.Granted, 1)
			go func() {
				g, _ := r.grantSecrets(ctx, Job{RunID: "approval", Attempt: 1, LocalID: "local-demo", Policy: JobPolicy{SecretInjection: "approve"}})
				done <- g
			}()
			var pending []secretstore.ApprovalRequest
			deadline := time.Now().Add(2 * time.Second)
			for time.Now().Before(deadline) {
				pending, _ = secretstore.PendingApprovals(config)
				if len(pending) > 0 {
					break
				}
				time.Sleep(10 * time.Millisecond)
			}
			if len(pending) != 1 {
				t.Fatal("run nền không tạo file chờ duyệt")
			}
			if err := secretstore.AnswerApproval(config, pending[0].ID, allow); err != nil {
				t.Fatal(err)
			}
			g := <-done
			if (len(g.Values) > 0) != allow {
				t.Fatal("run dùng sai quyết định duyệt")
			}
			if !allow && secretContext(g) == "" {
				t.Fatal("thiếu khối không có bí mật")
			}
		})
	}
}
