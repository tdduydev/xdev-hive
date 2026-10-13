package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"strconv"

	"github.com/tdduydev/xdev-hive/worker/internal/accounts"
)

// accountsView là kết quả của `hive-worker accounts --json` cho app desktop.
type accountsView struct {
	Path     string          `json:"path"`
	Imported int             `json:"imported"`
	Accounts []accounts.View `json:"accounts"`
}

// accountsCommand: tài khoản CLI của máy (spec 008 US13). Không đối số thì liệt kê; `import-legacy` chép từ app v1
// (một lần, trừ khi --force); `set --id ID --enabled true|false` bật tắt một tài khoản.
func accountsCommand(args []string, stdout, stderr io.Writer) int {
	action := "list"
	if len(args) > 0 && args[0] != "" && args[0][0] != '-' {
		action, args = args[0], args[1:]
	}
	fs := flag.NewFlagSet("accounts "+action, flag.ContinueOnError)
	fs.SetOutput(stderr)
	configPath := fs.String("config", "", "file cấu hình worker (accounts.json nằm cạnh)")
	asJSON := fs.Bool("json", false, "in dạng JSON (cho app desktop)")
	from := fs.String("from", "", "file cấu hình của app v1 (mặc định ~/.xdev-hive/config.json)")
	force := fs.Bool("force", false, "nhập lại dù accounts.json đã có")
	id := fs.String("id", "", "id tài khoản")
	enabled := fs.String("enabled", "", "true hoặc false")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	path, err := pathOr(*configPath)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	file := accounts.DefaultPath(path)
	home, _ := os.UserHomeDir()
	view := accountsView{Path: file}
	switch action {
	case "list":
	case "import-legacy":
		legacy := *from
		if legacy == "" {
			legacy = accounts.LegacyPath(home)
		}
		if view.Imported, err = accounts.ImportLegacy(legacy, file, *force); err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
	case "set":
		on, perr := strconv.ParseBool(*enabled)
		if *id == "" || perr != nil {
			fmt.Fprintln(stderr, "Cách dùng: hive-worker accounts set --id ID --enabled true|false")
			return 2
		}
		if err := accounts.SetEnabled(file, *id, on); err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
	default:
		fmt.Fprintln(stderr, "Cách dùng: hive-worker accounts [import-legacy [--force] | set --id ID --enabled true|false] [--json]")
		return 2
	}
	list, err := accounts.Load(file)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	view.Accounts = accounts.Views(list, home)
	if *asJSON {
		_ = json.NewEncoder(stdout).Encode(view)
		return 0
	}
	if view.Imported > 0 {
		fmt.Fprintf(stdout, "Đã nhập %d tài khoản từ app v1 vào %s.\n", view.Imported, file)
	}
	if len(view.Accounts) == 0 {
		fmt.Fprintf(stdout, "Chưa có tài khoản nào (%s); CLI dùng đăng nhập mặc định.\n", file)
		return 0
	}
	for _, a := range view.Accounts {
		state := "tắt"
		if a.Enabled {
			state = "bật"
		}
		if !a.Supported {
			state += ", worker chưa chạy CLI này"
		}
		fmt.Fprintf(stdout, "%-14s %-10s %-24s ưu tiên %d, %d run, %s\n", a.ID, a.CLI, a.Label, a.Priority, max(a.MaxConcurrent, 1), state)
	}
	return 0
}
