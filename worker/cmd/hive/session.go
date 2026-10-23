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
	// noRecord: phiên không ghi lên hub (máy dùng chung vốn đã không ghi).
	noRecord bool
	// task, project là key trên hub (PAY-12, PAY); tra bằng token của hive login.
	task, project string
	escape        byte
}

// escapeFlag thêm --escape cho lệnh gắn vào phiên; đọc giá trị bằng parseEscape sau khi parse.
func escapeFlag(fs *flag.FlagSet) *string {
	return fs.String("escape", "ctrl-]", "phím tiền tố cho lệnh trong phiên (ctrl-<phím> hoặc none)")
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
	fs.StringVar(&o.task, "task", "", "gắn phiên với task trên hub (vd. PAY-12; cần hive login)")
	fs.StringVar(&o.project, "project", "", "gắn phiên với dự án trên hub (vd. PAY; cần hive login)")
	fs.BoolVar(&o.noRecord, "no-record", false, "không ghi phiên lên hub")
	// Phiên tại máy chưa mở được từ xa nên cờ này đã đúng mặc định; nhận để script viết theo plan chạy được.
	fs.Bool("no-remote", false, "không cho điều khiển từ xa")
	escape := escapeFlag(fs)
	pos, err := parseInterspersed(fs, args)
	if err != nil {
		return o, exitUsage
	}
	if o.escape, err = parseEscape(*escape); err != nil {
		return o, a.errorf(exitUsage, "%v", err)
	}
	if o.task != "" && o.project != "" {
		return o, a.errorf(exitUsage, "Chỉ dùng một trong --task và --project: task đã thuộc một dự án.")
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
	projectID, taskID, code := a.resolveLink(o)
	if code != exitOK {
		return code
	}
	c, _, code := a.connect()
	if code != exitOK {
		return code
	}
	defer c.Close()
	req := map[string]any{"op": "session.create", "cli": o.cli, "cwd": cwd, "cols": cols, "rows": rows,
		"args": cliArgs(o), "account": o.account, "force": o.force, "term": a.getenv("TERM"), "noRecord": o.noRecord,
		"projectId": projectID, "taskId": taskID}
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
	fmt.Fprintf(a.stderr, "hive: phiên %s (%s%s). %s Gắn lại bằng hive attach %s.\n", resp.ID, o.cli, account, escHint(o.escape, false), resp.ID)
	return a.interact(c, resp.ID, modeControl, o.escape)
}

// resolveLink tra --task/--project trên hub trước khi mở phiên, để gõ sai key thì báo ngay thay vì ghi phiên không liên
// kết. Hub vẫn tự bỏ liên kết khi task không thuộc đội của máy (FR-030).
func (a *app) resolveLink(o chatOptions) (projectID, taskID string, code int) {
	if o.task == "" && o.project == "" {
		return "", "", exitOK
	}
	if o.noRecord {
		return "", "", a.errorf(exitUsage, "--task và --project gắn bản ghi của phiên với hub; bỏ --no-record hoặc bỏ hai cờ đó.")
	}
	hub, code := a.hubFor()
	if code != exitOK {
		return "", "", code
	}
	if o.task != "" {
		t, err := hub.task(o.task)
		if err != nil {
			return "", "", a.hubFail(err)
		}
		if t == nil {
			return "", "", a.errorf(exitUsage, "Không tìm thấy task %s trên %s (hoặc bạn không xem được).", o.task, hub.base)
		}
		fmt.Fprintf(a.stderr, "hive: gắn phiên với task %s: %s\n", t.Key, t.Title)
		return t.ProjectID, t.ID, exitOK
	}
	p, err := hub.project(o.project)
	if err != nil {
		return "", "", a.hubFail(err)
	}
	if p == nil {
		return "", "", a.errorf(exitUsage, "Không tìm thấy dự án %s trên %s (hoặc bạn không xem được).", o.project, hub.base)
	}
	return p.ID, "", exitOK
}

type sessionInfo struct {
	ID         string    `json:"id"`
	CLI        string    `json:"cli"`
	Cwd        string    `json:"cwd"`
	Account    string    `json:"account"`
	Started    time.Time `json:"started"`
	Controlled bool      `json:"controlled"`
	Viewers    int       `json:"viewers"`
	// HubID: mã phiên trên hub, để hive attach nhận cả mã thấy trên web hay hive ls --all.
	HubID string `json:"hubId"`
}

func (a *app) ls(args []string) int {
	fs := newFlagSet("ls", a.stderr)
	asJSON := fs.Bool("json", false, "in JSON")
	all := fs.Bool("all", false, "phiên đang chạy trên mọi máy của bạn (cần hive login)")
	pos, err := parseInterspersed(fs, args)
	if err != nil || len(pos) > 0 {
		return exitUsage
	}
	if *all {
		return a.lsAll(*asJSON)
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

// lsAll đọc từ hub nên thấy cả máy khác; mã phiên là mã trên hub: hive attach gắn được phiên máy này, chỉ xem phiên máy khác.
func (a *app) lsAll(asJSON bool) int {
	hub, code := a.hubFor()
	if code != exitOK {
		return code
	}
	raw, err := hub.remoteSessions()
	if err != nil {
		return a.hubFail(err)
	}
	if asJSON {
		fmt.Fprintln(a.stdout, string(raw))
		return exitOK
	}
	var list []remoteSession
	if err := json.Unmarshal(raw, &list); err != nil {
		return a.errorf(exitFailed, "Hub trả danh sách phiên không đọc được: %v", err)
	}
	if len(list) == 0 {
		fmt.Fprintln(a.stdout, "Không có phiên nào đang chạy trên các máy của bạn.")
		return exitOK
	}
	w := tabwriter.NewWriter(a.stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "ID\tMÁY\tCLI\tĐIỀU KHIỂN\tTASK\tBẮT ĐẦU\tTHƯ MỤC")
	for _, s := range list {
		ctl := "không"
		if s.Controller != nil {
			ctl = map[string]string{"local": "tại máy", "remote": "từ xa"}[*s.Controller]
		}
		task := deref(s.TaskKey, deref(s.ProjectKey, "-"))
		started := s.CreatedAt
		if t, err := time.Parse(time.RFC3339, s.CreatedAt); err == nil {
			started = t.Local().Format("15:04 02/01")
		}
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%s\t%s\n", s.ID, s.MachineName, s.CLI, ctl, task, started, deref(s.CwdLabel, ""))
	}
	_ = w.Flush()
	return exitOK
}

func deref(p *string, def string) string {
	if p == nil || *p == "" {
		return def
	}
	return *p
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
