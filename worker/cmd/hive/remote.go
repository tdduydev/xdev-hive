package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"net/url"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/localipc"
)

// hive remote … điều khiển phần từ xa của worker qua socket nội bộ (specs/010 T024). Socket nội bộ là ranh giới "tại
// máy" (FR-012): mọi việc bật, thêm thư mục, ghép thiết bị chỉ đi qua đây, hub không có đường làm thay.

const remoteUsage = `Cách dùng: hive remote <lệnh> [--json]

  status                  trạng thái điều khiển từ xa của máy này
  on [--yes]              bật (hỏi xác nhận; --yes khi đã xác nhận ở nơi khác, như app)
  off                     tắt ngay, thu mọi quyền từ xa
  roots                   thư mục được mở từ xa
  roots add <thư mục> [--label NHÃN]
  roots rm <id>
  devices                 thiết bị đã ghép
  devices rm <id>
  pair                    ghép điện thoại: in mã QR, chờ quét rồi hỏi Cho phép
  set <khoá> <giá trị>    confirm-on-machine on|off, idle-minutes N, detached-hours N, max-hours N,
                          allow-full-access on|off, totp-on-https on|off
  watch [--json]          theo dõi sự kiện và trả lời yêu cầu ghép (--json: mỗi dòng một JSON, stdin nhận yêu cầu JSON)
  totp <lệnh>             mã Authenticator khi hub chạy HTTP (hive remote totp help)
`

const remoteRisk = "Agent có thể chạy lệnh trên máy này khi bạn điều khiển từ điện thoại."

type remoteRoot struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Path  string `json:"path"`
}

type remoteDevice struct {
	ID        string    `json:"id"`
	Label     string    `json:"label"`
	UserID    string    `json:"userId"`
	Synced    bool      `json:"synced"`
	CreatedAt time.Time `json:"createdAt"`
}

// remoteStatus là phần trạng thái lệnh in ra; --json in nguyên trả lời của worker.
type remoteStatus struct {
	Enabled          bool           `json:"enabled"`
	Shared           bool           `json:"shared"`
	Roots            []remoteRoot   `json:"roots"`
	Devices          []remoteDevice `json:"devices"`
	ConfirmOnMachine bool           `json:"confirmOnMachine"`
	IdleMinutes      int            `json:"idleMinutes"`
	DetachedHours    int            `json:"detachedHours"`
	MaxHours         int            `json:"maxHours"`
	AllowFullAccess  bool           `json:"allowFullAccess"`
	TOTP             struct {
		Enabled     bool      `json:"enabled"`
		Locked      bool      `json:"locked"`
		LockedUntil time.Time `json:"lockedUntil"`
	} `json:"totp"`
}

type pairInfo struct {
	PairID    string    `json:"pairId"`
	ExpiresAt time.Time `json:"expiresAt"`
	URL       string    `json:"url"`
}

type remoteReply struct {
	Status remoteStatus `json:"status"`
	Root   remoteRoot   `json:"root"`
	Pair   pairInfo     `json:"pair"`
	TOTP   totpEnroll   `json:"totp"`
}

// remoteEvent là một dòng của watch: sự kiện (có "event") hoặc trả lời cho yêu cầu gửi trên cùng kết nối.
type remoteEvent struct {
	Event     string        `json:"event"`
	State     *remoteStatus `json:"state"`
	PairID    string        `json:"pairId"`
	Label     string        `json:"label"`
	UserID    string        `json:"userId"`
	ExpiresAt time.Time     `json:"expiresAt"`
	OK        bool          `json:"ok"`
	DeviceID  string        `json:"deviceId"`
	Reason    string        `json:"reason"`
	Code      string        `json:"code"`
	Error     string        `json:"error"`
}

// pairReasons: lý do worker từ chối ghép (terminal/pairing.go).
var pairReasons = map[string]string{
	"expired":       "Mã ghép đã hết hạn hoặc đã dùng. Chạy lại hive remote pair.",
	"bad_tag":       "Khoá của thiết bị không khớp mã ghép (có thể đã bị đổi trên đường tới máy); đã từ chối.",
	"denied":        "Đã từ chối ghép.",
	"timeout":       "Không ai trả lời kịp tại máy; đã từ chối ghép.",
	"user_mismatch": "Người quét không phải chủ máy trên hub; đã từ chối.",
	"disabled":      "Điều khiển từ xa đang tắt; đã từ chối ghép.",
}

