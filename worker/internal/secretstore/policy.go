package secretstore

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/config"
	"github.com/tdduydev/xdev-hive/worker/internal/projects"
)

type savedPolicy struct {
	SecretInjection string    `json:"secretInjection"`
	At              time.Time `json:"at"`
}
type policyFile struct {
	Version int                    `json:"version"`
	Hubs    map[string]savedPolicy `json:"hubs"`
}

func validPolicy(p string) bool { return p == PolicyAllow || p == PolicyApprove || p == PolicyDeny }
func policyPath(workerConfig string) string {
	return filepath.Join(filepath.Dir(workerConfig), "secrets-policy.json")
}

func SavePolicy(workerConfig, hub, policy string) error {
	if policy == "" {
		return nil
	}
	if !validPolicy(policy) || workerConfig == "" || hub == "" {
		return errors.New("Chính sách bí mật không hợp lệ.")
	}
	path := policyPath(workerConfig)
	return projects.WithLock(path, func() error {
		f := policyFile{Version: 1, Hubs: map[string]savedPolicy{}}
		b, err := os.ReadFile(path)
		if err == nil {
			if json.Unmarshal(b, &f) != nil || f.Version != 1 {
				return errors.New("Không đọc được chính sách bí mật đã lưu.")
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			return errors.New("Không đọc được chính sách bí mật đã lưu.")
		}
		if f.Hubs == nil {
			f.Hubs = map[string]savedPolicy{}
		}
		f.Hubs[strings.TrimRight(hub, "/")] = savedPolicy{SecretInjection: policy, At: time.Now().UTC()}
		return projects.WriteJSON(path, f)
	})
}

// Chưa biết tổ chức cho phép gì thì không cấp; repo chưa liên kết dùng chính sách của người ở máy.
func TerminalPolicy(workerConfig, localID, hub string) string {
	list, err := projects.Load(projects.DefaultPath(workerConfig))
	if err != nil {
		return PolicyDeny
	}
	p := projects.FindLocal(list, localID)
	if p == nil {
		return PolicyDeny
	}
	if p.ProjectID == "" {
		return PolicyAllow
	}
	if hub == "" {
		if c, err := config.Load(workerConfig); err == nil {
			hub = c.HubURL
		}
	}
	b, err := os.ReadFile(policyPath(workerConfig))
	if err != nil {
		return PolicyDeny
	}
	var f policyFile
	if json.Unmarshal(b, &f) != nil || f.Version != 1 {
		return PolicyDeny
	}
	policy := f.Hubs[strings.TrimRight(hub, "/")].SecretInjection
	if !validPolicy(policy) {
		return PolicyDeny
	}
	return policy
}
