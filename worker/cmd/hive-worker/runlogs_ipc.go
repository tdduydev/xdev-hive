package main

import (
	"io"
	"log/slog"
	"path/filepath"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/localipc"
	"github.com/tdduydev/xdev-hive/worker/internal/runlogs"
)

func handleRunLogs(store runlogs.Store, c *localipc.Conn, req localipc.Request) error {
	var params struct {
		RunID   string `json:"runId"`
		Attempt int    `json:"attempt"`
		Offset  int64  `json:"offset"`
		Limit   int    `json:"limit"`
	}
	if err := req.Decode(&params); err != nil || params.Offset < 0 || params.Limit < 0 || params.Attempt < 0 {
		return c.Fail(localipc.CodeBadRequest, "Tham số đọc log không hợp lệ.")
	}
	switch req.Op {
	case "runs.list":
		entries, err := store.List()
		if err != nil {
			return c.Fail(localipc.CodeBadRequest, "Không đọc được danh sách log tại máy.")
		}
		limit := params.Limit
		if limit == 0 || limit > 100 {
			limit = 100
		}
		start := min(params.Offset, int64(len(entries)))
		end := min(start+int64(limit), int64(len(entries)))
		page := runlogs.ListPage{Runs: entries[start:end]}
		if end < int64(len(entries)) {
			next := int(end)
			page.NextOffset = &next
		}
		return c.OK(map[string]any{"runs": page.Runs, "nextOffset": page.NextOffset})
	case "runs.log.read":
		page, err := store.Read(params.RunID, params.Attempt, params.Offset, params.Limit)
		if err != nil {
			return c.Fail(localipc.CodeBadRequest, err.Error())
		}
		return c.OK(map[string]any{"runId": page.RunID, "attempt": page.Attempt, "offset": page.Offset, "nextOffset": page.NextOffset, "size": page.Size, "bytes": page.Bytes})
	default:
		return c.Fail(localipc.CodeUnsupported, "Lệnh log tại máy chưa được hỗ trợ.")
	}
}

func runsCommand(args []string, stdout, stderr io.Writer) int {
	return runlogs.Command(args, stdout, stderr, localipc.DefaultPath)
}

func localLogStore(recordDir string) runlogs.Store {
	return runlogs.Store{Dir: filepath.Join(filepath.Dir(recordDir), "runlogs")}
}

func cleanupRunLogs(store runlogs.Store) {
	if err := store.Cleanup(time.Now()); err != nil {
		slog.Warn("Chưa dọn được log run quá hạn tại máy", "error", err)
	}
}