// remoteKeys: khoá của hive remote set và trường tương ứng của remote.settings.
type remoteKey struct {
	key, field string
	isInt      bool
}

var remoteKeys = []remoteKey{
	{"confirm-on-machine", "confirmOnMachine", false},
	{"idle-minutes", "idleMinutes", true},
	{"detached-hours", "detachedHours", true},
	{"max-hours", "maxHours", true},
	{"allow-full-access", "allowFullAccess", false},
	{"totp-on-https", "totpOnHttps", false},
}

func (a *app) remote(args []string) int {
	if len(args) == 0 {
		fmt.Fprint(a.stderr, remoteUsage)
		return exitUsage
	}
	sub, rest := args[0], args[1:]
	switch sub {
	case "status":
		return a.remoteSimple(sub, rest, "remote.status")
	case "on":
		return a.remoteOn(rest)
	case "off":
		return a.remoteSimple(sub, rest, "remote.disable")
	case "roots":
		return a.remoteRoots(rest)
	case "devices":
		return a.remoteDevices(rest)
	case "pair":
		return a.remotePair(rest)
	case "set":
		return a.remoteSet(rest)
	case "watch":
		return a.remoteWatch(rest)
	case "totp":
		return a.remoteTOTP(rest)
	case "help", "-h", "--help":
		fmt.Fprint(a.stdout, remoteUsage)
		return exitOK
	}
	fmt.Fprintf(a.stderr, "hive: không có lệnh remote %q.\n", sub)
	fmt.Fprint(a.stderr, remoteUsage)
	return exitUsage
}

// remoteFlags đọc --json (và cờ thêm qua more) rồi trả đối số vị trí.
func (a *app) remoteFlags(name string, args []string, more func(fs *flag.FlagSet)) ([]string, bool, int) {
	fs := newFlagSet("remote "+name, a.stderr)
	asJSON := fs.Bool("json", false, "in JSON cho app")
	if more != nil {
		more(fs)
	}
	pos, err := parseInterspersed(fs, args)
	if err != nil {
		return nil, false, exitUsage
	}
	return pos, *asJSON, exitOK
}

// remoteCall gửi một thao tác remote.*; với asJSON in trả lời (bỏ "ok") ra stdout cho app đọc.
func (a *app) remoteCall(req map[string]any, asJSON bool) (remoteReply, int) {
	c, _, code := a.connect()
	if code != exitOK {
		return remoteReply{}, code
	}
	defer c.Close()
	var raw map[string]json.RawMessage
	if err := c.Call(req, &raw); err != nil {
		return remoteReply{}, a.fail(err)
	}
	delete(raw, "ok")
	b, err := json.Marshal(raw)
	if err != nil {
		return remoteReply{}, a.errorf(exitFailed, "%v", err)
	}
	var out remoteReply
	if err := json.Unmarshal(b, &out); err != nil {
		return out, a.errorf(exitFailed, "Trả lời của hive-worker không hợp lệ: %v", err)
	}
	if asJSON {
		fmt.Fprintf(a.stdout, "%s\n", b)
	}
	return out, exitOK
}

// remoteSimple là các lệnh không đối số: gửi op, in trạng thái.
func (a *app) remoteSimple(name string, args []string, op string) int {
	pos, asJSON, code := a.remoteFlags(name, args, nil)
	if code != exitOK {
		return code
	}
	if len(pos) > 0 {
		return a.errorf(exitUsage, "Thừa đối số %q.", pos[0])
	}
	out, code := a.remoteCall(map[string]any{"op": op}, asJSON)
	if code != exitOK || asJSON {
		return code
	}
	if op == "remote.disable" {
		fmt.Fprintln(a.stdout, "Đã tắt điều khiển từ xa.")
		return exitOK
	}
	a.printRemoteStatus(out.Status)
	return exitOK
}

