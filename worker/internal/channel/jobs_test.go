package channel

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/tdduydev/xdev-hive/worker/internal/runner"
)

func TestDurableSinkPersistsAndAckRemovesInSequence(t *testing.T) {
	dir := t.TempDir()
	var sent []any
	sink := &durableSink{dir: dir, write: func(v any) error { sent = append(sent, v); return nil }}
	for _, e := range []runner.Event{
		{Type: "phase", RunID: "run-1", Attempt: 2, Phase: "running"},
		{Type: "log", RunID: "run-1", Attempt: 2, Offset: 0, Data: []byte("hello")},
		{Type: "result", RunID: "run-1", Attempt: 2, Result: &runner.Result{Status: "succeeded", HeadSHA: "abc"}},
	} {
		if err := sink.Emit(e); err != nil {
			t.Fatal(err)
		}
	}
	if len(sent) != 3 {
		t.Fatalf("sent %d messages", len(sent))
	}
	for i, want := range []string{"run_event", "log_chunk", "run_result"} {
		b, err := json.Marshal(sent[i])
		if err != nil {
			t.Fatal(err)
		}
		var env struct {
			Type string `json:"type"`
			Seq  int64  `json:"seq"`
		}
		if err := json.Unmarshal(b, &env); err != nil {
			t.Fatal(err)
		}
		if env.Type != want || env.Seq != int64(i+1) {
			t.Fatalf("message %d = %s seq %d", i, env.Type, env.Seq)
		}
	}
	if got := pendingMessages(dir); len(got) != 3 {
		t.Fatalf("pending before ack = %d", len(got))
	}
	ackPending(dir, "run-1", 2)
	if got := pendingMessages(dir); len(got) != 1 {
		t.Fatalf("pending after ack = %d", len(got))
	}
	if runs := queuedRunIDs(dir); len(runs) != 1 || runs[0] != "run-1" {
		t.Fatalf("resume runs = %v", runs)
	}
	ackPending(dir, "run-1", 3)
	if got := queuedRunIDs(dir); len(got) != 0 {
		t.Fatalf("resume after ack = %v", got)
	}
}

func TestDecodeJobPassesLeaseEnvironment(t *testing.T) {
	offer := &JobOffer{RunID: "r", Attempt: 1, Spec: json.RawMessage(`{"repo":"org/repo","cli":"codex","prompt":"do it"}`)}
	job, err := decodeJob(offer, Lease{RunToken: "run-secret"}, "https://hub.example", "project-1")
	if err != nil {
		t.Fatal(err)
	}
	if job.RepoURL != "https://github.com/org/repo.git" || job.Env["HIVE_RUN_TOKEN"] != "run-secret" || job.Env["HIVE_HUB_URL"] != "https://hub.example" || job.Env["HIVE_PROJECT"] != "project-1" {
		t.Fatalf("decoded job = %+v env=%v", job, job.Env)
	}
}

func TestQueueFilesArePrivate(t *testing.T) {
	dir := t.TempDir()
	sink := &durableSink{dir: dir, write: func(any) error { return errors.New("socket down") }}
	err := sink.Emit(runner.Event{Type: "phase", RunID: "run", Attempt: 1, Phase: "prepare"})
	if err == nil {
		t.Fatal("expected transport failure")
	}
	files, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil || len(files) != 1 {
		t.Fatalf("queue files %v %v", files, err)
	}
	info, err := os.Stat(files[0])
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("mode = %o", info.Mode().Perm())
	}
}
