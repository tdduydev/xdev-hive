package delivery

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// Kube gọi Kubernetes API server bằng REST (không dùng client-go): chỉ cần GET và PATCH workload. Luôn kiểm chứng chỉ;
// không có chế độ bỏ qua. Credential là token ServiceAccount trần.
type Kube struct{ c *apiClient }

// NewKube tạo client. baseURL phải là https; caPEM rỗng thì dùng kho CA của hệ điều hành.
func NewKube(baseURL string, token []byte, caPEM string, timeout time.Duration) (*Kube, error) {
	if !strings.HasPrefix(baseURL, "https://") {
		return nil, newError(CodeBadRequest, 0, "Địa chỉ Kubernetes phải là https.")
	}
	if len(token) == 0 {
		return nil, newError(CodeBadRequest, 0, "Token Kubernetes rỗng.")
	}
	cfg, err := tlsWithCA(caPEM)
	if err != nil {
		return nil, err
	}
	c, err := newAPIClient("Kubernetes", baseURL, "Bearer "+string(token), timeout, cfg)
	if err != nil {
		return nil, err
	}
	return &Kube{c: c}, nil
}

type WorkloadKind string

const (
	KindDeployment  WorkloadKind = "Deployment"
	KindStatefulSet WorkloadKind = "StatefulSet"
	KindDaemonSet   WorkloadKind = "DaemonSet"
)

var kubePlural = map[WorkloadKind]string{
	KindDeployment:  "deployments",
	KindStatefulSet: "statefulsets",
	KindDaemonSet:   "daemonsets",
}

var dnsName = regexp.MustCompile(`^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$`)

type Container struct{ Name, Image string }

type Rollout struct {
	// State là progressing, complete hoặc failed.
	State            string
	Message          string
	DeadlineExceeded bool
}

type Workload struct {
	Kind       WorkloadKind
	Namespace  string
	Name       string
	Containers []Container
	Rollout    Rollout
}

func workloadPath(ns string, kind WorkloadKind, name string) (string, error) {
	plural, ok := kubePlural[kind]
	if !ok {
		return "", newError(CodeBadRequest, 0, "Loại workload %q không hỗ trợ.", string(kind))
	}
	if len(ns) > 253 || !dnsName.MatchString(ns) {
		return "", newError(CodeBadRequest, 0, "Namespace không hợp lệ.")
	}
	if len(name) > 253 || !dnsName.MatchString(name) {
		return "", newError(CodeBadRequest, 0, "Tên workload không hợp lệ.")
	}
	return "/apis/apps/v1/namespaces/" + url.PathEscape(ns) + "/" + plural + "/" + url.PathEscape(name), nil
}

// ComputeRollout dùng cùng quy tắc `kubectl rollout status`: chỉ "xong" khi controller đã thấy bản mới, mọi bản sao đã
// cập nhật, không còn bản sao cũ chờ tắt và các bản sao mới đều sẵn sàng.
func ComputeRollout(kind WorkloadKind, raw obj) Rollout {
	spec, status := rec(raw["spec"]), rec(raw["status"])
	generation := num(rec(raw["metadata"])["generation"])
	observed := num(status["observedGeneration"])
	progress := func(format string, args ...any) Rollout {
		return Rollout{State: "progressing", Message: fmt.Sprintf(format, args...)}
	}
	done := Rollout{State: "complete", Message: "Đã cập nhật xong"}

	if kind == KindDaemonSet {
		replicas, updated, available := num(status["desiredNumberScheduled"]), num(status["updatedNumberScheduled"]), num(status["numberAvailable"])
		switch {
		case generation > observed:
			return progress("Đang chờ DaemonSet nhận cấu hình mới")
		case updated < replicas:
			return progress("Đã cập nhật %d/%d máy", updated, replicas)
		case available < replicas:
			return progress("%d/%d máy đã sẵn sàng", available, replicas)
		}
		return done
	}

	desired := 1
	if v, ok := spec["replicas"].(float64); ok {
		desired = int(v)
	}
	updated, replicas := num(status["updatedReplicas"]), num(status["replicas"])
	// StatefulSet báo readyReplicas; Deployment báo availableReplicas.
	available := num(status["availableReplicas"])
	if kind == KindStatefulSet {
		available = num(status["readyReplicas"])
	}
	if generation > observed {
		return progress("Đang chờ controller nhận cấu hình mới")
	}
	if kind == KindDeployment {
		for _, c := range arr(status["conditions"]) {
			cond := rec(c)
			if cond["type"] == "Progressing" && cond["reason"] == "ProgressDeadlineExceeded" {
				return Rollout{State: "failed", DeadlineExceeded: true, Message: "Quá hạn tiến độ (ProgressDeadlineExceeded): bản mới không sẵn sàng kịp"}
			}
		}
	}
	switch {
	case updated < desired:
		return progress("Đã cập nhật %d/%d bản sao", updated, desired)
	case replicas > updated:
		return progress("Đang chờ %d bản sao cũ tắt", replicas-updated)
	case available < updated:
		return progress("%d/%d bản sao sẵn sàng", available, updated)
	case kind == KindStatefulSet && str(status["currentRevision"]) != str(status["updateRevision"]):
		return progress("Đang chờ StatefulSet chuyển sang revision mới")
	}
	return done
}

