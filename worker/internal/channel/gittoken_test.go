package channel

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/runner"
)

func TestDecodeJobRunGitToken(t *testing.T) {
	offer := &JobOffer{RunID: "r", Attempt: 1, Spec: json.RawMessage(`{"repoUrl":"https://github.com/acme/web.git","cli":"claude"}`)}
	job, err := decodeJob(offer, Lease{RunToken: "t", Git: &GitCredential{Host: "github.com", Username: "x-access-token", Token: "ghs_run_token_1", ExpiresAt: "2026-10-23T10:00:00.000Z", Repo: "acme/web"}}, "https://hub.example", "p")
	if err != nil {
		t.Fatal(err)
	}
	c := job.Git.Credential()
	want := runner.GitCredential{Host: "github.com", Username: "x-access-token", Token: "ghs_run_token_1", Repo: "acme/web", ExpiresAt: time.Date(2026, 10, 23, 10, 0, 0, 0, time.UTC)}
	if job.Git == nil || c.Host != want.Host || c.Username != want.Username || c.Token != want.Token || c.Repo != want.Repo || !c.ExpiresAt.Equal(want.ExpiresAt) {
		t.Fatalf("Git = %+v", c)
	}
	// Token git không đi qua biến môi trường của CLI.
	for k, v := range job.Env {
		if v == "ghs_run_token_1" {
			t.Fatalf("token git nằm trong env %s", k)
		}
	}
	// Hub cũ không gửi git: runner dùng thông tin git của máy.
	job, err = decodeJob(offer, Lease{RunToken: "t"}, "https://hub.example", "p")
	if err != nil || job.Git != nil {
		t.Fatalf("Git = %v, err = %v", job.Git, err)
	}
}

func TestCapabilitiesIncludeRunGitToken(t *testing.T) {
	for _, sandbox := range []*runner.SandboxConfig{nil, {}} {
		if caps := (Config{Sandbox: sandbox}).capabilities(); !contains(caps, capRunGitToken) {
			t.Fatalf("sandbox %v: capabilities = %v", sandbox != nil, caps)
		}
	}
}

type fakeTimer struct {
	d time.Duration
	c chan time.Time
}

// fakeClock thay j.now và j.after: test tự đẩy giờ và tự bắn timer, không chờ đồng hồ thật.
type fakeClock struct {
	mu     sync.Mutex
	t      time.Time
	timers chan fakeTimer
}

func newFakeClock(j *jobs, t time.Time) *fakeClock {
	c := &fakeClock{t: t, timers: make(chan fakeTimer, 16)}
	j.now = func() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
	j.after = func(d time.Duration) <-chan time.Time {
		ch := make(chan time.Time, 1)
		c.timers <- fakeTimer{d, ch}
		return ch
	}
	return c
}

func (c *fakeClock) set(t time.Time) { c.mu.Lock(); c.t = t; c.mu.Unlock() }

func (c *fakeClock) next(t *testing.T) fakeTimer {
	t.Helper()
	select {
	case tm := <-c.timers:
		return tm
	case <-time.After(waitFor):
		t.Fatal("vòng xin token không hẹn giờ")
		return fakeTimer{}
	}
}

func noSend(t *testing.T, sent <-chan any) {
	t.Helper()
	select {
	case m := <-sent:
		t.Fatalf("gửi thừa %+v", m)
	default:
	}
}

func TestRefreshGitAsksBeforeExpiry(t *testing.T) {
	j := testJobs(t, 1)
	t0 := time.Date(2026, 10, 23, 9, 0, 0, 0, time.UTC)
	clock := newFakeClock(j, t0)
	run := &activeRun{runID: "run-g", attempt: 2, git: runner.NewRunGit(runner.GitCredential{Host: "github.com", Token: "ghs_old_token", ExpiresAt: t0.Add(20 * time.Minute)}), gitWake: make(chan struct{}, 1)}
	j.active[run.runID] = run
	sent := make(chan any, 16)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { j.refreshGit(ctx, run, func(m any) error { sent <- m; return nil }); close(done) }()

	// Còn 20 phút: chờ tới 5 phút trước hạn.
	if tm := clock.next(t); tm.d != 15*time.Minute {
		t.Fatalf("chờ %v", tm.d)
	} else {
		noSend(t, sent)
		clock.set(t0.Add(15 * time.Minute))
		tm.c <- time.Time{}
	}
	tm := clock.next(t)
	req, ok := (<-sent).(GitTokenRequest)
	if !ok || req.Type != "git_token_request" || req.RunID != "run-g" || req.Attempt != 2 {
		t.Fatalf("gói = %+v", req)
	}
	if tm.d != gitTokenRetry {
		t.Fatalf("thử lại sau %v", tm.d)
	}
	// Hub không trả lời: xin lại sau gitTokenRetry.
	clock.set(t0.Add(16 * time.Minute))
	tm.c <- time.Time{}
	tm = clock.next(t)
	if _, ok := (<-sent).(GitTokenRequest); !ok {
		t.Fatal("không xin lại")
	}

	// Hub gửi token mới: thay token và hẹn theo hạn mới.
	j.onGitToken(&GitToken{RunID: "run-g", Attempt: 2, Git: GitCredential{Host: "github.com", Username: "x-access-token", Token: "ghs_new_token", ExpiresAt: t0.Add(2 * time.Hour).Format(time.RFC3339Nano), Repo: "acme/web"}})
	tm = clock.next(t)
	if got := run.git.Credential(); got.Token != "ghs_new_token" || got.Username != "x-access-token" {
		t.Fatalf("token = %+v", got)
	}
	if want := 2*time.Hour - 5*time.Minute - 16*time.Minute; tm.d != want {
		t.Fatalf("chờ %v, cần %v", tm.d, want)
	}
	noSend(t, sent)

	// Token mới cũng sắp hết hạn ngay khi vừa xin: không xin dồn, chờ đủ gitTokenRetry.
	j.onGitToken(&GitToken{RunID: "run-g", Attempt: 2, Git: GitCredential{Host: "github.com", Token: "ghs_short_token", ExpiresAt: t0.Add(18 * time.Minute).Format(time.RFC3339Nano)}})
	if tm = clock.next(t); tm.d != gitTokenRetry {
		t.Fatalf("chờ %v", tm.d)
	}
	noSend(t, sent)

	cancel()
	select {
	case <-done:
	case <-time.After(waitFor):
		t.Fatal("vòng xin token không dừng khi run xong")
	}
}

