package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/accounts"
)

// accountsView là kết quả của `hive-worker accounts --json` cho app desktop.
type accountsView struct {
	Path     string          `json:"path"`
	Imported int             `json:"imported"`
	Accounts []accounts.View `json:"accounts"`
}

// addedView là kết quả của `accounts add --json`: app mở Terminal chạy loginCommand với env.
type addedView struct {
	Account      accounts.View     `json:"account"`
	LoginCommand string            `json:"loginCommand"`
	Env          map[string]string `json:"env"`
}

const accountsUsage = "Cách dùng: hive-worker accounts [import-legacy [--force] | set --id ID --enabled BOOL | add --cli claude|codex --label TÊN [--how plan|sso|console|browser|device] [--email E] | update --id ID [--label TÊN] [--priority N] [--max-concurrent N] [--cooldown-minutes N] [--stop-at-session N] [--stop-at-week N] [--timeout-minutes N] [--roles plan,implement,review] | remove --id ID | usage [--id ID] | resume --id ID] [--json]"

// Test thay giờ và thư mục nhà.
var (
	accountsNow  = time.Now
	accountsHome = os.UserHomeDir
)

// accountsCommand: tài khoản CLI của máy (spec 008 US13, US14). Không đối số thì liệt kê; các lệnh con sửa danh sách
// hay trạng thái rồi in lại danh sách, trừ add in tài khoản mới và lệnh đăng nhập.
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
	cli := fs.String("cli", "", "claude hoặc codex")
	label := fs.String("label", "", "tên tài khoản")
	how := fs.String("how", "", "cách đăng nhập: plan, sso, console (claude); browser, device (codex)")
	email := fs.String("email", "", "email gợi ý khi đăng nhập Claude")
	ints := map[string]*int{}
	for _, f := range []struct{ name, usage string }{
		{"priority", "ưu tiên 0–100, cao chọn trước"},
		{"max-concurrent", "số run cùng lúc 1–8"},
		{"cooldown-minutes", "phút nghỉ khi hết lượt mà không biết giờ reset, 1–1440"},
		{"stop-at-session", "ngưỡng dừng quota phiên 5 giờ, 1–100%"},
		{"stop-at-week", "ngưỡng dừng quota tuần, 1–100%"},
		{"timeout-minutes", "thời hạn một run, 1–720 phút"},
	} {
		ints[f.name] = fs.Int(f.name, 0, f.usage)
	}
	roles := fs.String("roles", "", "vai trò, cách nhau bằng dấu phẩy: plan,implement,review")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	path, err := pathOr(*configPath)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	file := accounts.DefaultPath(path)
	home, _ := accountsHome()
	view := accountsView{Path: file}
	fail := func(err error) int {
		fmt.Fprintln(stderr, err)
		return 1
	}
	needID := func() bool {
		if *id == "" {
			fmt.Fprintln(stderr, accountsUsage)
			return false
		}
		return true
	}
	switch action {
	case "list":
	case "import-legacy":
		legacy := *from
		if legacy == "" {
			legacy = accounts.LegacyPath(home)
		}
		if view.Imported, err = accounts.ImportLegacy(legacy, file, *force); err != nil {
			return fail(err)
		}
	case "set":
		on, perr := strconv.ParseBool(*enabled)
		if *id == "" || perr != nil {
			fmt.Fprintln(stderr, "Cách dùng: hive-worker accounts set --id ID --enabled true|false")
			return 2
		}
		if err := accounts.SetEnabled(file, *id, on); err != nil {
			return fail(err)
		}
	case "add":
		if *cli == "" || *label == "" {
			fmt.Fprintln(stderr, accountsUsage)
			return 2
		}
		added, command, env, err := accounts.Add(file, home, *cli, *label, *how, *email)
		if err != nil {
			return fail(err)
		}
		st, err := accounts.LoadState(accounts.StatePath(file))
		if err != nil {
			return fail(err)
		}
		out := addedView{Account: accounts.Views([]accounts.Account{added}, st, home, accountsNow())[0], LoginCommand: command, Env: env}
		if *asJSON {
			_ = json.NewEncoder(stdout).Encode(out)
			return 0
		}
		fmt.Fprintf(stdout, "Đã thêm tài khoản %s (%s). Đăng nhập bằng lệnh:\n  %s%s\n", added.ID, added.Label, envPrefix(env), command)
		return 0
	case "update":
		if !needID() {
			return 2
		}
		var c accounts.Changes
		fs.Visit(func(f *flag.Flag) {
			switch f.Name {
			case "label":
				c.Label = label
			case "roles":
				c.Roles = strings.Split(*roles, ",")
			}
		})
		c.Priority, c.MaxConcurrent, c.CooldownMinutes = setInt(fs, ints, "priority"), setInt(fs, ints, "max-concurrent"), setInt(fs, ints, "cooldown-minutes")
		c.StopAtSession, c.StopAtWeek, c.TimeoutMinutes = setInt(fs, ints, "stop-at-session"), setInt(fs, ints, "stop-at-week"), setInt(fs, ints, "timeout-minutes")
		if err := accounts.Update(file, *id, c); err != nil {
			return fail(err)
		}
	case "remove":
		if !needID() {
			return 2
		}
		if err := accounts.Remove(file, *id, accountsNow()); err != nil {
			return fail(err)
		}
	case "usage":
		list, err := accounts.Load(file)
		if err != nil {
			return fail(err)
		}
		if *id != "" && !hasAccount(list, *id) {
			return fail(fmt.Errorf("không có tài khoản %q", *id))
		}
		// Người dùng bấm đọc lại: đọc cả tài khoản đang tắt (không chỉ tài khoản worker đang giao run).
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		pick := func(a accounts.Account) bool { return *id == "" || a.ID == *id }
		if err := accounts.RefreshUsage(ctx, file, home, accountsNow, pick); err != nil {
			return fail(err)
		}
	case "resume":
		if !needID() {
			return 2
		}
		if err := accounts.Resume(file, *id, accountsNow()); err != nil {
			return fail(err)
		}
	default:
		fmt.Fprintln(stderr, accountsUsage)
		return 2
	}
	list, err := accounts.Load(file)
	if err != nil {
		return fail(err)
	}
	st, err := accounts.LoadState(accounts.StatePath(file))
	if err != nil {
		return fail(err)
	}
	view.Accounts = accounts.Views(list, st, home, accountsNow())
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
		state := stateText[a.State]
		if !a.Supported {
			state += ", worker chưa chạy CLI này"
		}
		fmt.Fprintf(stdout, "%-14s %-10s %-24s ưu tiên %d, %d run, %s%s\n", a.ID, a.CLI, a.Label, a.Priority, a.MaxConcurrent, state, usageText(a.Usage))
	}
	return 0
}