func (a *app) remoteOn(args []string) int {
	var yes *bool
	pos, asJSON, code := a.remoteFlags("on", args, func(fs *flag.FlagSet) { yes = fs.Bool("yes", false, "đã xác nhận ở nơi khác") })
	if code != exitOK {
		return code
	}
	if len(pos) > 0 {
		return a.errorf(exitUsage, "Thừa đối số %q.", pos[0])
	}
	if code := a.confirm(remoteRisk+" Bật điều khiển từ xa?", *yes); code != exitOK {
		return code
	}
	out, code := a.remoteCall(map[string]any{"op": "remote.enable"}, asJSON)
	if code != exitOK || asJSON {
		return code
	}
	fmt.Fprintln(a.stdout, "Đã bật điều khiển từ xa.")
	if len(out.Status.Roots) == 0 {
		fmt.Fprintln(a.stdout, "Thêm thư mục được mở từ xa: hive remote roots add <thư mục>.")
	}
	if len(out.Status.Devices) == 0 {
		fmt.Fprintln(a.stdout, "Ghép điện thoại: hive remote pair.")
	}
	return exitOK
}

// confirm hỏi có/không tại terminal. Không có terminal (app, script) thì phải có --yes: không bao giờ tự coi là đồng ý.
func (a *app) confirm(question string, yes bool) int {
	if yes {
		return exitOK
	}
	if !a.console.IsTerminal() {
		return a.errorf(exitUsage, "Cần xác nhận: chạy trong terminal hoặc thêm --yes.")
	}
	fmt.Fprintf(a.stdout, "%s [y/N] ", question)
	line, _ := bufio.NewReader(a.stdin).ReadString('\n')
	if !isYes(line) {
		return a.errorf(exitFailed, "Đã huỷ.")
	}
	return exitOK
}

func isYes(s string) bool {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "y", "yes", "c", "co", "có":
		return true
	}
	return false
}

func (a *app) remoteRoots(args []string) int {
	var label *string
	pos, asJSON, code := a.remoteFlags("roots", args, func(fs *flag.FlagSet) { label = fs.String("label", "", "tên hiện trên điện thoại") })
	if code != exitOK {
		return code
	}
	switch {
	case len(pos) == 0:
		out, code := a.remoteCall(map[string]any{"op": "remote.status"}, false)
		if code != exitOK {
			return code
		}
		if asJSON {
			return a.printJSON(out.Status.Roots)
		}
		a.printRoots(out.Status.Roots)
		return exitOK
	case pos[0] == "add" && len(pos) == 2:
		path := pos[1]
		if !filepath.IsAbs(path) {
			// Worker chỉ nhận đường dẫn tuyệt đối; thư mục tương đối hiểu theo nơi gõ lệnh, như mọi lệnh shell.
			wd, err := a.getwd()
			if err != nil {
				return a.errorf(exitFailed, "Không đọc được thư mục hiện tại: %v", err)
			}
			path = filepath.Join(wd, path)
		}
		out, code := a.remoteCall(map[string]any{"op": "remote.roots.add", "path": path, "label": *label}, asJSON)
		if code == exitOK && !asJSON {
			fmt.Fprintf(a.stdout, "Đã thêm thư mục %s (%s): %s\n", out.Root.Label, out.Root.ID, out.Root.Path)
		}
		return code
	case pos[0] == "rm" && len(pos) == 2:
		_, code := a.remoteCall(map[string]any{"op": "remote.roots.remove", "id": pos[1]}, asJSON)
		if code == exitOK && !asJSON {
			fmt.Fprintf(a.stdout, "Đã gỡ thư mục %s.\n", pos[1])
		}
		return code
	}
	return a.errorf(exitUsage, "Cách dùng: hive remote roots [add <thư mục> [--label NHÃN] | rm <id>].")
}