func TestOnGitTokenDropsUnknownRun(t *testing.T) {
	j := testJobs(t, 1)
	cred := runner.GitCredential{Host: "github.com", Token: "ghs_old_token"}
	run := &activeRun{runID: "run-g", attempt: 2, git: runner.NewRunGit(cred), gitWake: make(chan struct{}, 1)}
	j.active[run.runID] = run
	plain := &activeRun{runID: "run-p", attempt: 1}
	j.active[plain.runID] = plain
	for _, m := range []*GitToken{
		{RunID: "run-x", Attempt: 2, Git: GitCredential{Token: "ghs_other"}},
		{RunID: "run-g", Attempt: 1, Git: GitCredential{Token: "ghs_old_attempt"}},
		// Run nhận lease không có git (hub cũ) thì không có token để thay.
		{RunID: "run-p", Attempt: 1, Git: GitCredential{Token: "ghs_plain"}},
	} {
		j.onGitToken(m)
	}
	if got := run.git.Credential(); got.Token != "ghs_old_token" {
		t.Fatalf("token = %+v", got)
	}
	if plain.git != nil {
		t.Fatal("run không có git nhận token")
	}
}

// Hub có git trong lease: worker xin token mới khi token sắp hết hạn và nhận git_token. Hub cũ không gửi git: worker
// không bao giờ gửi git_token_request, vì hub cũ đóng kết nối khi gặp loại gói lạ.
func TestGitTokenRequestOnlyWithLeaseGit(t *testing.T) {
	remote, base := makeRemote(t)
	hub := newFakeHub(t, true)
	cfg := workerConfig(t, hub, "slow")
	startWorker(t, cfg)
	c := hub.accept(t)
	if !contains(c.hello.Capabilities, capRunGitToken) {
		t.Fatalf("capabilities = %v", c.hello.Capabilities)
	}

	c.offer(t, "run-old", jobSpecFor(remote, base, "ai/old"))
	c.nextType(t, "job_accept")
	c.lease(t, "run-old", "tok")
	for _, m := range c.untilResult(t, "run-old") {
		if m.Type == "git_token_request" {
			t.Fatalf("worker xin token git khi lease không có git: %+v", m)
		}
	}

	c.offer(t, "run-git", jobSpecFor(remote, base, "ai/git"))
	c.nextType(t, "job_accept")
	// Token còn 1 phút (dưới gitTokenRefreshBefore): worker xin ngay khi nhận lease.
	expires := time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano)
	c.send(t, `{"type":"lease","v":1,"id":"l","runId":"run-git","attempt":1,"leaseId":"lease-git","expiresAt":"2026-10-11T00:00:00Z","runToken":"tok","git":{"host":"git.example","username":"oauth2","token":"glpat-run-token-1","expiresAt":%q,"repo":"acme/web"}}`, expires)
	req := c.nextType(t, "git_token_request")
	if req.RunID != "run-git" || req.Attempt != 1 {
		t.Fatalf("git_token_request = %+v", req)
	}
	// git_token của run không có trên máy bị bỏ, không làm đứt kết nối.
	later := time.Now().Add(2 * time.Hour).UTC().Format(time.RFC3339Nano)
	c.send(t, `{"type":"git_token","v":1,"id":"g0","runId":"run-x","attempt":1,"git":{"host":"git.example","username":"oauth2","token":"glpat-run-token-x","expiresAt":%q,"repo":"acme/web"}}`, later)
	c.send(t, `{"type":"git_token","v":1,"id":"g1","runId":"run-git","attempt":1,"git":{"host":"git.example","username":"oauth2","token":"glpat-run-token-2","expiresAt":%q,"repo":"acme/web"}}`, later)
	for _, m := range c.untilResult(t, "run-git") {
		if m.Type == "git_token_request" {
			t.Fatalf("xin token lần nữa sau khi đã nhận token còn hạn: %+v", m)
		}
		if m.Type == "run_result" && m.report().Status != "succeeded" {
			t.Fatalf("run_result = %+v report %+v", m, m.report())
		}
	}
}
