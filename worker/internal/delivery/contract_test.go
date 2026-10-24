package delivery

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// Cùng file mẫu với test zod (packages/contracts/src/delivery-worker.test.ts). CI chạy gói này trên Linux, macOS và
// Windows (FR-103), nên mọi so sánh ở đây không được phụ thuộc hệ điều hành của worker.
var contractPath = filepath.Join("..", "..", "..", "packages", "contracts", "fixtures", "delivery-worker.json")

type contractFixtures struct {
	JobSpecs []json.RawMessage `json:"jobSpecs"`
	Runs     []struct {
		JobID  string            `json:"jobId"`
		Events []json.RawMessage `json:"events"`
	} `json:"runs"`
	Events []json.RawMessage `json:"events"`
}

func loadContract(t *testing.T) contractFixtures {
	t.Helper()
	b, err := os.ReadFile(contractPath)
	if err != nil {
		t.Fatalf("đọc %s: %v", contractPath, err)
	}
	var f contractFixtures
	if err := json.Unmarshal(b, &f); err != nil {
		t.Fatal(err)
	}
	return f
}

func decodeSpec(t *testing.T, raw json.RawMessage) JobSpec {
	t.Helper()
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var s JobSpec
	if err := dec.Decode(&s); err != nil {
		t.Fatalf("JobSpec không đọc được gói của hub: %v", err)
	}
	return s
}

func asAny(t *testing.T, v any) any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// Hub gửi đủ trường kể cả null và mặc định; Go bỏ trường rỗng khi ghi lại. Hai dạng tương đương sau khi bỏ null và {}.
func dropEmpty(m map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range m {
		if v == nil {
			continue
		}
		if o, ok := v.(map[string]any); ok && len(o) == 0 {
			continue
		}
		out[k] = v
	}
	return out
}

func TestContractJobSpecsRoundTrip(t *testing.T) {
	f := loadContract(t)
	if len(f.JobSpecs) == 0 {
		t.Fatal("file mẫu không có việc nào")
	}
	for _, raw := range f.JobSpecs {
		spec := decodeSpec(t, raw)
		var want map[string]any
		if err := json.Unmarshal(raw, &want); err != nil {
			t.Fatal(err)
		}
		if got := asAny(t, spec); !reflect.DeepEqual(got, dropEmpty(want)) {
			t.Errorf("%s: ghi lại lệch\n got  %v\n want %v", spec.JobID, got, dropEmpty(want))
		}
	}
}

// Sự kiện mẫu không do lần chạy nào sinh ra vẫn phải dùng đúng bộ trường worker biết phát.
func TestContractEventFieldsAreKnown(t *testing.T) {
	f := loadContract(t)
	known := map[string][]string{
		"started":  {"workerId"},
		"step":     {"name", "state", "exitCode"},
		"external": {"ref", "url"},
		"finished": {"state", "error"},
		"test-results": {"pipeline", "jobIds", "totals", "unmapped", "ambiguous", "unknownCodes", "truncated",
			"cases"},
		"pipelines": {"items"},
	}
	all := f.Events
	for _, r := range f.Runs {
		all = append(all, r.Events...)
	}
	for _, raw := range all {
		var ev map[string]any
		if err := json.Unmarshal(raw, &ev); err != nil {
			t.Fatal(err)
		}
		typ, _ := ev["type"].(string)
		allowed, ok := known[typ]
		if !ok {
			t.Fatalf("loại sự kiện lạ %q", typ)
		}
		for k := range ev {
			switch k {
			case "jobId", "seq", "type", "at":
				continue
			}
			found := false
			for _, a := range allowed {
				found = found || a == k
			}
			if !found {
				t.Errorf("%s: trường lạ %q", typ, k)
			}
		}
		if _, err := time.Parse(time.RFC3339, ev["at"].(string)); err != nil {
			t.Errorf("at = %v", ev["at"])
		}
	}
}

// Kiểu Go của test-report phải đọc và ghi lại đúng sự kiện mẫu, không thêm hay bớt trường (zod ở hub là strict).
func TestContractTestReportEventsRoundTrip(t *testing.T) {
	f := loadContract(t)
	seen := map[string]bool{}
	for _, raw := range f.Events {
		var base struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(raw, &base); err != nil {
			t.Fatal(err)
		}
		var body Event
		switch base.Type {
		case "test-results":
			body = decodeEvent[TestResults](t, raw).event()
		case "pipelines":
			body = decodeEvent[Pipelines](t, raw).event()
		default:
			continue
		}
		seen[base.Type] = true
		var want map[string]any
		if err := json.Unmarshal(raw, &want); err != nil {
			t.Fatal(err)
		}
		for _, k := range []string{"jobId", "seq", "type", "at"} {
			body[k] = want[k]
		}
		if got := asAny(t, body); !reflect.DeepEqual(got, any(want)) {
			t.Errorf("%s: ghi lại lệch\n got  %v\n want %v", base.Type, got, want)
		}
	}
	if !seen["test-results"] || !seen["pipelines"] {
		t.Fatalf("file mẫu thiếu sự kiện test-report: %v", seen)
	}
}