func (a *app) remoteDevices(args []string) int {
	pos, asJSON, code := a.remoteFlags("devices", args, nil)
	if code != exitOK {
		return code
	}
	switch {
	case len(pos) == 0:
		out, code := a.remoteCall(map[string]any{"op": "remote.status"}, false)
		if code != exitOK {
			return code
		}
		if asJSON {
			return a.printJSON(out.Status.Devices)
		}
		a.printDevices(out.Status.Devices)
		return exitOK
	case pos[0] == "rm" && len(pos) == 2:
		_, code := a.remoteCall(map[string]any{"op": "remote.devices.remove", "id": pos[1]}, asJSON)
		if code == exitOK && !asJSON {
			fmt.Fprintf(a.stdout, "Đã gỡ thiết bị %s; thiết bị đó không mở được phiên trên máy này nữa.\n", pos[1])
		}
		return code
	}
	return a.errorf(exitUsage, "Cách dùng: hive remote devices [rm <id>].")
}

func (a *app) remoteSet(args []string) int {
	var yes *bool
	pos, asJSON, code := a.remoteFlags("set", args, func(fs *flag.FlagSet) { yes = fs.Bool("yes", false, "đã xác nhận ở nơi khác") })
	if code != exitOK {
		return code
	}
	if len(pos) != 2 {
		return a.errorf(exitUsage, "Cách dùng: hive remote set <khoá> <giá trị>. Khoá: %s.", strings.Join(remoteKeyNames(), ", "))
	}
	i := slices.IndexFunc(remoteKeys, func(k remoteKey) bool { return k.key == pos[0] })
	if i < 0 {
		return a.errorf(exitUsage, "Không có khoá %q. Khoá: %s.", pos[0], strings.Join(remoteKeyNames(), ", "))
	}
	k := remoteKeys[i]
	req := map[string]any{"op": "remote.settings"}
	if k.isInt {
		n, err := strconv.Atoi(pos[1])
		if err != nil {
			return a.errorf(exitUsage, "%s cần một số nguyên.", k.key)
		}
		req[k.field] = n
	} else {
		v, ok := parseOnOff(pos[1])
		if !ok {
			return a.errorf(exitUsage, "%s nhận on hoặc off.", k.key)
		}
		if v && k.key == "allow-full-access" {
			// Toàn quyền là agent chạy không hỏi; bật tại máy cũng phải cố ý như khi bật điều khiển từ xa (spec Q3).
			if code := a.confirm("Phiên mở từ xa sẽ chạy toàn quyền (không hỏi trước khi chạy lệnh) khi chính sách cho phép. Bật?", *yes); code != exitOK {
				return code
			}
		}
		req[k.field] = v
	}
	out, code := a.remoteCall(req, asJSON)
	if code != exitOK || asJSON {
		return code
	}
	fmt.Fprintln(a.stdout, "Đã lưu.")
	a.printSettings(out.Status)
	return exitOK
}

func remoteKeyNames() []string {
	names := make([]string, len(remoteKeys))
	for i, k := range remoteKeys {
		names[i] = k.key
	}
	return names
}

func parseOnOff(s string) (bool, bool) {
	switch strings.ToLower(s) {
	case "on", "true", "yes", "1", "bật", "bat":
		return true, true
	case "off", "false", "no", "0", "tắt", "tat":
		return false, true
	}
	return false, false
}

func (a *app) printJSON(v any) int {
	b, err := json.Marshal(v)
	if err != nil {
		return a.errorf(exitFailed, "%v", err)
	}
	fmt.Fprintf(a.stdout, "%s\n", b)
	return exitOK
}

func onOff(v bool) string {
	if v {
		return "bật"
	}
	return "tắt"
}

func yesNo(v bool) string {
	if v {
		return "có"
	}
	return "không"
}

func (a *app) printRemoteStatus(st remoteStatus) {
	if st.Enabled {
		fmt.Fprintln(a.stdout, "Điều khiển từ xa: Bật")
	} else {
		fmt.Fprintln(a.stdout, "Điều khiển từ xa: Tắt")
	}
	if st.Shared {
		fmt.Fprintln(a.stdout, "Máy dùng chung: không bật được điều khiển từ xa.")
		return
	}
	a.printRoots(st.Roots)
	a.printDevices(st.Devices)
	a.printSettings(st)
}

