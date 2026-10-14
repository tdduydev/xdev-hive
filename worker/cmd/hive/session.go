package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"slices"
	"strings"
	"text/tabwriter"
	"time"
)

// clis là CLI `hive chat` mở được (khớp terminal.LocalCLIs của worker).
var clis = []string{"claude", "codex", "gemini"}

type chatOptions struct {
	cli     string
	account string
	model   string
	force   bool
	prompt  string
	extra   []string
}

func newFlagSet(name string, w io.Writer) *flag.FlagSet {
	fs := flag.NewFlagSet("hive "+name, flag.ContinueOnError)
	fs.SetOutput(w)
	return fs
}

// parseInterspersed cho cờ đứng sau đối số ("hive run "sửa lỗi" --cli codex"), như phần lớn CLI người dùng quen.
func parseInterspersed(fs *flag.FlagSet, args []string) ([]string, error) {
	var pos []string
	for {
		if err := fs.Parse(args); err != nil {
			return nil, err
		}
		args = fs.Args()
		if len(args) == 0 {
			return pos, nil
		}
		pos = append(pos, args[0])
		args = args[1:]
	}
}

// parseChat đọc cờ của chat/run. Phần sau "--" là đối số thêm cho CLI.
func (a *app) parseChat(args []string, withPrompt bool) (chatOptions, int) {
	var o chatOptions
	if i := slices.Index(args, "--"); i >= 0 {
		args, o.extra = args[:i], args[i+1:]
	}
	name := "chat"
	if withPrompt {
		name = "run"
	}
	fs := newFlagSet(name, a.stderr)
	fs.StringVar(&o.cli, "cli", "claude", "agent CLI: claude, codex hoặc gemini")
	fs.StringVar(&o.account, "account", "", "gói (id trong accounts.json); bỏ trống là gói rảnh")
	fs.StringVar(&o.model, "model", "", "model của CLI")
	fs.BoolVar(&o.force, "force", false, "dùng cả gói đang nghỉ")
	task := fs.String("task", "", "task trên hub (chưa hỗ trợ)")
	project := fs.String("project", "", "dự án trên hub (chưa hỗ trợ)")
	// Phiên tại máy chưa ghi lên hub và chưa mở từ xa, nên hai cờ này đã đúng mặc định; nhận để script viết theo plan chạy được.
	fs.Bool("no-record", false, "không ghi phiên lên hub")
	fs.Bool("no-remote", false, "không cho điều khiển từ xa")
	pos, err := parseInterspersed(fs, args)
	if err != nil {
		return o, exitUsage
	}
	if *task != "" || *project != "" {
		return o, a.errorf(exitUsage, "--task và --project chưa hỗ trợ: cần đăng nhập hub (hive login), chưa có trong bản này.")
	}
	if !slices.Contains(clis, o.cli) {
		return o, a.errorf(exitUsage, "CLI %q không hỗ trợ; dùng claude, codex hoặc gemini.", o.cli)
	}
	if withPrompt {
		o.prompt = strings.TrimSpace(strings.Join(pos, " "))
		if o.prompt == "" {
			return o, a.errorf(exitUsage, "Thiếu lời nhắc: hive run \"<lời nhắc>\".")
		}
	} else if len(pos) > 0 {
		return o, a.errorf(exitUsage, "Thừa đối số %q; đối số cho CLI đặt sau --.", pos[0])
	}
	return o, exitOK
}

// cliArgs là đối số truyền cho CLI: model, đối số thêm, rồi lời nhắc đầu theo cách từng CLI nhận khi vẫn ở chế độ
// tương tác (claude và codex nhận đối số vị trí; gemini cần --prompt-interactive, đối số vị trí của nó là chạy một lần).
func cliArgs(o chatOptions) []string {
	var args []string
	if o.model != "" {
		args = append(args, "--model", o.model)
	}
	args = append(args, o.extra...)
	if o.prompt == "" {
		return args
	}
	if o.cli == "gemini" {
		return append(args, "--prompt-interactive="+o.prompt)
	}
	if strings.HasPrefix(o.prompt, "-") {
		// Lời nhắc bắt đầu bằng "-" sẽ bị đọc thành cờ.
		args = append(args, "--")
	}
	return append(args, o.prompt)
}

