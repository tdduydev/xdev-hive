package delivery

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

// JobSpec phản chiếu `deliveryJobSpec` ở packages/contracts/src/delivery-worker.ts.
type JobSpec struct {
	JobID          string         `json:"jobId"`
	Kind           string         `json:"kind"`
	DeployID       string         `json:"deployId,omitempty"`
	ConfigVersion  int            `json:"configVersion"`
	Target         map[string]any `json:"target"`
	Credential     string         `json:"credential,omitempty"`
	Params         map[string]any `json:"params,omitempty"`
	TimeoutSeconds int            `json:"timeoutSeconds,omitempty"`
}

// Event là một `deliveryEvent` đã sẵn sàng để gửi. Không có kiểu nào mang thân log (FR-050).
type Event map[string]any

// Executor chạy việc cho đúng một đăng ký (Scope). Nơi gọi tạo một Executor cho mỗi đăng ký: credential, log và thư mục
// làm việc không bao giờ dùng chung giữa các tổ chức (FR-104..106).
type Executor struct {
	Scope    Scope
	Store    CredentialReader // kho gốc; Executor tự thu hẹp vào Scope
	LogRoot  string
	WorkerID string
	Emit     func(Event)
	// Poll là chu kỳ hỏi trạng thái hệ ngoài; test đặt nhỏ.
	Poll time.Duration
	Now  func() time.Time

	mu  sync.Mutex
	seq map[string]int
}

func (e *Executor) now() time.Time {
	if e.Now != nil {
		return e.Now()
	}
	return time.Now()
}

func (e *Executor) poll() time.Duration {
	if e.Poll > 0 {
		return e.Poll
	}
	return 3 * time.Second
}