func (a *app) printRoots(roots []remoteRoot) {
	if len(roots) == 0 {
		fmt.Fprintln(a.stdout, "Thư mục được mở từ xa: chưa có (thêm bằng hive remote roots add <thư mục>).")
		return
	}
	fmt.Fprintln(a.stdout, "Thư mục được mở từ xa:")
	tw := tabwriter.NewWriter(a.stdout, 0, 0, 2, ' ', 0)
	for _, r := range roots {
		fmt.Fprintf(tw, "  %s\t%s\t%s\n", r.ID, r.Label, r.Path)
	}
	_ = tw.Flush()
}

func (a *app) printDevices(devices []remoteDevice) {
	if len(devices) == 0 {
		fmt.Fprintln(a.stdout, "Thiết bị đã ghép: chưa có (ghép bằng hive remote pair).")
		return
	}
	fmt.Fprintln(a.stdout, "Thiết bị đã ghép:")
	tw := tabwriter.NewWriter(a.stdout, 0, 0, 2, ' ', 0)
	for _, d := range devices {
		note := ""
		if !d.Synced {
			note = "\tchưa báo hub"
		}
		fmt.Fprintf(tw, "  %s\t%s\tghép %s%s\n", d.ID, d.Label, d.CreatedAt.Local().Format("02/01/2006 15:04"), note)
	}
	_ = tw.Flush()
}

func (a *app) printSettings(st remoteStatus) {
	fmt.Fprintf(a.stdout, "Hỏi trên máy mỗi lần: %s\n", yesNo(st.ConfirmOnMachine))
	fmt.Fprintf(a.stdout, "Ngắt khi không dùng: %d phút · giữ phiên đã tách: %d giờ · tối đa: %d giờ\n",
		st.IdleMinutes, st.DetachedHours, st.MaxHours)
	fmt.Fprintf(a.stdout, "Phiên từ xa chạy toàn quyền: %s\n", yesNo(st.AllowFullAccess))
	a.printTOTP(st)
}

func (a *app) printTOTP(st remoteStatus) {
	if st.TOTP.Locked {
		fmt.Fprintf(a.stdout, "Mã Authenticator: đang khoá tới %s (mở bằng hive remote totp unlock)\n", st.TOTP.LockedUntil.Local().Format("15:04"))
		return
	}
	fmt.Fprintf(a.stdout, "Mã Authenticator: %s\n", onOff(st.TOTP.Enabled))
}

func (a *app) remotePair(args []string) int {
	pos, asJSON, code := a.remoteFlags("pair", args, nil)
	if code != exitOK {
		return code
	}
	if len(pos) > 0 {
		return a.errorf(exitUsage, "Thừa đối số %q.", pos[0])
	}
	if asJSON {
		// App tự vẽ QR và trả lời hộp xác nhận qua watch của nó.
		_, code := a.remoteCall(map[string]any{"op": "remote.pair.begin"}, true)
		return code
	}
	// Mở watch trước khi tạo mã: yêu cầu ghép tới ngay sau khi quét vẫn hiện ở đây.
	w, code := a.openWatch()
	if code != exitOK {
		return code
	}
	defer w.Close()
	out, code := a.remoteCall(map[string]any{"op": "remote.pair.begin"}, false)
	if code != exitOK {
		return code
	}
	p := out.Pair
	if p.URL == "" {
		return a.errorf(exitUsage, "Máy chưa nối hub nào nên không tạo được mã QR; đăng ký máy bằng hive-worker register trước.")
	}
	art, err := renderQR(p.URL, a.console.IsTerminal())
	if err != nil {
		return a.errorf(exitFailed, "Không vẽ được mã QR: %v", err)
	}
	host := p.URL
	if u, err := url.Parse(p.URL); err == nil {
		host = u.Host
	}
	fmt.Fprint(a.stdout, art)
	fmt.Fprintf(a.stdout, "Quét mã bằng camera điện thoại (đăng nhập %s bằng tài khoản chủ máy), tạo passkey rồi trả lời ở đây.\n", host)
	fmt.Fprintf(a.stdout, "Không quét được thì mở link này trên điện thoại: %s\n", p.URL)
	fmt.Fprintf(a.stdout, "Mã dùng được một lần, tới %s.\n", p.ExpiresAt.Local().Format("15:04"))
	return a.followEvents(w, p.PairID, p.ExpiresAt)
}

