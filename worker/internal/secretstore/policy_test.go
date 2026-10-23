package secretstore

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/projects"
)

func TestGrantPolicyBranches(t *testing.T) {
	for _, tc := range []struct {
		policy, outcome string
		allow           bool
		approvalErr     error
	}{
		{PolicyDeny, OutcomeDenied, false, nil}, {PolicyApprove, OutcomeDeclined, false, nil},
		{PolicyApprove, OutcomeTimeout, false, ErrApprovalTimeout}, {PolicyApprove, OutcomeGranted, true, nil},
		{PolicyAllow, OutcomeGranted, true, nil},
	} {
		t.Run(tc.policy+tc.outcome, func(t *testing.T) {
			cfg := grantFixture(t, "DEMO_CREDENTIAL")
			kr := newSlowKeyring(0)
			store := &Store{kr: kr}
			if err := store.Set("DEMO_CREDENTIAL", "fake-credential-for-policy"); err != nil {
				t.Fatal(err)
			}
			calls := 0
			g, err := Grant(t.Context(), GrantRequest{WorkerConfig: cfg, LocalID: grantLocalID, Kind: KindRun, Policy: tc.policy, Store: store, Approve: func(context.Context, ApprovalRequest) (bool, error) { calls++; return tc.allow, tc.approvalErr }})
			if err != nil {
				t.Fatal(err)
			}
			if (len(g.Values) > 0) != tc.allow || g.Outcome != tc.outcome {
				t.Fatal("sai kết quả chính sách")
			}
			if !tc.allow && kr.maxSeen.Load() != 0 {
				t.Fatal("đã đọc kho khi chưa cho phép")
			}
			if (calls == 1) != (tc.policy == PolicyApprove) {
				t.Fatal("hỏi duyệt sai nhánh")
			}
			entries := grantLog(t, cfg)
			if len(entries) != 1 || entries[0].Outcome != tc.outcome {
				t.Fatal("sai nhật ký chính sách")
			}
		})
	}
}

func TestOfflinePolicyDefaults(t *testing.T) {
	cfg := grantFixture(t, "DEMO_CREDENTIAL")
	if got := TerminalPolicy(cfg, grantLocalID, ""); got != PolicyAllow {
		t.Fatal("dự án chưa liên kết phải allow")
	}
	writeTestJSON(t, projects.DefaultPath(cfg), map[string]any{"projects": []projects.Project{{LocalID: grantLocalID, ProjectID: "hub-project", Name: "shop"}}})
	if got := TerminalPolicy(cfg, grantLocalID, "https://hub.test"); got != PolicyDeny {
		t.Fatal("chưa biết chính sách phải deny")
	}
	if err := SavePolicy(cfg, "https://hub.test/", PolicyApprove); err != nil {
		t.Fatal(err)
	}
	if got := TerminalPolicy(cfg, grantLocalID, "https://hub.test"); got != PolicyApprove {
		t.Fatal("không đọc lại cache")
	}
	if err := SavePolicy(cfg, "https://hub.test", ""); err != nil {
		t.Fatal(err)
	}
	if got := TerminalPolicy(cfg, grantLocalID, "https://hub.test"); got != PolicyApprove {
		t.Fatal("hub cũ làm mất cache")
	}
}

func TestApprovalLifecycle(t *testing.T) {
	cfg := filepath.Join(t.TempDir(), "worker.json")
	result := make(chan error, 1)
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	go func() {
		allowed, err := AwaitApproval(ctx, cfg, ApprovalRequest{RunID: "run", Names: []string{"DEMO_CREDENTIAL"}})
		if err == nil && !allowed {
			err = errors.New("không được cho phép")
		}
		result <- err
	}()
	var pending []ApprovalRequest
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		pending, _ = PendingApprovals(cfg)
		if len(pending) > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if len(pending) != 1 {
		t.Fatal("thiếu yêu cầu duyệt")
	}
	if err := AnswerApproval(cfg, pending[0].ID, true); err != nil {
		t.Fatal(err)
	}
	if err := <-result; err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(approvalPath(cfg, pending[0].ID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("chưa dọn file duyệt")
	}
	if AnswerApproval(cfg, "../../outside", true) == nil {
		t.Fatal("nhận id vượt thư mục")
	}
	ctx2, cancel2 := context.WithTimeout(t.Context(), 10*time.Millisecond)
	defer cancel2()
	_, err := AwaitApproval(ctx2, cfg, ApprovalRequest{Names: []string{"DEMO_CREDENTIAL"}})
	if !errors.Is(err, ErrApprovalTimeout) {
		t.Fatal("hết hạn không từ chối")
	}
}
