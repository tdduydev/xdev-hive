package channel

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/tdduydev/xdev-hive/worker/internal/projects"
	"github.com/tdduydev/xdev-hive/worker/internal/runner"
)

const boundID = "0a0a0a0a-0000-4000-8000-000000000003"

// writeProjects ghi projects.json có dự án boundID gắn với một thư mục, toàn quyền theo full.
func writeProjects(t *testing.T, full bool) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "projects.json")
	list := []projects.Project{{ProjectID: boundID, Name: "app", Folder: "/repo/app", FullPermission: full}, {Name: "chưa gắn", Folder: "/repo/cu"}}
	b, _ := json.Marshal(map[string]any{"projects": list})
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// Quyền thực dùng theo ADR 0020: máy đã gắn dự án thì theo công tắc của máy và chính sách tổ chức; chưa gắn thì như cũ.
func TestLocalProjectEffectivePermission(t *testing.T) {
	on := []projects.Project{{ProjectID: boundID, Folder: "/repo/app", FullPermission: true}}
	off := []projects.Project{{ProjectID: boundID, Folder: "/repo/app"}}
	for _, tc := range []struct {
		name string
		spec string
		list []projects.Project
		want string
		repo string
	}{
		{"máy bật, tổ chức cho", `{"projectId":"` + boundID + `","runPermissions":"workspace","fullAllowed":true}`, on, "full", "/repo/app"},
		{"máy bật, tổ chức cấm", `{"projectId":"` + boundID + `","runPermissions":"workspace","fullAllowed":false}`, on, "workspace", "/repo/app"},
		{"máy tắt, dự án full", `{"projectId":"` + boundID + `","runPermissions":"full","fullAllowed":true}`, off, "workspace", "/repo/app"},
		{"máy tắt, tổ chức cấm", `{"projectId":"` + boundID + `","runPermissions":"workspace","fullAllowed":false}`, off, "workspace", "/repo/app"},
		{"chưa gắn theo hub", `{"projectId":"0a0a0a0a-0000-4000-8000-000000000009","runPermissions":"full","fullAllowed":true}`, on, "full", ""},
		{"hub cũ: full nghĩa là tổ chức cho", `{"projectId":"` + boundID + `","runPermissions":"full"}`, on, "full", "/repo/app"},
		{"hub cũ: workspace nghĩa là chưa chắc", `{"projectId":"` + boundID + `","runPermissions":"workspace"}`, on, "workspace", "/repo/app"},
		{"hub cũ không gửi projectId", `{"runPermissions":"workspace","fullAllowed":true}`, on, "workspace", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			offer := &JobOffer{RunID: "r", Attempt: 1, Spec: json.RawMessage(tc.spec)}
			job, err := decodeJob(offer, Lease{}, "", "")
			if err != nil {
				t.Fatal(err)
			}
			var spec jobSpec
			_ = json.Unmarshal(offer.Spec, &spec)
			got := localProject(job, spec, tc.list)
			if got.RunPermissions != tc.want || got.LocalRepo != tc.repo {
				t.Fatalf("quyền %q repo %q, muốn %q %q", got.RunPermissions, got.LocalRepo, tc.want, tc.repo)
			}
		})
	}
	// Run sandbox của runner host không dùng repo trên máy.
	sandbox := localProject(runner.Job{Execution: "sandbox", ProjectID: boundID, RunPermissions: "workspace"}, jobSpec{FullAllowed: new(true)}, on)
	if sandbox.LocalRepo != "" || sandbox.RunPermissions != "workspace" {
		t.Fatalf("sandbox = %+v", sandbox)
	}
	// Hub gửi id viết hoa vẫn khớp mục đã gắn.
	upper, _ := decodeJob(&JobOffer{RunID: "r", Spec: json.RawMessage(`{"projectId":"0A0A0A0A-0000-4000-8000-000000000003"}`)}, Lease{}, "", "")
	if upper.ProjectID != boundID {
		t.Fatalf("ProjectID = %q", upper.ProjectID)
	}
}

// Antigravity cần toàn quyền: máy chưa bật cho dự án thì từ chối đề nghị để hub giao máy khác, thay vì nhận rồi hỏng.
func TestOfferRejectsAntigravityWithoutMachineFullPermission(t *testing.T) {
	spec := `{"cli":"antigravity","projectId":"` + boundID + `","runPermissions":"full","fullAllowed":true}`
	for _, tc := range []struct {
		name   string
		full   bool
		kind   string
		accept bool
	}{
		{"máy tắt toàn quyền", false, "", false},
		{"máy bật toàn quyền", true, "", true},
		{"run chỉ đọc không cần toàn quyền", false, "plan", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			j := testJobs(t, 1)
			j.cfg.CLIs = []string{"antigravity"}
			j.cfg.Projects = writeProjects(t, tc.full)
			s := spec
			if tc.kind != "" {
				s = `{"kind":"` + tc.kind + `",` + spec[1:]
			}
			j.onOffer(&JobOffer{RunID: "agy", Attempt: 1, TTL: 30, Spec: json.RawMessage(s)})
			if _, ok := j.offers["agy"]; ok != tc.accept {
				t.Fatalf("nhận = %v, muốn %v", ok, tc.accept)
			}
		})
	}
}

