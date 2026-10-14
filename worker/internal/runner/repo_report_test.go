package runner

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestBriefIsReadOnlyKindWithCapability(t *testing.T) {
	if !readOnlyKind(KindBrief) || NeedsFull("antigravity", KindBrief) {
		t.Fatal("run brief phải chỉ đọc")
	}
	found := false
	for _, c := range Capabilities {
		found = found || c == KindBrief
	}
	if !found {
		t.Fatalf("Capabilities = %v", Capabilities)
	}
}

func TestSkillProposalIsReadOnlyKindWithCapability(t *testing.T) {
	if !readOnlyKind(KindSkillProposal) || NeedsFull("antigravity", KindSkillProposal) {
		t.Fatal("run skill_proposal phải chỉ đọc")
	}
	if !slices.Contains(Capabilities, KindSkillProposal) {
		t.Fatalf("Capabilities = %v", Capabilities)
	}
}

// Worker commit thêm hai commit lên nhánh chính sau brief: briefBehind = 2, baseSha là đầu nhánh chính.
func TestRunnerReportsRepoDrift(t *testing.T) {
	remote, base := makeRemote(t)
	briefSHA := strings.TrimSpace(mustOut(t, "git", "--git-dir", remote, "rev-parse", "refs/heads/"+base))
	src := t.TempDir()
	must(t, "git", "clone", remote, src)
	for _, f := range []string{"a", "b"} {
		mustDir(t, src, f, f)
		must(t, "git", "-C", src, "add", ".")
		must(t, "git", "-C", src, "-c", "user.name=Runner Test", "-c", "user.email=runner@example.invalid", "commit", "-m", f)
	}
	must(t, "git", "-C", src, "push", "origin", base)
	head := strings.TrimSpace(mustOut(t, "git", "--git-dir", remote, "rev-parse", "refs/heads/"+base))

	cases := []struct {
		name, briefSHA string
		behind         *int
	}{
		{"có brief", briefSHA, ptr(2)},
		{"brief là SHA ngắn", briefSHA[:10], ptr(2)},
		{"brief bằng đầu nhánh", head, ptr(0)},
		{"không có brief", "", nil},
		{"SHA không có trong repo", strings.Repeat("0", 40), nil},
		{"không phải hex", "--all", nil},
	}
	data := t.TempDir()
	for i, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var events []Event
			r := Runner{DataDir: data, CLICommands: fakeCommands("empty")}
			job := Job{RunID: "brief-" + string(rune('a'+i)), Kind: KindBrief, Attempt: 1, RepoURL: fileURL(remote), BaseBranch: base, Branch: "ai/B", CLI: "codex", Prompt: "brief", BriefSHA: c.briefSHA, Timeout: 5 * time.Second, Env: map[string]string{"HIVE_RUNNER_HELPER": "1", "HIVE_FAKE_MODE": "empty", "HIVE_FAKE_EXPECT_FILE": "README"}}
			if err := r.Run(context.Background(), job, SinkFunc(func(e Event) error { events = append(events, e); return nil })); err != nil {
				t.Fatal(err)
			}
			got := lastResult(events)
			if got == nil || got.Status != "succeeded" || got.Repo == nil {
				t.Fatalf("result = %#v", got)
			}
			if got.Repo.BaseSHA == nil || *got.Repo.BaseSHA != head {
				t.Fatalf("baseSha = %v, muốn %s", got.Repo.BaseSHA, head)
			}
			if (got.Repo.BriefBehind == nil) != (c.behind == nil) || c.behind != nil && *got.Repo.BriefBehind != *c.behind {
				t.Fatalf("briefBehind = %v, muốn %v", got.Repo.BriefBehind, c.behind)
			}
			b, _ := json.Marshal(got)
			if !strings.Contains(string(b), `"repo":{"baseSha":"`+head+`"`) {
				t.Fatalf("report = %s", b)
			}
		})
	}
}

// Không đo được thì từng trường là null, khoá repo vẫn có trong report.
func TestRepoReportUnknownBase(t *testing.T) {
	remote, _ := makeRemote(t)
	work := t.TempDir()
	must(t, "git", "clone", remote, work)
	rep := repoReport(context.Background(), work, Job{BaseBranch: "khong-co", BriefSHA: strings.Repeat("a", 40)})
	b, _ := json.Marshal(Result{Repo: rep})
	if !strings.Contains(string(b), `"repo":{"baseSha":null,"briefBehind":null}`) {
		t.Fatalf("report = %s", b)
	}
}

func ptr[T any](v T) *T { return &v }