// setInt là giá trị cờ số nếu người gọi có đặt, nil nếu không.
func setInt(fs *flag.FlagSet, ints map[string]*int, name string) *int {
	if !flagSet(fs, name) {
		return nil
	}
	return ints[name]
}

func hasAccount(list []accounts.Account, id string) bool {
	for _, a := range list {
		if a.ID == id {
			return true
		}
	}
	return false
}

var stateText = map[string]string{
	accounts.StateDisabled:  "đã tắt",
	accounts.StateNoCLI:     "chưa có CLI",
	accounts.StateSignedOut: "chưa đăng nhập",
	accounts.StateRunning:   "đang chạy",
	accounts.StateOverLimit: "chạm ngưỡng",
	accounts.StateCooling:   "đang nghỉ",
	accounts.StateNear:      "gần ngưỡng",
	accounts.StateReady:     "sẵn sàng",
}

func usageText(u accounts.Usage) string {
	var parts []string
	for _, bar := range []struct {
		name  string
		limit *accounts.Limit
	}{{"phiên", u.Session}, {"tuần", u.Week}} {
		if bar.limit == nil {
			continue
		}
		s := fmt.Sprintf("%s %.0f%%", bar.name, bar.limit.Percent)
		if bar.limit.ResetsAt != nil {
			s += ", reset " + bar.limit.ResetsAt.Local().Format("15:04 02/01")
		}
		parts = append(parts, s)
	}
	if len(parts) == 0 && u.Reason != nil {
		return "; quota: " + *u.Reason
	}
	if len(parts) == 0 {
		return ""
	}
	return "; " + strings.Join(parts, "; ")
}

// envPrefix là biến môi trường viết trước lệnh đăng nhập cho người chạy tay trong shell.
func envPrefix(env map[string]string) string {
	keys := make([]string, 0, len(env))
	for k := range env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, k := range keys {
		fmt.Fprintf(&b, "%s=%q ", k, env[k])
	}
	return b.String()
}