// openWatch mở kết nối watch; dòng đầu là trạng thái hiện tại.
func (a *app) openWatch() (*localipc.Conn, int) {
	c, _, code := a.connect()
	if code != exitOK {
		return nil, code
	}
	if err := c.Call(map[string]any{"op": "watch"}, nil); err != nil {
		_ = c.Close()
		return nil, a.fail(err)
	}
	return c, exitOK
}

// followEvents đọc sự kiện của watch và hỏi Cho phép tại terminal cho từng yêu cầu ghép; câu trả lời đi trên chính kết
// nối watch. only khác rỗng (hive remote pair) thì chỉ theo mã ghép đó và dừng khi có kết quả hoặc mã hết hạn.
func (a *app) followEvents(w *localipc.Conn, only string, until time.Time) int {
	done := make(chan struct{})
	defer close(done)
	events := make(chan remoteEvent)
	lost := make(chan error, 1)
	go func() {
		for {
			var e remoteEvent
			if err := w.ReadJSON(&e); err != nil {
				lost <- err
				return
			}
			select {
			case events <- e:
			case <-done:
				return
			}
		}
	}()
	answers := a.stdinLines(done)
	var expire <-chan time.Time
	var timer *time.Timer
	if !until.IsZero() {
		timer = time.NewTimer(time.Until(until))
		defer timer.Stop()
		expire = timer.C
	}
	eof := false
	var queue []remoteEvent // yêu cầu chờ trả lời, cũ trước; chỉ hỏi cái đầu
	decide := func(pairID string, allow bool) {
		_ = w.WriteJSON(map[string]any{"op": "remote.pair.decide", "pairId": pairID, "allow": allow})
	}
	prompt := func() {
		for len(queue) > 0 && eof {
			// Không còn ai trả lời được ở đây: từ chối ngay thay vì để điện thoại chờ hết giờ.
			fmt.Fprintf(a.stderr, "hive: không đọc được câu trả lời; từ chối ghép %q.\n", queue[0].Label)
			decide(queue[0].PairID, false)
			queue = queue[1:]
		}
		if len(queue) > 0 {
			e := queue[0]
			fmt.Fprintf(a.stdout, "Ghép %q (người dùng %s) vào máy này? Thiết bị đó sẽ mở được agent trong các thư mục đã cho phép. Cho phép? [y/N] ",
				e.Label, e.UserID)
		}
	}
	for {
		select {
		case e := <-events:
			if only != "" && e.PairID != only {
				continue
			}
			switch e.Event {
			case "":
				// Trả lời cho remote.pair.decide; not_found là đã có người trả lời trên app hoặc đã hết giờ.
				if !e.OK && e.Code != localipc.CodeNotFound && e.Error != "" {
					fmt.Fprintf(a.stderr, "hive: %s\n", e.Error)
				}
			case "state":
				if e.State != nil {
					fmt.Fprintf(a.stdout, "Điều khiển từ xa: %s\n", onOff(e.State.Enabled))
				}
			case "pair_request":
				if timer != nil {
					// Mã đã được dùng; kết quả tới khi chủ máy trả lời hoặc worker hết giờ chờ.
					timer.Reset(time.Until(e.ExpiresAt) + 10*time.Second)
				}
				queue = append(queue, e)
				if len(queue) == 1 {
					prompt()
				}
			case "pair_done":
				head := len(queue) > 0 && queue[0].PairID == e.PairID
				queue = slices.DeleteFunc(queue, func(q remoteEvent) bool { return q.PairID == e.PairID })
				if head {
					// Câu hỏi còn treo (trả lời ở app hoặc hết giờ): xuống dòng trước khi in kết quả.
					fmt.Fprintln(a.stdout)
				}
				code := a.pairDone(e)
				if only != "" {
					return code
				}
				if head {
					prompt()
				}
			}
		case line, ok := <-answers:
			if !ok {
				answers, eof = nil, true
			} else if len(queue) > 0 {
				decide(queue[0].PairID, isYes(line))
				queue = queue[1:]
			}
			prompt()
		case <-expire:
			return a.errorf(exitFailed, "Mã ghép đã hết hạn. Chạy lại hive remote pair.")
		case <-lost:
			return a.errorf(exitFailed, "Mất kết nối tới hive-worker.")
		}
	}
}

