package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/localipc"
	"github.com/tdduydev/xdev-hive/worker/internal/outbox"
)

// hive outbox … xem và xử lý hộp thư đi của hive-worker qua socket nội bộ (specs/027 T019). Desktop và VS Code gọi
// `submit --json -` để mọi lần ghi lên hub đi qua cùng một hàng, giữ thứ tự giữa app, CLI và proxy MCP.

const outboxUsage = `Cách dùng: hive outbox [lệnh] [--json]

  (không lệnh) [--state pending,held,rejected,expired]
                          trạng thái hub và các mục chưa tới hub
  drop <khoá>…            bỏ mục bị từ chối, hết hạn hoặc đang giữ (mục đang chờ gửi không bỏ được)
  retry <khoá>…           đưa mục đang giữ hoặc hết hạn về hàng chờ gửi
  export [<khoá>…] -o FILE
                          ghi các mục (cả nội dung) ra file JSON để gửi tay hoặc lưu lại
  submit --json -         đọc một yêu cầu outbox.submit từ stdin (cho app)
`

// submitLineBudget chừa chỗ cho phần còn lại của dòng socket; thân lớn hơn thì đi qua file trong incoming.
const submitLineBudget = localipc.MaxLine - 4*1024

// maxSubmitInput chặn stdin của submit: mục lớn nhất worker nhận cộng phần đầu của yêu cầu.
const maxSubmitInput = outbox.DefaultMaxItemBytes + 64*1024

type outboxStatus struct {
	Hub           string `json:"hub"`
	HubURL        string `json:"hubUrl"`
	LastContactAt string `json:"lastContactAt"`
	Pending       int    `json:"pending"`
	Held          int    `json:"held"`
	Rejected      int    `json:"rejected"`
	Expired       int    `json:"expired"`
	Bytes         int64  `json:"bytes"`
	LimitBytes    int64  `json:"limitBytes"`
}

type outboxEntry struct {
	Key       string    `json:"key"`
	Kind      string    `json:"kind"`
	State     string    `json:"state"`
	CreatedAt time.Time `json:"createdAt"`
	Title     string    `json:"title"`
	Attempts  int       `json:"attempts"`
	Result    *struct {
		Code   string `json:"code"`
		Reason string `json:"reason"`
	} `json:"result"`
	HeldReason *string `json:"heldReason"`
	LastError  string  `json:"lastError"`
	Email      string  `json:"email"`
}

var hubStates = map[string]string{
	"up":       "đang kết nối",
	"down":     "đang vắng",
	"retrying": "lỗi tạm, đang thử lại",
}

var entryStates = map[string]string{
	"pending":  "chờ gửi",
	"held":     "đang giữ",
	"rejected": "bị từ chối",
	"expired":  "hết hạn",
}

var heldReasons = map[string]string{
	outbox.HeldLoginRequired:    "cần đăng nhập lại (hive login)",
	outbox.HeldIdentityMismatch: "máy đang đăng nhập người khác",
}

func (a *app) outbox(args []string) int {
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		sub, rest := args[0], args[1:]
		switch sub {
		case "drop":
			return a.outboxDrop(rest)
		case "retry":
			return a.outboxRetry(rest)
		case "export":
			return a.outboxExport(rest)
		case "submit":
			return a.outboxSubmit(rest)
		case "help":
			fmt.Fprint(a.stdout, outboxUsage)
			return exitOK
		}
		fmt.Fprintf(a.stderr, "hive: không có lệnh outbox %q.\n", sub)
		fmt.Fprint(a.stderr, outboxUsage)
		return exitUsage
	}
	return a.outboxShow(args)
}

// outboxCall gửi một op trên kết nối đã mở và trả nguyên trả lời (bỏ "ok") để --json in đúng cái worker gửi.
func (a *app) outboxCall(c *localipc.Conn, req map[string]any, out any) (json.RawMessage, int) {
	var raw map[string]json.RawMessage
	if err := c.Call(req, &raw); err != nil {
		return nil, a.fail(err)
	}
	delete(raw, "ok")
	b, err := json.Marshal(raw)
	if err != nil {
		return nil, a.errorf(exitFailed, "%v", err)
	}
	if out != nil {
		if err := json.Unmarshal(b, out); err != nil {
			return nil, a.errorf(exitFailed, "Trả lời của hive-worker không hợp lệ: %v", err)
		}
	}
	return b, exitOK
}