// Hello và heartbeat báo dự án đã gắn và dự án máy cho toàn quyền; runner host (không có projects.json) không báo.
func TestHeartbeatReportsLocalProjects(t *testing.T) {
	j := testJobs(t, 1)
	if hb := j.heartbeat(); hb.LocalProjects != nil {
		t.Fatalf("runner host báo %+v", hb.LocalProjects)
	}
	j.cfg.Projects = filepath.Join(t.TempDir(), "projects.json")
	hb := j.heartbeat()
	if hb.LocalProjects == nil || hb.LocalProjects.Bound == nil || len(hb.LocalProjects.Bound) != 0 {
		t.Fatalf("chưa có file thì phải báo mảng rỗng: %+v", hb.LocalProjects)
	}
	j.cfg.Projects = writeProjects(t, true)
	hb = j.heartbeat()
	if lp := hb.LocalProjects; lp == nil || len(lp.Bound) != 1 || lp.Bound[0] != boundID || len(lp.Full) != 1 {
		t.Fatalf("localProjects = %+v", lp)
	}
	var raw map[string]any
	_ = json.Unmarshal(mustJSON(hb), &raw)
	if _, ok := raw["localProjects"]; !ok {
		t.Fatalf("heartbeat thiếu localProjects: %v", raw)
	}
	// File hỏng: không báo gì để hub giữ như máy chưa gắn, thay vì nhận danh sách sai.
	if err := os.WriteFile(j.cfg.Projects, []byte("{hỏng"), 0o600); err != nil {
		t.Fatal(err)
	}
	if hb := j.heartbeat(); hb.LocalProjects != nil {
		t.Fatalf("file hỏng vẫn báo %+v", hb.LocalProjects)
	}
}

func TestHelloReportsLocalProjects(t *testing.T) {
	got := make(chan Hello, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		got <- receiveHello(t, conn)
		<-r.Context().Done()
	}))
	defer srv.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cfg := testConfig(t, srv.URL)
	cfg.Projects = writeProjects(t, false)
	go func() { _ = cfg.Run(ctx) }()
	select {
	case hello := <-got:
		if lp := hello.LocalProjects; lp == nil || len(lp.Bound) != 1 || lp.Bound[0] != boundID || lp.Full == nil || len(lp.Full) != 0 {
			t.Fatalf("hello.localProjects = %+v", hello.LocalProjects)
		}
	case <-time.After(waitFor):
		t.Fatal("không nhận hello")
	}
}

// Hub giao run của dự án máy đã gắn: worker tạo worktree từ repo của người dùng và nhánh của run có trong repo đó.
func TestBoundProjectRunsInLocalRepository(t *testing.T) {
	remote, base := makeRemote(t)
	local := filepath.Join(t.TempDir(), "app")
	if out, err := exec.Command("git", "clone", "-q", fileURL(remote), local).CombinedOutput(); err != nil {
		t.Fatalf("clone: %s %v", out, err)
	}
	hub := newFakeHub(t, true)
	cfg := workerConfig(t, hub, "commit")
	cfg.Projects = filepath.Join(t.TempDir(), "projects.json")
	if err := projects.Bind(cfg.Projects, boundID, local, "app", fileURL(remote)); err != nil {
		t.Fatal(err)
	}
	startWorker(t, cfg)
	c := hub.accept(t)
	spec := jobSpecFor(remote, base, "ai/T-local")
	spec["projectId"] = boundID
	c.offer(t, "run-local", spec)
	c.nextType(t, "job_accept")
	c.lease(t, "run-local", "tok-1")
	msgs := c.untilResult(t, "run-local")
	res := msgs[len(msgs)-1]
	if res.report().Status != "succeeded" || res.HeadSHA == nil {
		t.Fatalf("run_result = %+v report %+v", res, res.report())
	}
	out, err := exec.Command("git", "-C", local, "rev-parse", "refs/heads/ai/T-local").Output()
	if err != nil || strings.TrimSpace(string(out)) != *res.HeadSHA {
		t.Fatalf("nhánh trong repo người dùng = %q, %v; headSha %s", out, err, *res.HeadSHA)
	}
	if caches, _ := filepath.Glob(filepath.Join(cfg.DataDir, "repos", "*.git")); len(caches) != 0 {
		t.Fatalf("vẫn clone bare: %v", caches)
	}
	eventually(t, "worktree được gỡ", noFiles(filepath.Join(cfg.DataDir, "runs", "*")))
}