func (a *app) pairDone(e remoteEvent) int {
	if e.OK {
		fmt.Fprintf(a.stdout, "Đã ghép thiết bị %s. Gỡ bằng hive remote devices rm %s.\n", e.DeviceID, e.DeviceID)
		return exitOK
	}
	msg, ok := pairReasons[e.Reason]
	if !ok {
		msg = "Ghép không thành công (" + e.Reason + ")."
	}
	return a.errorf(exitFailed, "%s", msg)
}

// stdinLines đọc stdin từng dòng; kênh đóng khi hết stdin.
func (a *app) stdinLines(done <-chan struct{}) <-chan string {
	ch := make(chan string)
	go func() {
		defer close(ch)
		sc := bufio.NewScanner(a.stdin)
		for sc.Scan() {
			select {
			case ch <- sc.Text():
			case <-done:
				return
			}
		}
	}()
	return ch
}

// remoteWatch: --json là cầu cho app desktop (sidecar): mỗi dòng worker gửi in nguyên ra stdout, mỗi dòng JSON trên stdin
// gửi tới worker (vd. remote.pair.decide). App đóng stdin là thôi theo dõi.
func (a *app) remoteWatch(args []string) int {
	pos, asJSON, code := a.remoteFlags("watch", args, nil)
	if code != exitOK {
		return code
	}
	if len(pos) > 0 {
		return a.errorf(exitUsage, "Thừa đối số %q.", pos[0])
	}
	if !asJSON {
		w, code := a.openWatch()
		if code != exitOK {
			return code
		}
		defer w.Close()
		fmt.Fprintln(a.stderr, "hive: đang theo dõi điều khiển từ xa; Ctrl-C để thôi.")
		return a.followEvents(w, "", time.Time{})
	}
	c, _, code := a.connect()
	if code != exitOK {
		return code
	}
	defer c.Close()
	var first json.RawMessage
	if err := c.WriteJSON(map[string]any{"op": "watch"}); err != nil {
		return a.fail(err)
	}
	if err := c.ReadJSON(&first); err != nil {
		return a.errorf(exitFailed, "Mất kết nối tới hive-worker.")
	}
	var head struct {
		OK    bool   `json:"ok"`
		Code  string `json:"code"`
		Error string `json:"error"`
	}
	if err := json.Unmarshal(first, &head); err != nil || !head.OK {
		return a.fail(&localipc.RemoteError{Code: head.Code, Message: head.Error})
	}
	fmt.Fprintf(a.stdout, "%s\n", first)
	closed := make(chan struct{})
	go func() {
		sc := bufio.NewScanner(a.stdin)
		sc.Buffer(make([]byte, 0, 4096), 64*1024)
		for sc.Scan() {
			line := bytes.TrimSpace(sc.Bytes())
			if len(line) == 0 {
				continue
			}
			if !json.Valid(line) {
				fmt.Fprintln(a.stderr, "hive: bỏ qua dòng stdin không phải JSON.")
				continue
			}
			if err := c.WriteJSON(json.RawMessage(line)); err != nil {
				return
			}
		}
		// Báo thôi theo dõi trước khi đóng để vòng đọc không coi là mất kết nối.
		close(closed)
		_ = c.Close()
	}()
	for {
		var line json.RawMessage
		if err := c.ReadJSON(&line); err != nil {
			select {
			case <-closed:
				return exitOK
			default:
			}
			return a.errorf(exitFailed, "Mất kết nối tới hive-worker.")
		}
		fmt.Fprintf(a.stdout, "%s\n", line)
	}
}