func decodeEvent[T any](t *testing.T, raw json.RawMessage) T {
	t.Helper()
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"jobId", "seq", "type", "at"} {
		delete(m, k)
	}
	b, _ := json.Marshal(m)
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	var v T
	if err := dec.Decode(&v); err != nil {
		t.Fatalf("kiểu Go không đọc được sự kiện mẫu: %v", err)
	}
	return v
}

func TestContractTestReportParams(t *testing.T) {
	f := loadContract(t)
	n := 0
	for _, raw := range f.JobSpecs {
		spec := decodeSpec(t, raw)
		if spec.Kind != KindTestReport {
			continue
		}
		n++
		p, err := ParseTestReportParams(spec.Params)
		if err != nil {
			t.Fatalf("%s: %v", spec.JobID, err)
		}
		if got := asAny(t, p); !reflect.DeepEqual(got, asAny(t, spec.Params)) {
			t.Errorf("%s: params ghi lại lệch: %v", spec.JobID, got)
		}
	}
	if n == 0 {
		t.Fatal("file mẫu không có việc test-report")
	}
	for _, bad := range []map[string]any{
		{"op": "read", "projectPath": "g/p", "pipelineId": 1, "mode": "junit-artifact", "artifactPath": "../x.xml"},
		{"op": "read", "projectPath": "g/p", "pipelineId": 1, "mode": "junit-artifact", "artifactPath": `a\..\x.xml`},
		{"op": "read", "projectPath": "g/p", "pipelineId": 1, "mode": "junit-artifact"},
		{"op": "read", "projectPath": "../p", "pipelineId": 1, "mode": "pipeline-report"},
		{"op": "read", "projectPath": "g/p", "pipelineId": 0, "mode": "pipeline-report"},
		{"op": "read", "projectPath": "g/p", "pipelineId": 1, "mode": "pipeline-report", "token": "x"},
		{"op": "list", "projectPath": "g/p", "limit": 501},
		{"op": "write", "projectPath": "g/p"},
	} {
		if _, err := ParseTestReportParams(bad); CodeOf(err) != CodeBadRequest {
			t.Errorf("nhận params sai %v: %v", bad, err)
		}
	}
	if _, err := ParseTestReportParams(map[string]any{"op": "read", "projectPath": "g/p", "pipelineId": 1, "mode": "html"}); CodeOf(err) != CodeUnsupported {
		t.Errorf("mode lạ phải là unsupported: %v", err)
	}
}

// fakeTargets dựng Jenkins và Argo CD giả theo đúng các việc trong file mẫu và ghi lại yêu cầu worker gửi.
type fakeTargets struct {
	t        *testing.T
	jobPaths []string
	form     url.Values
	revision string
}

func (ft *fakeTargets) jenkins(w http.ResponseWriter, r *http.Request) {
	const build = "/job/his/job/portal/job/deploy-prod/42"
	ft.jobPaths = append(ft.jobPaths, r.URL.Path)
	switch {
	case r.Method == http.MethodPost && r.URL.Path == "/job/his/job/portal/job/deploy-prod/buildWithParameters":
		b, _ := io.ReadAll(r.Body)
		ft.form, _ = url.ParseQuery(string(b))
		w.Header().Set("Location", "http://"+r.Host+"/queue/item/9001/")
		w.WriteHeader(201)
	case r.URL.Path == "/queue/item/9001/api/json":
		// Jenkins trả URL theo root URL nó được cấu hình, không theo địa chỉ worker gọi tới.
		_, _ = w.Write([]byte(`{"id":9001,"cancelled":false,"executable":{"number":42,"url":"https://jenkins.bv.local/job/his/job/portal/job/deploy-prod/42/"}}`))
	case r.URL.Path == build+"/logText/progressiveText":
		_, _ = w.Write([]byte("Deploying to D:\\apps\\his-portal\n"))
	case r.URL.Path == build+"/api/json":
		_, _ = w.Write([]byte(`{"number":42,"result":"SUCCESS","building":false}`))
	default:
		ft.t.Errorf("Jenkins giả không biết %s %s", r.Method, r.URL.Path)
		w.WriteHeader(404)
	}
}

func (ft *fakeTargets) argo(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.Method == http.MethodPost && r.URL.Path == "/api/v1/applications/his-portal/sync":
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		ft.revision, _ = body["revision"].(string)
		_, _ = w.Write(fixture(ft.t, "argocd", "application-syncing.json"))
	case r.URL.Path == "/api/v1/applications/his-portal":
		_, _ = w.Write(fixture(ft.t, "argocd", "application-synced.json"))
	default:
		ft.t.Errorf("Argo CD giả không biết %s %s", r.Method, r.URL.Path)
		w.WriteHeader(404)
	}
}