func (e *Executor) emit(jobID, typ string, fields Event) {
	e.mu.Lock()
	if e.seq == nil {
		e.seq = map[string]int{}
	}
	n := e.seq[jobID]
	e.seq[jobID] = n + 1
	e.mu.Unlock()
	ev := Event{"jobId": jobID, "seq": n, "type": typ, "at": e.now().UTC().Format(time.RFC3339)}
	for k, v := range fields {
		ev[k] = v
	}
	if e.Emit != nil {
		e.Emit(ev)
	}
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

// Run chạy một việc tới khi xong và luôn phát đúng một sự kiện finished. Lỗi trả về chỉ để nơi gọi ghi nhận; hub biết
// kết quả qua sự kiện.
func (e *Executor) Run(ctx context.Context, spec JobSpec) error {
	defer func() {
		e.mu.Lock()
		delete(e.seq, spec.JobID)
		e.mu.Unlock()
	}()
	if !e.Scope.Valid() {
		err := newError(CodeBadRequest, 0, "Đăng ký của máy chưa hợp lệ.")
		e.finish(spec.JobID, err)
		return err
	}
	var secrets []string
	creds := ScopedCredentials{Scope: e.Scope, Store: e.Store}
	var credValue []byte
	if spec.Credential != "" {
		v, err := readCredential(creds, spec.Credential)
		if err != nil {
			// Thiếu credential: báo ngay và không chạy bước nào (FR-066).
			e.emit(spec.JobID, "started", Event{"workerId": e.WorkerID})
			e.finish(spec.JobID, err)
			return err
		}
		credValue = v
		secrets = append(secrets, string(v))
		if _, tok, ok := strings.Cut(string(v), ":"); ok {
			secrets = append(secrets, tok)
		}
	}
	jl, err := OpenJobLog(e.Scope.LogDir(e.LogRoot), spec.JobID, secrets...)
	if err != nil {
		e.emit(spec.JobID, "started", Event{"workerId": e.WorkerID})
		werr := newError(CodeUnavailable, 0, "Không ghi được log trên máy chạy.")
		e.finish(spec.JobID, werr)
		return werr
	}
	defer jl.Close()

	timeout := time.Duration(spec.TimeoutSeconds) * time.Second
	if timeout <= 0 {
		timeout = 30 * time.Minute
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	e.emit(spec.JobID, "started", Event{"workerId": e.WorkerID})
	jl.Printf("bắt đầu việc %s (%s), cấu hình v%d", spec.JobID, spec.Kind, spec.ConfigVersion)

	err = e.dispatch(runCtx, spec, credValue, jl)
	if err != nil && ctx.Err() == nil && errors.Is(runCtx.Err(), context.DeadlineExceeded) {
		err = newError(CodeTimeout, 0, "Việc chạy quá thời hạn %d giây.", int(timeout.Seconds()))
	}
	if err != nil {
		jl.Printf("thất bại: %s", err.Error())
	} else {
		jl.Printf("hoàn tất")
	}
	e.finish(spec.JobID, err)
	return err
}

func (e *Executor) finish(jobID string, err error) {
	if err == nil {
		e.emit(jobID, "finished", Event{"state": "succeeded"})
		return
	}
	code := CodeOf(err)
	state := "failed"
	if code == CodeCanceled {
		state = "canceled"
	}
	msg := err.Error()
	var de *Error
	if errors.As(err, &de) {
		msg = de.Message
	}
	e.emit(jobID, "finished", Event{"state": state, "error": Event{"code": string(code), "message": truncate(msg, 200)}})
}

func (e *Executor) step(jobID, name, state string) {
	e.emit(jobID, "step", Event{"name": name, "state": state})
}

func (e *Executor) dispatch(ctx context.Context, spec JobSpec, cred []byte, jl *JobLog) error {
	switch spec.Kind {
	case "jenkins-job":
		return e.runJenkins(ctx, spec, cred, jl)
	case "argocd":
		return e.runArgo(ctx, spec, cred, jl)
	default:
		// Worker chỉ bấm Jenkins và Argo CD rồi theo dõi; loại khác (gitlab-manual, ci-action) chưa có trên worker; hub không giao khi worker không khai khả năng.
		return newError(CodeUnsupported, 0, "Worker này chưa hỗ trợ loại việc %q.", spec.Kind)
	}
}

func targetStr(m map[string]any, key string) string {
	s, _ := m[key].(string)
	return s
}

func requireTarget(spec JobSpec, keys ...string) error {
	for _, k := range keys {
		if targetStr(spec.Target, k) == "" {
			return newError(CodeBadRequest, 0, "Cấu hình đích thiếu %q.", k)
		}
	}
	return nil
}

func ctxErr(ctx context.Context) error {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return newError(CodeTimeout, 0, "Hết thời gian chờ.")
	}
	return newError(CodeCanceled, 0, "Đã huỷ.")
}

func (e *Executor) runJenkins(ctx context.Context, spec JobSpec, cred []byte, jl *JobLog) error {
	if err := requireTarget(spec, "baseUrl", "job"); err != nil {
		return err
	}
	j, err := NewJenkins(targetStr(spec.Target, "baseUrl"), cred, 0)
	if err != nil {
		return err
	}
	job := targetStr(spec.Target, "job")
	var params map[string]string
	if p, ok := spec.Params["parameters"].(map[string]any); ok {
		params = map[string]string{}
		for k, v := range p {
			params[k] = fmt.Sprint(v)
		}
	}
	e.step(spec.JobID, "Bấm build", "running")
	tr, err := j.Trigger(ctx, job, params, 2*time.Minute, e.poll())
	if err != nil {
		e.step(spec.JobID, "Bấm build", "failed")
		return err
	}
	if tr.Cancelled || tr.Number == 0 {
		e.step(spec.JobID, "Bấm build", "failed")
		return newError(CodeUnavailable, 0, "Jenkins huỷ hoặc chưa nhận build.")
	}
	e.step(spec.JobID, "Bấm build", "succeeded")
	e.emit(spec.JobID, "external", Event{"ref": fmt.Sprintf("%s#%d", job, tr.Number), "url": tr.URL})
	jl.Printf("Jenkins build %s #%d", job, tr.Number)

	e.step(spec.JobID, "Chờ build", "running")
	var off int64
	for {
		if l, err := j.Log(ctx, job, tr.Number, off); err == nil {
			_, _ = jl.Write([]byte(l.Text))
			off = l.Next
		}
		b, err := j.Build(ctx, job, tr.Number)
		if err != nil {
			if ctx.Err() != nil {
				_ = j.Stop(context.WithoutCancel(ctx), job, tr.Number)
				return ctxErr(ctx)
			}
			return err
		}
		if !b.Building && b.Result != "" {
			if b.Result != "SUCCESS" {
				e.step(spec.JobID, "Chờ build", "failed")
				return newError(CodeUnavailable, 0, "Build Jenkins kết thúc với kết quả %s.", b.Result)
			}
			e.step(spec.JobID, "Chờ build", "succeeded")
			return nil
		}
		if err := sleepCtx(ctx, e.poll()); err != nil {
			_ = j.Stop(context.WithoutCancel(ctx), job, tr.Number)
			return ctxErr(ctx)
		}
	}
}

func (e *Executor) runArgo(ctx context.Context, spec JobSpec, cred []byte, jl *JobLog) error {
	if err := requireTarget(spec, "baseUrl", "app"); err != nil {
		return err
	}
	a, err := NewArgoCD(targetStr(spec.Target, "baseUrl"), cred, 0)
	if err != nil {
		return err
	}
	app := targetStr(spec.Target, "app")
	action, _ := spec.Params["action"].(string)
	e.emit(spec.JobID, "external", Event{"ref": app})
	switch action {
	case "rollback":
		id, ok := spec.Params["historyId"].(float64)
		if !ok {
			return newError(CodeBadRequest, 0, "Thiếu historyId để quay về.")
		}
		cur, err := a.GetApplication(ctx, app)
		if err != nil {
			return err
		}
		if cur.AutoSync {
			return newError(CodeBadRequest, 0, "Ứng dụng đang bật autoSync nên Argo CD không cho quay về. Tắt autoSync rồi thử lại.")
		}
		e.step(spec.JobID, "Quay về", "running")
		if _, err := a.Rollback(ctx, app, int(id)); err != nil {
			e.step(spec.JobID, "Quay về", "failed")
			return err
		}
	default:
		rev, _ := spec.Params["revision"].(string)
		e.step(spec.JobID, "Sync", "running")
		if _, err := a.Sync(ctx, app, rev); err != nil {
			e.step(spec.JobID, "Sync", "failed")
			return err
		}
	}
	jl.Printf("Argo CD %s: đã gửi lệnh, chờ kết quả", app)
	for {
		cur, err := a.GetApplication(ctx, app)
		if err != nil {
			if ctx.Err() != nil {
				return ctxErr(ctx)
			}
			return err
		}
		switch {
		case cur.OpPhase == "Failed" || cur.OpPhase == "Error":
			return newError(CodeUnavailable, 0, "Argo CD báo thao tác thất bại.")
		case cur.OpPhase == "Succeeded" && cur.SyncStatus == "Synced" && cur.Health == "Healthy":
			e.step(spec.JobID, "Sync", "succeeded")
			return nil
		case cur.Health == "Degraded" && cur.OpPhase == "Succeeded":
			return newError(CodeUnavailable, 0, "Ứng dụng Argo CD ở trạng thái Degraded.")
		}
		if err := sleepCtx(ctx, e.poll()); err != nil {
			return ctxErr(ctx)
		}
	}
}
