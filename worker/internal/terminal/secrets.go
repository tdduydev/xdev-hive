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

func (l *Local) secretsConfig() string {
	config := l.WorkerConfig
	if config == "" {
		if current := localSecretsConfig.Load(); current != nil {
			config = *current
		}
	}
	return config
}

func (l *Local) localSecrets(ctx context.Context, id string, p CreateParams) (secretstore.Granted, error) {
	if p.origin == OriginRemote {
		return secretstore.Granted{}, nil
	}
	config := l.secretsConfig()
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
	return secretstore.Grant(ctx, secretstore.GrantRequest{WorkerConfig: config, LocalID: project.LocalID, Kind: secretstore.KindTerminal, SessionID: id, Store: l.SecretStore,
		Approve: func(ctx context.Context, req secretstore.ApprovalRequest) (bool, error) {
			return secretstore.AwaitApproval(ctx, config, req)
		},
	})
}

func (l *Local) markSecretLeaks(g secretstore.Granted, hits []int, seen map[int]bool) {
	var names []string
	for _, i := range hits {
		if i < 0 || i >= len(g.Names) || seen[i] {
			continue
		}
		seen[i] = true
		names = append(names, g.Names[i])
		l.log().Info("Đã che bí mật tại máy", "name", g.Names[i])
	}
	if g.ID != "" && len(names) > 0 {
		_ = secretstore.MarkLeaked(secretstore.GrantsPath(l.secretsConfig()), g.ID, names)
	}
}
