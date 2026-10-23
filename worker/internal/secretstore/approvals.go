package secretstore

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/projects"
)

const ApprovalTTL = 120 * time.Second

var ErrApprovalTimeout = errors.New("Đã hết thời gian chờ duyệt bí mật.")
var approvalIDPattern = regexp.MustCompile(`^a_[0-9A-HJKMNP-TV-Z]{26}$`)

type ApprovalRequest struct {
	ID          string    `json:"id"`
	RunID       string    `json:"runId"`
	Project     string    `json:"project"`
	ProjectName string    `json:"projectName"`
	Names       []string  `json:"names"`
	ExpiresAt   time.Time `json:"expiresAt"`
}
type approvalFile struct {
	ApprovalRequest
	CreatedAt time.Time `json:"createdAt"`
	Answer    *string   `json:"answer"`
}

func approvalsDir(config string) string {
	return filepath.Join(filepath.Dir(config), "secret-approvals")
}
func approvalPath(config, id string) string { return filepath.Join(approvalsDir(config), id+".json") }

func readApproval(path string) (approvalFile, error) {
	var f approvalFile
	b, err := os.ReadFile(path)
	if err != nil {
		return f, err
	}
	if json.Unmarshal(b, &f) != nil || !approvalIDPattern.MatchString(f.ID) {
		return f, errors.New("Yêu cầu duyệt bí mật không hợp lệ.")
	}
	return f, nil
}

func PendingApprovals(config string) ([]ApprovalRequest, error) {
	entries, err := os.ReadDir(approvalsDir(config))
	out := []ApprovalRequest{}
	if errors.Is(err, os.ErrNotExist) {
		return out, nil
	}
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		id := strings.TrimSuffix(entry.Name(), ".json")
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") || !approvalIDPattern.MatchString(id) {
			continue
		}
		path := approvalPath(config, id)
		err := projects.WithLock(path, func() error {
			f, err := readApproval(path)
			if errors.Is(err, os.ErrNotExist) {
				return nil
			}
			if err != nil {
				return err
			}
			if !time.Now().Before(f.ExpiresAt) {
				return os.Remove(path)
			}
			if f.Answer == nil {
				out = append(out, f.ApprovalRequest)
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	return out, nil
}

func AnswerApproval(config, id string, allow bool) error {
	if !approvalIDPattern.MatchString(id) {
		return errors.New("Mã yêu cầu duyệt bí mật không hợp lệ.")
	}
	path := approvalPath(config, id)
	return projects.WithLock(path, func() error {
		f, err := readApproval(path)
		if err != nil {
			return errors.New("Không tìm thấy yêu cầu duyệt bí mật.")
		}
		if f.Answer != nil || !time.Now().Before(f.ExpiresAt) {
			return errors.New("Yêu cầu duyệt đã kết thúc hoặc hết hạn.")
		}
		answer := "deny"
		if allow {
			answer = "allow"
		}
		f.Answer = &answer
		return projects.WriteJSON(path, f)
	})
}

func AwaitApproval(ctx context.Context, config string, req ApprovalRequest) (bool, error) {
	if _, err := PendingApprovals(config); err != nil {
		return false, err
	}
	now := time.Now()
	req.ID = "a_" + strings.TrimPrefix(newGrantID(now), "g_")
	req.ExpiresAt = now.Add(ApprovalTTL)
	if deadline, ok := ctx.Deadline(); ok && deadline.Before(req.ExpiresAt) {
		req.ExpiresAt = deadline
	}
	path := approvalPath(config, req.ID)
	if err := os.MkdirAll(approvalsDir(config), 0700); err != nil {
		return false, err
	}
	if err := projects.WriteJSON(path, approvalFile{ApprovalRequest: req, CreatedAt: now}); err != nil {
		return false, err
	}
	defer os.Remove(path)
	waitCtx, cancel := context.WithDeadline(ctx, req.ExpiresAt)
	defer cancel()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-waitCtx.Done():
			return false, ErrApprovalTimeout
		case <-ticker.C:
			var answer *string
			err := projects.WithLock(path, func() error {
				f, err := readApproval(path)
				if err == nil {
					answer = f.Answer
				}
				return err
			})
			if errors.Is(err, os.ErrNotExist) {
				return false, ErrApprovalTimeout
			}
			if err != nil {
				return false, err
			}
			if answer != nil {
				return *answer == "allow", nil
			}
		}
	}
}