func TestContractRunsEmitFixtureEvents(t *testing.T) {
	f := loadContract(t)
	ft := &fakeTargets{t: t}
	jenkins := httptest.NewServer(http.HandlerFunc(ft.jenkins))
	defer jenkins.Close()
	argo := httptest.NewServer(http.HandlerFunc(ft.argo))
	defer argo.Close()

	specs := map[string]JobSpec{}
	for _, raw := range f.JobSpecs {
		s := decodeSpec(t, raw)
		specs[s.JobID] = s
	}
	store := MapCredentials{"delivery/reg-a/jenkins-prod": "bot:tok-jenkins", "delivery/reg-a/argocd-prod": "tok-argo"}
	at := time.Date(2026, 10, 23, 15, 0, 0, 0, time.FixedZone("ICT", 7*3600))

	for _, run := range f.Runs {
		t.Run(run.JobID, func(t *testing.T) {
			spec, ok := specs[run.JobID]
			if !ok {
				t.Fatalf("không có việc %s trong jobSpecs", run.JobID)
			}
			// Địa chỉ trong file mẫu là của mạng nội bộ thật; trỏ về server giả, giữ nguyên mọi trường khác.
			target := map[string]any{}
			for k, v := range spec.Target {
				target[k] = v
			}
			if spec.Kind == "argocd" {
				target["baseUrl"] = argo.URL
			} else {
				target["baseUrl"] = jenkins.URL
			}
			spec.Target = target

			s := &sink{}
			e := &Executor{Scope: Scope{RegistrationID: "reg-a"}, Store: store, LogRoot: t.TempDir(), WorkerID: "w-build-01",
				Emit: s.add, Poll: 10 * time.Millisecond, Now: func() time.Time { return at }}
			_ = e.Run(context.Background(), spec)

			want := make([]any, len(run.Events))
			for i, raw := range run.Events {
				if err := json.Unmarshal(raw, &want[i]); err != nil {
					t.Fatal(err)
				}
			}
			if got := asAny(t, s.ev); !reflect.DeepEqual(got, any(want)) {
				gb, _ := json.MarshalIndent(got, "", "  ")
				t.Fatalf("sự kiện lệch file mẫu:\n%s", gb)
			}
		})
	}

	// FR-101: đường dẫn trên máy đích đi nguyên văn tới hệ ngoài, không bị đổi theo hệ điều hành của worker.
	if ft.form.Get("DEPLOY_DIR") != `D:\apps\his-portal` || ft.form.Get("CONFIG") != "/etc/his/portal.yaml" {
		t.Errorf("tham số đường dẫn bị đổi: %v", ft.form)
	}
	if ft.form.Get("TAG") != "v1.4.2" || ft.form.Get("REPLICAS") != "3" {
		t.Errorf("tham số = %v", ft.form)
	}
	for _, p := range ft.jobPaths {
		if strings.Contains(p, `\`) {
			t.Errorf("đường dẫn job dùng dấu của Windows: %s", p)
		}
	}
	if ft.revision != "v1.4.2" {
		t.Errorf("revision = %q", ft.revision)
	}
}

// FR-101: tên job Jenkins là đường dẫn trên máy chủ Jenkins, chỉ "/" là dấu phân cách dù worker chạy Windows.
func TestContractJenkinsJobPathIgnoresWorkerOS(t *testing.T) {
	got, err := JenkinsJobPath(`his\portal/deploy`)
	if err != nil || got != "/job/his%5Cportal/job/deploy" {
		t.Fatalf("got %q, %v", got, err)
	}
}

// Log của việc là đường dẫn cục bộ nên theo quy ước của hệ điều hành worker (FR-101 vế sau).
func TestContractJobLogUsesWorkerOSPath(t *testing.T) {
	root := t.TempDir()
	sc := Scope{RegistrationID: "reg-a"}
	if got, want := sc.LogDir(root), filepath.Join(root, "reg-a", "delivery-logs"); got != want {
		t.Fatalf("LogDir = %q, muốn %q", got, want)
	}
}

func TestExecutorOmitsEmptyJenkinsURL(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost:
			w.Header().Set("Location", "http://"+r.Host+"/queue/item/1/")
			w.WriteHeader(201)
		case r.URL.Path == "/queue/item/1/api/json":
			_, _ = w.Write([]byte(`{"executable":{"number":5,"url":""}}`))
		case strings.HasSuffix(r.URL.Path, "/api/json"):
			_, _ = w.Write([]byte(`{"number":5,"result":"SUCCESS","building":false}`))
		default:
			_, _ = w.Write(nil)
		}
	}))
	defer srv.Close()
	s := &sink{}
	e := newExec(t, "reg-a", MapCredentials{"delivery/reg-a/jenkins-prod": "bot:tok"}, s)
	spec := JobSpec{JobID: jobA, Kind: "jenkins-job", Credential: "jenkins-prod", Target: map[string]any{"baseUrl": srv.URL, "job": "web"}, TimeoutSeconds: 5}
	if err := e.Run(context.Background(), spec); err != nil {
		t.Fatal(err)
	}
	for _, ev := range s.ev {
		if ev["type"] != "external" {
			continue
		}
		if _, has := ev["url"]; has {
			t.Fatalf("url rỗng phải được bỏ: %v", ev)
		}
		if ev["ref"] != "web#5" {
			t.Fatalf("ref = %v", ev["ref"])
		}
		return
	}
	t.Fatal("thiếu sự kiện external")
}