// outboxOne mở kết nối cho một op.
func (a *app) outboxOne(req map[string]any, out any) (json.RawMessage, int) {
	c, _, code := a.connect()
	if code != exitOK {
		return nil, code
	}
	defer c.Close()
	return a.outboxCall(c, req, out)
}

func (a *app) outboxShow(args []string) int {
	fs := newFlagSet("outbox", a.stderr)
	asJSON := fs.Bool("json", false, "in JSON cho app")
	states := fs.String("state", "", "chỉ hiện các trạng thái này, cách nhau bằng dấu phẩy")
	pos, err := parseInterspersed(fs, args)
	if err != nil {
		return exitUsage
	}
	if len(pos) > 0 {
		return a.errorf(exitUsage, "Thừa đối số %q.", pos[0])
	}
	list := map[string]any{"op": "outbox.list"}
	if *states != "" {
		var want []string
		for _, s := range strings.Split(*states, ",") {
			s = strings.TrimSpace(s)
			if _, ok := entryStates[s]; !ok {
				return a.errorf(exitUsage, "Không có trạng thái %q; dùng pending, held, rejected, expired.", s)
			}
			want = append(want, s)
		}
		list["states"] = want
	}
	c, _, code := a.connect()
	if code != exitOK {
		return code
	}
	defer c.Close()
	var st outboxStatus
	stRaw, code := a.outboxCall(c, map[string]any{"op": "outbox.status"}, &st)
	if code != exitOK {
		return code
	}
	var items struct {
		Items []outboxEntry `json:"items"`
	}
	itemsRaw, code := a.outboxCall(c, list, &items)
	if code != exitOK {
		return code
	}
	if *asJSON {
		var wrapped struct {
			Items json.RawMessage `json:"items"`
		}
		_ = json.Unmarshal(itemsRaw, &wrapped)
		return a.printJSON(map[string]json.RawMessage{"status": stRaw, "items": wrapped.Items})
	}
	a.printOutbox(st, items.Items)
	return exitOK
}

