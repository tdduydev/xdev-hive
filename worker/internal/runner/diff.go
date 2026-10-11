package runner

import (
	"context"
	"fmt"
	"strconv"
	"strings"
)

type DiffStats struct {
	AddedLines   int      `json:"addedLines"`
	DeletedLines int      `json:"deletedLines"`
	ChangedFiles []string `json:"changedFiles"`
}

func collectDiffStats(ctx context.Context, work, base string) (*DiffStats, error) {
	mergeBase, err := gitOutput(ctx, work, "merge-base", base, "HEAD")
	if err != nil {
		return nil, err
	}
	// Tách rename thành xoá + thêm để đường dẫn cũ cũng kích hoạt review; -z giữ nguyên tên chứa tab/newline.
	numstat, err := gitOutput(ctx, work, "diff", "--numstat", "--no-renames", "-z", strings.TrimSpace(mergeBase)+"..HEAD", "--")
	if err != nil {
		return nil, err
	}
	return parseNumstat(numstat)
}

func parseNumstat(raw string) (*DiffStats, error) {
	stats := &DiffStats{ChangedFiles: []string{}}
	for _, record := range strings.Split(raw, "\x00") {
		if record == "" {
			continue
		}
		fields := strings.SplitN(record, "\t", 3)
		if len(fields) != 3 || fields[2] == "" {
			return nil, fmt.Errorf("Thống kê diff không hợp lệ")
		}
		stats.ChangedFiles = append(stats.ChangedFiles, fields[2])
		if fields[0] == "-" && fields[1] == "-" {
			continue
		}
		added, err := strconv.Atoi(fields[0])
		if err != nil || added < 0 {
			return nil, fmt.Errorf("Số dòng thêm trong diff không hợp lệ")
		}
		deleted, err := strconv.Atoi(fields[1])
		if err != nil || deleted < 0 {
			return nil, fmt.Errorf("Số dòng xoá trong diff không hợp lệ")
		}
		stats.AddedLines += added
		stats.DeletedLines += deleted
	}
	return stats, nil
}
