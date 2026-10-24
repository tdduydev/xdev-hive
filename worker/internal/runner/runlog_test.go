package runner

import (
	"bytes"
	"strings"
	"testing"

	"github.com/tdduydev/xdev-hive/worker/internal/redact"
)

func TestRunLogKeepsRawLocalAndRedactsTransport(t *testing.T) {
	var local bytes.Buffer
	var sent []Event
	s := &runLogSink{file: &local, next: SinkFunc(func(e Event) error { sent = append(sent, e); return nil }), job: Job{RunID: "run", Attempt: 1}, stream: redact.Stream{Exact: []string{"opaque-secret"}}}
	for _, part := range []string{"xin chào opaque-", "secret\n"} {
		if err := s.Emit(Event{Type: "log", Data: []byte(part)}); err != nil {
			t.Fatal(err)
		}
	}
	stats := &DiffStats{AddedLines: 3}
	if err := s.Emit(Event{Type: "result", Result: &Result{Status: "succeeded", Error: "opaque-secret", DiffStats: stats}}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(local.String(), "opaque-secret") {
		t.Fatal("mất log đầy đủ tại máy")
	}
	for _, e := range sent {
		if strings.Contains(string(e.Data), "opaque-secret") || e.Result != nil && strings.Contains(e.Result.Error, "opaque-secret") {
			t.Fatal("secret rời máy")
		}
	}
	if sent[len(sent)-1].Result.DiffStats != stats {
		t.Fatal("mất thống kê diff khi che báo cáo")
	}
}