func (a *app) chat(args []string, withPrompt bool) int {
	o, code := a.parseChat(args, withPrompt)
	if code != exitOK {
		return code
	}
	cwd, err := a.getwd()
	if err != nil {
		return a.errorf(exitFailed, "Không đọc được thư mục hiện tại: %v", err)
	}
	cols, rows, ok := a.console.Size()
	if !ok {
		cols, rows = 80, 24
	}
	c, _, code := a.connect()
	if code != exitOK {
		return code
	}
	defer c.Close()
	req := map[string]any{"op": "session.create", "cli": o.cli, "cwd": cwd, "cols": cols, "rows": rows,
		"args": cliArgs(o), "account": o.account, "force": o.force, "term": a.getenv("TERM")}
	var resp struct {
		ID      string `json:"id"`
		Account string `json:"account"`
	}
	if err := c.Call(req, &resp); err != nil {
		return a.fail(err)
	}
	account := ""
	if resp.Account != "" {
		account = ", gói " + resp.Account
	}
	fmt.Fprintf(a.stderr, "hive: phiên %s (%s%s). Ctrl-] d để tách, gắn lại bằng hive attach %s.\n", resp.ID, o.cli, account, resp.ID)
	return a.interact(c, resp.ID, modeControl)
}

func (a *app) attachCmd(args []string) int {
	fs := newFlagSet("attach", a.stderr)
	view := fs.Bool("view", false, "chỉ xem, không gõ")
	pos, err := parseInterspersed(fs, args)
	if err != nil {
		return exitUsage
	}
	if len(pos) != 1 {
		return a.errorf(exitUsage, "Cách dùng: hive attach <id> [--view].")
	}
	mode := modeControl
	if *view {
		mode = modeView
	}
	c, _, code := a.connect()
	if code != exitOK {
		return code
	}
	defer c.Close()
	var resp struct {
		ID string `json:"id"`
	}
	if err := c.Call(map[string]string{"op": "session.attach", "id": pos[0], "mode": mode}, &resp); err != nil {
		return a.fail(err)
	}
	if mode == modeView {
		fmt.Fprintf(a.stderr, "hive: đang xem phiên %s. Ctrl-] t để giành quyền, Ctrl-] d để tách.\n", resp.ID)
	} else {
		fmt.Fprintf(a.stderr, "hive: đã gắn phiên %s. Ctrl-] d để tách.\n", resp.ID)
	}
	return a.interact(c, resp.ID, mode)
}

type sessionInfo struct {
	ID         string    `json:"id"`
	CLI        string    `json:"cli"`
	Cwd        string    `json:"cwd"`
	Account    string    `json:"account"`
	Started    time.Time `json:"started"`
	Controlled bool      `json:"controlled"`
	Viewers    int       `json:"viewers"`
}

func (a *app) ls(args []string) int {
	fs := newFlagSet("ls", a.stderr)
	asJSON := fs.Bool("json", false, "in JSON")
	all := fs.Bool("all", false, "cả phiên trên máy khác (chưa hỗ trợ)")
	pos, err := parseInterspersed(fs, args)
	if err != nil || len(pos) > 0 {
		return exitUsage
	}
	if *all {
		return a.errorf(exitUsage, "--all chưa hỗ trợ: cần đăng nhập hub (hive login), chưa có trong bản này.")
	}
	c, _, code := a.connect()
	if code != exitOK {
		return code
	}
	defer c.Close()
	var resp struct {
		Sessions json.RawMessage `json:"sessions"`
	}
	if err := c.Call(map[string]string{"op": "session.list"}, &resp); err != nil {
		return a.fail(err)
	}
	if *asJSON {
		fmt.Fprintln(a.stdout, string(resp.Sessions))
		return exitOK
	}
	var list []sessionInfo
	if err := json.Unmarshal(resp.Sessions, &list); err != nil {
		return a.errorf(exitFailed, "Trả lời của hive-worker không hợp lệ: %v", err)
	}
	if len(list) == 0 {
		fmt.Fprintln(a.stdout, "Không có phiên nào trên máy.")
		return exitOK
	}
	w := tabwriter.NewWriter(a.stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "ID\tCLI\tGÓI\tĐIỀU KHIỂN\tXEM\tBẮT ĐẦU\tTHƯ MỤC")
	for _, s := range list {
		account, ctl := s.Account, "không"
		if account == "" {
			account = "mặc định"
		}
		if s.Controlled {
			ctl = "có"
		}
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%d\t%s\t%s\n", s.ID, s.CLI, account, ctl, s.Viewers, s.Started.Local().Format("15:04 02/01"), s.Cwd)
	}
	_ = w.Flush()
	return exitOK
}

func (a *app) kill(args []string) int {
	if len(args) != 1 || strings.HasPrefix(args[0], "-") {
		return a.errorf(exitUsage, "Cách dùng: hive kill <id>.")
	}
	c, _, code := a.connect()
	if code != exitOK {
		return code
	}
	defer c.Close()
	var resp struct {
		ID string `json:"id"`
	}
	if err := c.Call(map[string]string{"op": "session.kill", "id": args[0]}, &resp); err != nil {
		return a.fail(err)
	}
	fmt.Fprintf(a.stdout, "Đã ngắt phiên %s.\n", resp.ID)
	return exitOK
}
