package delivery

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"regexp"
	"time"
)

// ArgoCD là client Argo CD chạy từ worker (port của hub `clients/argocd.ts`). Credential là token trần.
type ArgoCD struct{ c *apiClient }

func NewArgoCD(baseURL string, token []byte, timeout time.Duration) (*ArgoCD, error) {
	if len(token) == 0 {
		return nil, newError(CodeBadRequest, 0, "Token Argo CD rỗng.")
	}
	c, err := newAPIClient("Argo CD", baseURL, "Bearer "+string(token), timeout, nil)
	if err != nil {
		return nil, err
	}
	return &ArgoCD{c: c}, nil
}

type ArgoHistory struct {
	ID         int
	Revision   string
	DeployedAt string
}

type ArgoApp struct {
	Name        string
	SyncStatus  string
	Health      string
	Revision    string
	AutoSync    bool
	OpPhase     string // rỗng khi chưa có thao tác
	OpMessage   string
	History     []ArgoHistory
	ResourceVer string
}

var argoName = regexp.MustCompile(`^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$`)

func appPath(name string) (string, error) {
	if len(name) > 253 || !argoName.MatchString(name) {
		return "", newError(CodeBadRequest, 0, "Tên ứng dụng Argo CD không hợp lệ.")
	}
	return "/api/v1/applications/" + url.PathEscape(name), nil
}

// ParseArgoApp đọc JSON ứng dụng của Argo CD; trường thiếu thành giá trị rỗng.
func ParseArgoApp(raw obj) ArgoApp {
	meta, spec, status := rec(raw["metadata"]), rec(raw["spec"]), rec(raw["status"])
	op := rec(status["operationState"])
	app := ArgoApp{
		Name:        str(meta["name"]),
		ResourceVer: str(meta["resourceVersion"]),
		SyncStatus:  str(rec(status["sync"])["status"]),
		Revision:    str(rec(status["sync"])["revision"]),
		Health:      str(rec(status["health"])["status"]),
		AutoSync:    rec(spec["syncPolicy"])["automated"] != nil,
		OpPhase:     str(op["phase"]),
		OpMessage:   str(op["message"]),
	}
	for _, h := range arr(status["history"]) {
		m := rec(h)
		if _, ok := m["id"].(float64); ok {
			app.History = append(app.History, ArgoHistory{ID: num(m["id"]), Revision: str(m["revision"]), DeployedAt: str(m["deployedAt"])})
		}
	}
	return app
}

func (a *ArgoCD) GetApplication(ctx context.Context, name string) (ArgoApp, error) {
	p, err := appPath(name)
	if err != nil {
		return ArgoApp{}, err
	}
	raw, err := a.c.json(ctx, reqOpts{path: p})
	if err != nil {
		return ArgoApp{}, err
	}
	return ParseArgoApp(raw), nil
}

// Sync bắt đầu sync; kết quả theo dõi bằng GetApplication.
func (a *ArgoCD) Sync(ctx context.Context, name, revision string) (ArgoApp, error) {
	p, err := appPath(name)
	if err != nil {
		return ArgoApp{}, err
	}
	body := obj{}
	if revision != "" {
		body["revision"] = revision
	}
	b, _ := json.Marshal(body)
	raw, err := a.c.json(ctx, reqOpts{method: http.MethodPost, path: p + "/sync", body: string(b), contentType: "application/json"})
	if err != nil {
		return ArgoApp{}, err
	}
	return ParseArgoApp(raw), nil
}

// Rollback về mục history; Argo CD từ chối khi autoSync đang bật nên nơi gọi kiểm AutoSync trước.
func (a *ArgoCD) Rollback(ctx context.Context, name string, historyID int) (ArgoApp, error) {
	p, err := appPath(name)
	if err != nil {
		return ArgoApp{}, err
	}
	if historyID < 0 {
		return ArgoApp{}, newError(CodeBadRequest, 0, "historyId không được âm.")
	}
	b, _ := json.Marshal(obj{"id": historyID})
	raw, err := a.c.json(ctx, reqOpts{method: http.MethodPost, path: p + "/rollback", body: string(b), contentType: "application/json"})
	if err != nil {
		return ArgoApp{}, err
	}
	return ParseArgoApp(raw), nil
}
