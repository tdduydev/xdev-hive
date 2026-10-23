package runlogs

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"text/tabwriter"

	"github.com/tdduydev/xdev-hive/worker/internal/localipc"
	"github.com/tdduydev/xdev-hive/worker/internal/version"
)

const Usage = "Cách dùng: hive runs [--json] [--offset N] [--limit N] | hive runs log <run> [--attempt N] [--offset N] [--limit N] [--json]"

type ListPage struct {
	Runs       []Entry `json:"runs"`
	NextOffset *int    `json:"nextOffset"`
}

// Command cũng được sidecar hive-worker dùng, để desktop và hive CLI đọc qua cùng socket, cùng kiểm người dùng.
func Command(args []string, stdout, stderr io.Writer, socket func() (string, error)) int {
	fs := flag.NewFlagSet("runs", flag.ContinueOnError)
	fs.SetOutput(stderr)
	asJSON := fs.Bool("json", false, "xuất JSON")
	attempt := fs.Int("attempt", 0, "lần thử; 0 là mới nhất tại máy")
	offset := fs.Int64("offset", 0, "con trỏ; byte với log, vị trí với danh sách")
	limit := fs.Int("limit", 0, "giới hạn mỗi trang")
	id := ""
	reading := len(args) > 0 && args[0] == "log"
	if reading {
		if len(args) < 2 {
			fmt.Fprintln(stderr, Usage)
			return 2
		}
		id, args = args[1], args[2:]
	}
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() != 0 || *attempt < 0 || *offset < 0 || *limit < 0 || reading && !validID.MatchString(id) {
		fmt.Fprintln(stderr, Usage)
		return 2
	}
	path, err := socket()
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	c, _, err := localipc.Dial(path, "hive/"+version.Version)
	if err != nil {
		fmt.Fprintln(stderr, "Sidecar hive-worker không chạy hoặc không nhận kết nối:", err)
		return 1
	}
	defer c.Close()
	fail := func(err error) int { fmt.Fprintln(stderr, err); return 1 }
	if !reading {
		var page ListPage
		if err := c.Call(map[string]any{"op": "runs.list", "offset": *offset, "limit": *limit}, &page); err != nil {
			return fail(err)
		}
		if *asJSON {
			if err := json.NewEncoder(stdout).Encode(page); err != nil {
				return fail(err)
			}
			return 0
		}
		w := tabwriter.NewWriter(stdout, 0, 4, 2, ' ', 0)
		fmt.Fprintln(w, "RUN\tLẦN THỬ\tCLI\tBYTE")
		for _, r := range page.Runs {
			fmt.Fprintf(w, "%s\t%d\t%s\t%d\n", r.RunID, r.Attempt, r.CLI, r.Size)
		}
		if err := w.Flush(); err != nil {
			return fail(err)
		}
		return 0
	}
	for {
		var page Page
		if err := c.Call(map[string]any{"op": "runs.log.read", "runId": id, "attempt": *attempt, "offset": *offset, "limit": *limit}, &page); err != nil {
			return fail(err)
		}
		if *asJSON {
			if err := json.NewEncoder(stdout).Encode(page); err != nil {
				return fail(err)
			}
			return 0
		}
		if _, err := stdout.Write(page.Bytes); err != nil {
			return fail(err)
		}
		if page.NextOffset >= page.Size || page.NextOffset <= *offset {
			return 0
		}
		*offset, *attempt = page.NextOffset, page.Attempt
	}
}
