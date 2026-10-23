package terminal

import (
	"context"
	"sync/atomic"

	"github.com/tdduydev/xdev-hive/worker/internal/projects"
	"github.com/tdduydev/xdev-hive/worker/internal/secretstore"
)

// Khởi tạo từ entry point để phiên offline cũng biết file cấu hình, không phụ thuộc welcome của hub.
var localSecretsConfig atomic.Pointer[string]

func SetLocalSecretsConfig(path string) { localSecretsConfig.Store(&path) }

func (l *Local) localSecrets(ctx context.Context, id string, p CreateParams) (secretstore.Granted, error) {
	if p.origin == OriginRemote {
		return secretstore.Granted{}, nil
	}
	config := l.WorkerConfig
	if config == "" {
		if current := localSecretsConfig.Load(); current != nil {
			config = *current
		}
	}
	if config == "" {
		return secretstore.Granted{}, nil
	}
	list, err := projects.Load(projects.DefaultPath(config))
	if err != nil {
		return secretstore.Granted{}, err
	}
	project := projects.Find(list, p.ProjectID)
	if project == nil {
		project = projects.FindFolder(list, p.Cwd)
	}
	if project == nil {
		return secretstore.Granted{}, nil
	}
	return secretstore.Grant(ctx, secretstore.GrantRequest{WorkerConfig: config, LocalID: project.LocalID, Kind: secretstore.KindTerminal, SessionID: id,
		Approve: func(ctx context.Context, req secretstore.ApprovalRequest) (bool, error) {
			return secretstore.AwaitApproval(ctx, config, req)
		},
	})
}