func (a *app) printOutbox(st outboxStatus, items []outboxEntry) {
	hub := hubStates[st.Hub]
	if hub == "" {
		hub = st.Hub
	}
	line := "Hub " + st.HubURL + ": " + hub
	if st.Hub != "up" && st.LastContactAt != "" {
		if t, err := time.Parse(time.RFC3339, st.LastContactAt); err == nil {
			line += " · liên lạc lần cuối " + t.Local().Format("02/01/2006 15:04")
		}
	}
	fmt.Fprintln(a.stdout, line)
	fmt.Fprintf(a.stdout, "Chờ gửi: %d · đang giữ: %d · bị từ chối: %d · hết hạn: %d · dung lượng %s / %s\n",
		st.Pending, st.Held, st.Rejected, st.Expired, humanBytes(st.Bytes), humanBytes(st.LimitBytes))
	if len(items) == 0 {
		fmt.Fprintln(a.stdout, "Hộp thư đi trống.")
		return
	}
	tw := tabwriter.NewWriter(a.stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "KHOÁ\tTRẠNG THÁI\tTẠO LÚC\tNỘI DUNG\tGHI CHÚ")
	for _, it := range items {
		state := entryStates[it.State]
		if state == "" {
			state = it.State
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\n", it.Key, state, it.CreatedAt.Local().Format("02/01 15:04"), it.Title, entryNote(it))
	}
	_ = tw.Flush()
	if st.Rejected+st.Expired+st.Held > 0 {
		fmt.Fprintln(a.stdout, "Bỏ mục bằng hive outbox drop <khoá>, gửi lại bằng hive outbox retry <khoá>, lưu ra file bằng hive outbox export -o <file>.")
	}
}

func entryNote(it outboxEntry) string {
	switch {
	case it.Result != nil && it.Result.Reason != "":
		return it.Result.Reason
	case it.Result != nil && it.Result.Code != "":
		return it.Result.Code
	case it.HeldReason != nil:
		if r, ok := heldReasons[*it.HeldReason]; ok {
			return r
		}
		return *it.HeldReason
	case it.LastError != "":
		return fmt.Sprintf("đã thử %d lần: %s", it.Attempts, it.LastError)
	}
	return ""
}

func humanBytes(n int64) string {
	switch {
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.1f KB", float64(n)/(1<<10))
	}
	return fmt.Sprintf("%d B", n)
}

func (a *app) outboxKeysFlags(name string, args []string, more func(fs *flag.FlagSet)) ([]string, bool, int) {
	fs := newFlagSet("outbox "+name, a.stderr)
	asJSON := fs.Bool("json", false, "in JSON cho app")
	if more != nil {
		more(fs)
	}
	keys, err := parseInterspersed(fs, args)
	if err != nil {
		return nil, false, exitUsage
	}
	return keys, *asJSON, exitOK
}

func (a *app) outboxDrop(args []string) int {
	keys, asJSON, code := a.outboxKeysFlags("drop", args, nil)
	if code != exitOK {
		return code
	}
	if len(keys) == 0 {
		return a.errorf(exitUsage, "Cách dùng: hive outbox drop <khoá>…")
	}
	var out struct {
		Dropped []string `json:"dropped"`
		Skipped []string `json:"skipped"`
	}
	raw, code := a.outboxOne(map[string]any{"op": "outbox.drop", "keys": keys}, &out)
	if code != exitOK {
		return code
	}
	if asJSON {
		fmt.Fprintf(a.stdout, "%s\n", raw)
		return exitOK
	}
	fmt.Fprintf(a.stdout, "Đã bỏ %d mục.\n", len(out.Dropped))
	if len(out.Skipped) > 0 {
		// Mục chờ gửi có thể đang trên đường tới hub; bỏ lúc đó thì không biết hub đã nhận hay chưa.
		fmt.Fprintf(a.stdout, "Không bỏ (đang chờ gửi hoặc không có): %s\n", strings.Join(out.Skipped, ", "))
	}
	return exitOK
}

func (a *app) outboxRetry(args []string) int {
	keys, asJSON, code := a.outboxKeysFlags("retry", args, nil)
	if code != exitOK {
		return code
	}
	if len(keys) == 0 {
		return a.errorf(exitUsage, "Cách dùng: hive outbox retry <khoá>…")
	}
	var out struct {
		Retried int `json:"retried"`
	}
	raw, code := a.outboxOne(map[string]any{"op": "outbox.retry", "keys": keys}, &out)
	if code != exitOK {
		return code
	}
	if asJSON {
		fmt.Fprintf(a.stdout, "%s\n", raw)
		return exitOK
	}
	fmt.Fprintf(a.stdout, "Đã đưa %d mục về hàng chờ gửi.\n", out.Retried)
	return exitOK
}

func (a *app) outboxExport(args []string) int {
	var file *string
	keys, asJSON, code := a.outboxKeysFlags("export", args, func(fs *flag.FlagSet) { file = fs.String("o", "", "file ghi ra") })
	if code != exitOK {
		return code
	}
	if *file == "" {
		return a.errorf(exitUsage, "Cách dùng: hive outbox export [<khoá>…] -o <file>.")
	}
	path := *file
	if !filepath.IsAbs(path) {
		// Worker chỉ nhận đường dẫn tuyệt đối; đường dẫn tương đối hiểu theo nơi gõ lệnh.
		wd, err := a.getwd()
		if err != nil {
			return a.errorf(exitFailed, "Không đọc được thư mục hiện tại: %v", err)
		}
		path = filepath.Join(wd, path)
	}
	req := map[string]any{"op": "outbox.export", "path": path}
	if len(keys) > 0 {
		req["keys"] = keys
	}
	var out struct {
		Path  string `json:"path"`
		Count int    `json:"count"`
	}
	raw, code := a.outboxOne(req, &out)
	if code != exitOK {
		return code
	}
	if asJSON {
		fmt.Fprintf(a.stdout, "%s\n", raw)
		return exitOK
	}
	fmt.Fprintf(a.stdout, "Đã ghi %d mục vào %s. File có nội dung các lần ghi; giữ như tài liệu của dự án.\n", out.Count, out.Path)
	return exitOK
}

// outboxSubmit chuyển một yêu cầu outbox.submit từ stdin tới worker và in nguyên trả lời, kể cả khi lỗi, để app đọc
// được mã (NOT_QUEUEABLE, OUTBOX_FULL…) thay vì phải hiểu câu chữ trên stderr.
func (a *app) outboxSubmit(args []string) int {
	pos, asJSON, code := a.outboxKeysFlags("submit", args, nil)
	if code != exitOK {
		return code
	}
	if !asJSON || len(pos) != 1 || pos[0] != "-" {
		return a.errorf(exitUsage, "Cách dùng: hive outbox submit --json - (yêu cầu JSON trên stdin).")
	}
	in, err := io.ReadAll(io.LimitReader(a.stdin, maxSubmitInput+1))
	if err != nil {
		return a.errorf(exitFailed, "Không đọc được stdin: %v", err)
	}
	if len(in) > maxSubmitInput {
		return a.submitReply(map[string]any{"ok": false, "code": "ITEM_TOO_LARGE", "error": "Mục quá lớn để xếp hàng."})
	}
	var req map[string]json.RawMessage
	if err := json.Unmarshal(bytes.TrimSpace(in), &req); err != nil {
		return a.errorf(exitUsage, "stdin không phải một object JSON: %v", err)
	}
	req["op"] = json.RawMessage(`"outbox.submit"`)
	line, err := json.Marshal(req)
	if err != nil {
		return a.errorf(exitFailed, "%v", err)
	}
	if len(line) > submitLineBudget && len(req["body"]) > 0 {
		file, err := writeIncoming(req["body"])
		if err != nil {
			return a.errorf(exitFailed, "%v", err)
		}
		// Worker xoá file sau khi đọc; xoá lại ở đây cho trường hợp worker không đọc tới (không chạy, từ chối sớm).
		defer os.Remove(file)
		delete(req, "body")
		req["bodyFile"], _ = json.Marshal(file)
	}
	c, _, code := a.connect()
	if code != exitOK {
		return code
	}
	defer c.Close()
	if err := c.WriteJSON(req); err != nil {
		return a.fail(err)
	}
	var reply map[string]any
	if err := c.ReadJSON(&reply); err != nil {
		return a.errorf(exitFailed, "Mất kết nối tới hive-worker.")
	}
	return a.submitReply(reply)
}

func (a *app) submitReply(reply map[string]any) int {
	if code := a.printJSON(reply); code != exitOK {
		return code
	}
	if ok, _ := reply["ok"].(bool); ok {
		return exitOK
	}
	msg, _ := reply["error"].(string)
	code, _ := reply["code"].(string)
	return a.errorf(remoteExit(code), "%s", strings.TrimSpace(msg))
}

// writeIncoming đặt thân lớn vào thư mục incoming của hộp thư đi (0600): worker chỉ nhận bodyFile trong thư mục đó để
// client không chỉ được worker đọc file bất kỳ.
func writeIncoming(body json.RawMessage) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("Không xác định được thư mục người dùng: %w", err)
	}
	dir := filepath.Join(home, ".xdev-hive", "outbox", outbox.IncomingDir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("Không tạo được %s: %w", dir, err)
	}
	var b [12]byte
	_, _ = rand.Read(b[:])
	file := filepath.Join(dir, hex.EncodeToString(b[:])+".json")
	if err := os.WriteFile(file, body, 0o600); err != nil {
		return "", fmt.Errorf("Không ghi được %s: %w", file, err)
	}
	return file, nil
}