// ParseWorkload đọc JSON workload của Kubernetes.
func ParseWorkload(kind WorkloadKind, raw obj) Workload {
	meta := rec(raw["metadata"])
	w := Workload{Kind: kind, Namespace: str(meta["namespace"]), Name: str(meta["name"]), Rollout: ComputeRollout(kind, raw)}
	for _, c := range arr(rec(rec(rec(raw["spec"])["template"])["spec"])["containers"]) {
		m := rec(c)
		if name, image := str(m["name"]), str(m["image"]); name != "" && image != "" {
			w.Containers = append(w.Containers, Container{Name: name, Image: image})
		}
	}
	return w
}

func (k *Kube) GetWorkload(ctx context.Context, ns string, kind WorkloadKind, name string) (Workload, error) {
	p, err := workloadPath(ns, kind, name)
	if err != nil {
		return Workload{}, err
	}
	raw, err := k.c.json(ctx, reqOpts{path: p})
	if err != nil {
		return Workload{}, err
	}
	return ParseWorkload(kind, raw), nil
}

// PatchImage đổi image của một container, giữ nguyên phần còn lại. Đọc trước để báo rõ khi container không có (patch sẽ
// thêm một container thiếu trường thay vì từ chối) và trả image cũ cho việc quay về.
func (k *Kube) PatchImage(ctx context.Context, ns string, kind WorkloadKind, name, container, image string) (previous string, err error) {
	if container == "" {
		return "", newError(CodeBadRequest, 0, "Tên container rỗng.")
	}
	if image == "" || strings.ContainsAny(image, " \t\r\n") {
		return "", newError(CodeBadRequest, 0, "Image không hợp lệ.")
	}
	before, err := k.GetWorkload(ctx, ns, kind, name)
	if err != nil {
		return "", err
	}
	var cur *Container
	for i := range before.Containers {
		if before.Containers[i].Name == container {
			cur = &before.Containers[i]
		}
	}
	if cur == nil {
		return "", newError(CodeBadRequest, 0, "%s %s/%s không có container %q.", kind, ns, name, container)
	}
	p, err := workloadPath(ns, kind, name)
	if err != nil {
		return "", err
	}
	patch := obj{"spec": obj{"template": obj{"spec": obj{"containers": []obj{{"name": container, "image": image}}}}}}
	b, _ := json.Marshal(patch)
	if _, err := k.c.json(ctx, reqOpts{method: http.MethodPatch, path: p, body: string(b), contentType: "application/strategic-merge-patch+json"}); err != nil {
		return "", err
	}
	return cur.Image, nil
}

func (k *Kube) RolloutStatus(ctx context.Context, ns string, kind WorkloadKind, name string) (Rollout, error) {
	w, err := k.GetWorkload(ctx, ns, kind, name)
	return w.Rollout, err
}
