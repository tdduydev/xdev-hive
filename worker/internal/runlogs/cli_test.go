package runlogs

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tdduydev/xdev-hive/worker/internal/localipc"
	"github.com/tdduydev/xdev-hive/worker/internal/version"
)

func TestCommandReadsAllPagesWithoutHub(t *testing.T) {
	dir, err := os.MkdirTemp("", "hrl")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	s := Store{Dir: filepath.Join(dir, "logs")}
	f, err := s.Open(Entry{RunID: "run-1", Attempt: 1})
	if err != nil {
		t.Fatal(err)
	}
	full := strings.Repeat("log đầy đủ\n", 10000)
	if _, err := f.WriteString(full); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "hive.sock")
	ln, err := localipc.Listen(path)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = (&localipc.Server{Worker: version.Version, Handler: func(_ context.Context, c *localipc.Conn, r localipc.Request) error {
			var p struct {
				RunID   string
				Attempt int
				Offset  int64
				Limit   int
			}
			if err := r.Decode(&p); err != nil {
				return err
			}
			page, err := s.Read(p.RunID, p.Attempt, p.Offset, p.Limit)
			if err != nil {
				return c.Fail(localipc.CodeBadRequest, err.Error())
			}
			return c.OK(map[string]any{"runId": page.RunID, "attempt": page.Attempt, "offset": page.Offset, "nextOffset": page.NextOffset, "size": page.Size, "bytes": page.Bytes})
		}}).Serve(ctx, ln)
	}()
	defer func() { cancel(); <-done }()
	var out, stderr bytes.Buffer
	socket := func() (string, error) { return path, nil }
	if code := Command([]string{"log", "run-1"}, &out, &stderr, socket); code != 0 || out.String() != full {
		t.Fatalf("code %d, bytes %d, %s", code, out.Len(), stderr.String())
	}
	if code := Command([]string{"log", "../escape"}, &out, &stderr, socket); code != 2 {
		t.Fatalf("nhận đường dẫn xấu: %d", code)
	}
}
