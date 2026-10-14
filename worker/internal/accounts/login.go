package accounts

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/pty"
)

// Loại bước đăng nhập gói worker báo hub (account_login_event.kind).
const (
	LoginURL    = "url"
	LoginCode   = "code"
	LoginPrompt = "prompt"
	LoginDone   = "done"
	LoginError  = "error"
)

// LoginTimeout là thời gian tối đa một phiên đăng nhập, bằng ACCOUNT_LOGIN_TIMEOUT_SEC của hợp đồng: hub cũng tự huỷ sau
// chừng này nên worker không giữ tiến trình CLI mãi.
const LoginTimeout = 600 * time.Second

// Lời nhắc và lỗi gửi hub. Cố định, không bao giờ chép output của CLI: output có thể chứa token hay đường dẫn trên máy.
const (
	msgBusy       = "Máy đang có một phiên đăng nhập gói."
	msgPasteCode  = "Dán mã xác nhận hiện ra sau khi đăng nhập."
	msgPasteToken = "Chạy `claude setup-token` ở máy có trình duyệt rồi dán token vào đây."
	msgTimeout    = "Hết thời gian chờ đăng nhập gói."
	msgFailed     = "Đăng nhập không thành công."
	msgStart      = "Không chạy được lệnh đăng nhập."
	msgSave       = "Không lưu được đăng nhập của gói."
)

// errNoPTY: Windows chưa có PTY trong worker (gói pty trả ErrUnsupported).
var errNoPTY = errors.New("Windows chưa hỗ trợ đăng nhập gói từ web; đăng nhập tại máy bằng hive-worker accounts add.")

// startPTY chạy cmd trong một PTY. Cột rộng để CLI không tự ngắt dòng giữa URL đăng nhập (URL bị ngắt thì web nhận URL
// cụt).
func startPTY(cmd *exec.Cmd) (io.ReadWriteCloser, error) {
	f, err := pty.Start(cmd, 500, 50)
	if errors.Is(err, pty.ErrUnsupported) {
		return nil, errNoPTY
	}
	if err != nil {
		return nil, err
	}
	return f, nil
}

// LoginEvent nhận từng bước của phiên đăng nhập để gửi hub. accountID chỉ có ở "done". Mỗi phiên có đúng một bước cuối
// ("done" hoặc "error"), trừ khi bị huỷ (hub tự biết nên không báo lại).
type LoginEvent func(kind, text, accountID string)

// Login chạy đăng nhập gói từ web trên máy không màn hình (T063): tạo một tài khoản mới có thư mục cấu hình riêng, chạy lệnh
// đăng nhập của CLI trong PTY rồi chuyển URL, mã thiết bị và lời nhắc cho hub. Mỗi máy tối đa một phiên.
type Login struct {
	path, home string
	// lookup tìm CLI; nil là theo lookPath. Test thay bằng CLI giả.
	lookup func(string) (string, error)
	// timeout nil/0 là LoginTimeout. Test rút ngắn để không chờ 10 phút.
	timeout time.Duration

	mu  sync.Mutex
	cur *loginSession
}

func NewLogin(path, home string) *Login { return &Login{path: path, home: home} }

type loginSession struct {
	requestID string
	cancel    context.CancelFunc
	input     chan string

	mu     sync.Mutex
	closed bool
	emit   LoginEvent
}

// send gửi một bước nếu phiên chưa đóng; khoá để bước từ goroutine đọc PTY và bước cuối không chạy chồng nhau.
func (s *loginSession) send(kind, text, accountID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.closed {
		s.emit(kind, text, accountID)
	}
}

func (s *loginSession) close() {
	s.mu.Lock()
	s.closed = true
	s.mu.Unlock()
}

// loginHowTo là cách đăng nhập từ web mỗi CLI nhận (hợp đồng accountLoginHow); "browser" của Add cần trình duyệt trên máy
// nên không có ở đây.
var loginHowTo = map[string][]string{"claude": {"plan", "sso", "console", "token"}, "codex": {"device"}}

// Start mở phiên đăng nhập và trả ngay; mọi bước (kể cả lỗi) tới qua emit từ goroutine khác. ctx là vòng đời của worker.
func (l *Login) Start(ctx context.Context, requestID, cli, label, how string, emit LoginEvent) {
	timeout := l.timeout
	if timeout <= 0 {
		timeout = LoginTimeout
	}
	l.mu.Lock()
	if l.cur != nil {
		l.mu.Unlock()
		emit(LoginError, msgBusy, "")
		return
	}
	rctx, cancel := context.WithTimeout(ctx, timeout)
	s := &loginSession{requestID: requestID, cancel: cancel, input: make(chan string, 8), emit: emit}
	l.cur = s
	l.mu.Unlock()
	go func() {
		defer cancel()
		final := l.run(rctx, s, cli, label, how)
		// Nhả chỗ trước khi báo bước cuối: hub có thể mở phiên mới ngay khi nhận "done" hay "error".
		l.mu.Lock()
		l.cur = nil
		l.mu.Unlock()
		if final.kind != "" {
			s.send(final.kind, final.text, final.accountID)
		}
		s.close()
	}()
}

// Input chuyển chữ người dùng dán cho phiên requestID; false khi không có phiên đó. Không bao giờ ghi log chữ này.
func (l *Login) Input(requestID, text string) bool {
	l.mu.Lock()
	s := l.cur
	l.mu.Unlock()
	if s == nil || s.requestID != requestID {
		return false
	}
	select {
	case s.input <- text:
		return true
	default:
		return false
	}
}

// Cancel huỷ phiên requestID: dừng CLI và xoá tài khoản dở. Không báo bước nào về hub vì hub là bên huỷ.
func (l *Login) Cancel(requestID string) bool {
	l.mu.Lock()
	s := l.cur
	l.mu.Unlock()
	if s == nil || s.requestID != requestID {
		return false
	}
	s.cancel()
	return true
}

// CancelAll huỷ phiên đang chạy, nếu có; dùng khi mất kết nối hub vì không còn ai nhập mã hay nhận kết quả.
func (l *Login) CancelAll() {
	l.mu.Lock()
	s := l.cur
	l.mu.Unlock()
	if s != nil {
		s.cancel()
	}
}

// loginFinal là bước cuối của phiên; kind rỗng khi huỷ (không báo).
type loginFinal struct{ kind, text, accountID string }

func failed(text string) loginFinal { return loginFinal{kind: LoginError, text: text} }

func (l *Login) run(ctx context.Context, s *loginSession, cli, label, how string) loginFinal {
	hows, ok := loginHowTo[cli]
	if !ok {
		return failed("CLI phải là claude hoặc codex.")
	}
	if !contains(hows, how) {
		return failed(fmt.Sprintf("%s không đăng nhập từ web theo cách %q.", cli, how))
	}
	label = strings.TrimSpace(label)
	if err := checkLabel(label); err != nil {
		return failed(capitalize(err.Error()) + ".")
	}
	acct, dir, err := l.create(cli, label)
	if err != nil {
		return failed("Không tạo được thư mục đăng nhập của gói.")
	}
	done := false
	defer func() {
		if !done {
			l.discard(acct.ID, dir)
		}
	}()
	if how == "token" {
		err = l.tokenFlow(ctx, s, dir)
	} else {
		err = l.cliFlow(ctx, s, cli, how, dir)
	}
	if err == nil {
		err = l.finish(acct)
	}
	switch {
	case err == nil:
		done = true
		return loginFinal{kind: LoginDone, accountID: acct.ID}
	case errors.Is(err, context.Canceled):
		return loginFinal{}
	case errors.Is(err, context.DeadlineExceeded):
		return failed(msgTimeout)
	}
	return failed(err.Error())
}

func capitalize(s string) string {
	if s == "" {
		return s
	}
	r := []rune(s)
	return strings.ToUpper(string(r[:1])) + string(r[1:])
}

// create thêm tài khoản dở với thư mục riêng. Khác Add, không bao giờ dùng thư mục mặc định của CLI: phiên huỷ sẽ xoá
// thư mục này nên nó phải là của riêng phiên. Id nào đã có thư mục (tài khoản đã Remove nhưng giữ đăng nhập) bị bỏ qua để
// đăng nhập cũ không làm phiên mới trông như thành công, và để xoá không phá đăng nhập cũ.
func (l *Login) create(cli, label string) (Account, string, error) {
	var a Account
	var dir string
	err := modify(l.path, func(f *file) error {
		taken := map[string]bool{}
		for _, x := range f.Accounts {
			taken[x.ID] = true
		}
		n := 1
		for taken[cli+"-"+strconv.Itoa(n)] || exists(filepath.Join(AccountsDir(l.home), cli+"-"+strconv.Itoa(n))) {
			n++
		}
		id := cli + "-" + strconv.Itoa(n)
		a = Account{ID: id, Label: label, CLI: cli, ConfigDir: "~/.xdev-hive/accounts/" + id, Pending: true}.withDefaults()
		dir = expandHome(l.home, a.ConfigDir)
		// CLI tự tạo thư mục cấu hình nhưng với quyền mặc định; thư mục giữ token đăng nhập chỉ chủ máy đọc được.
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return err
		}
		f.Accounts = append(f.Accounts, a)
		return nil
	})
	return a, dir, err
}

// finish biến tài khoản dở thành tài khoản dùng được. Bật ngay vì người quản trị vừa đăng nhập nó chính là để dùng.
func (l *Login) finish(a Account) error {
	err := modify(l.path, func(f *file) error {
		x, err := find(f, a.ID)
		if err != nil {
			return err
		}
		x.Pending, x.Enabled = false, true
		return nil
	})
	if err != nil {
		return errors.New(msgSave)
	}
	return nil
}

// discard xoá tài khoản dở khỏi accounts.json và thư mục đăng nhập của nó.
func (l *Login) discard(id, dir string) {
	_ = modify(l.path, func(f *file) error {
		for i, a := range f.Accounts {
			if a.ID == id && a.Pending {
				f.Accounts = append(f.Accounts[:i], f.Accounts[i+1:]...)
				break
			}
		}
		return nil
	})
	removeLoginDir(l.home, dir)
}

// removeLoginDir chỉ xoá thư mục nằm dưới ~/.xdev-hive/accounts: accounts.json là file người dùng sửa được, đường dẫn
// trong đó không được dẫn tới RemoveAll một thư mục tuỳ ý.
func removeLoginDir(home, dir string) {
	rel, err := filepath.Rel(AccountsDir(home), filepath.Clean(dir))
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return
	}
	_ = os.RemoveAll(dir)
}

// CleanupPending xoá tài khoản dở còn lại từ lần worker chết giữa phiên đăng nhập, gọi lúc worker khởi động. Trả số tài
// khoản đã xoá.
func CleanupPending(path, home string) (int, error) {
	var dirs []string
	err := modify(path, func(f *file) error {
		kept := f.Accounts[:0]
		for _, a := range f.Accounts {
			if a.Pending {
				dirs = append(dirs, expandHome(home, a.ConfigDir))
				continue
			}
			kept = append(kept, a)
		}
		if len(dirs) == 0 {
			return errNothing
		}
		f.Accounts = kept
		return nil
	})
	if errors.Is(err, errNothing) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	for _, d := range dirs {
		removeLoginDir(home, d)
	}
	return len(dirs), nil
}

// errNothing để modify bỏ qua việc ghi lại file khi không có gì đổi.
var errNothing = errors.New("không có gì để đổi")

// tokenFlow: Claude đăng nhập bằng token `claude setup-token` dán từ web, không chạy tiến trình nào.
func (l *Login) tokenFlow(ctx context.Context, s *loginSession, dir string) error {
	s.send(LoginPrompt, msgPasteToken, "")
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case text := <-s.input:
			token, err := CheckToken(text)
			if err != nil {
				s.send(LoginPrompt, "Token không hợp lệ: "+err.Error()+". Dán lại token.", "")
				continue
			}
			if err := WriteToken(dir, token); err != nil {
				return errors.New(msgSave)
			}
			return nil
		}
	}
}

func (l *Login) find(cli string) (string, error) {
	look := l.lookup
	if look == nil {
		look = lookPath
	}
	bin, err := look(binary(cli))
	if err != nil {
		return "", fmt.Errorf("Máy chưa cài %s.", binary(cli))
	}
	return bin, nil
}

// loginArgs là lệnh đăng nhập của CLI theo cách chọn.
func loginArgs(cli, how string) []string {
	if cli == "codex" {
		return []string{"login", "--device-auth"}
	}
	args := []string{"auth", "login"}
	if how == "sso" || how == "console" {
		args = append(args, "--"+how)
	}
	return args
}

// loginEnv là môi trường của lệnh đăng nhập: thư mục cấu hình riêng của gói, và không thừa kế token của dịch vụ worker
// (CLI thấy token sẽ đăng nhập bằng token đó thay vì hỏi).
func loginEnv(extra map[string]string) []string {
	env := make([]string, 0, len(os.Environ())+len(extra)+1)
	for _, kv := range os.Environ() {
		if strings.HasPrefix(kv, tokenEnv+"=") {
			continue
		}
		env = append(env, kv)
	}
	for k, v := range extra {
		env = append(env, k+"="+v)
	}
	return append(env, "TERM=xterm-256color")
}

// readDrain: sau khi CLI thoát, chờ goroutine đọc PTY nốt phần output còn lại tối đa chừng này (tiến trình con giữ PTY mở
// thì không có EOF).
const readDrain = 2 * time.Second

func (l *Login) cliFlow(ctx context.Context, s *loginSession, cli, how, dir string) error {
	bin, err := l.find(cli)
	if err != nil {
		return err
	}
	env := map[string]string{envVar[cli]: dir}
	cmd := exec.Command(bin, loginArgs(cli, how)...)
	// Ngoài mọi repo: lệnh đăng nhập không được nạp cấu hình của một dự án.
	cmd.Dir = os.TempDir()
	cmd.Env = loginEnv(env)
	pt, err := startPTY(cmd)
	if err != nil {
		if errors.Is(err, errNoPTY) {
			return err
		}
		return errors.New(msgStart)
	}
	defer pt.Close()
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		sc := &loginScanner{cli: cli, send: func(kind, text string) { s.send(kind, text, "") }}
		buf := make([]byte, 4096)
		for {
			n, err := pt.Read(buf)
			if n > 0 {
				sc.feed(buf[:n])
			}
			if err != nil {
				return
			}
		}
	}()
	for {
		select {
		case <-ctx.Done():
			pty.KillGroup(cmd)
			<-exited
			return ctx.Err()
		case text := <-s.input:
			writeInput(pt, text)
		case err := <-exited:
			select {
			case <-readDone:
			case <-time.After(readDrain):
			}
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if err != nil {
				return errors.New(msgFailed)
			}
			if !l.verify(ctx, cli, bin, dir, env) {
				return errors.New(msgFailed)
			}
			return nil
		}
	}
}

// writeInput ghi chữ vào PTY rồi Enter. Enter ghi riêng sau một nhịp: CLI dựng bằng Ink coi chuỗi tới liền một lúc là dán
// và biến Enter thành xuống dòng thay vì gửi. Bỏ ký tự điều khiển để chữ dán từ web không chèn được phím hay chuỗi escape.
func writeInput(w io.Writer, text string) {
	clean := strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, text)
	_, _ = w.Write([]byte(clean))
	time.Sleep(100 * time.Millisecond)
	_, _ = w.Write([]byte("\r"))
}

// verifyTimeout chặn lệnh kiểm tra đăng nhập sau khi CLI thoát.
const verifyTimeout = 30 * time.Second

// verify xác nhận CLI đã thoát 0 thì thật sự đã đăng nhập: Claude hỏi `claude auth status` (thoát 0 là đã đăng nhập), Codex
// đọc auth.json. Không chạy được `auth status` (CLI cũ không có lệnh này) thì tin file cấu hình.
func (l *Login) verify(ctx context.Context, cli, bin, dir string, env map[string]string) bool {
	a := Account{CLI: cli, ConfigDir: dir}
	if cli != "claude" {
		ok, _ := loginOf(a, l.home)
		return ok != nil && *ok
	}
	vctx, cancel := context.WithTimeout(ctx, verifyTimeout)
	defer cancel()
	cmd := exec.CommandContext(vctx, bin, "auth", "status")
	cmd.Dir = os.TempDir()
	cmd.Env = loginEnv(env)
	err := cmd.Run()
	if err == nil {
		return true
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return false
	}
	ok, _ := loginOf(a, l.home)
	return ok != nil && *ok
}

// Nhận dạng output của CLI. ansi: chuỗi điều khiển (OSC kể cả liên kết OSC 8, CSI, chọn bộ ký tự); tên URL dừng ở khoảng
// trắng, nháy hay ký tự điều khiển.
var (
	ansiPattern   = regexp.MustCompile(`\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[()][0-9A-Za-z]|\x1b[=>78]`)
	urlPattern    = regexp.MustCompile("https://[^\\s\"'<>`\\x00-\\x1f]+")
	codeWord      = regexp.MustCompile(`(?i)\bcode\b`)
	codePattern   = regexp.MustCompile(`\b[A-Z0-9]{4,}-[A-Z0-9]{4,}\b`)
	promptPattern = regexp.MustCompile(`(?i)paste code`)
)

// maxScan giới hạn output giữ lại để nhận dạng; URL, mã và lời nhắc đều xuất hiện sớm.
const maxScan = 32 << 10

// maxEventText là giới hạn account_login_event.text của hợp đồng.
const maxEventText = 2000

// stripANSI bỏ chuỗi điều khiển của terminal. CLI dựng bằng Ink thay khoảng trắng bằng lệnh nhích con trỏ sang phải nên
// lệnh đó thành một khoảng trắng, lệnh nhảy dòng thành xuống dòng; không thì "Paste code here" dính thành "Pastecodehere".
func stripANSI(raw string) string {
	out := ansiPattern.ReplaceAllStringFunc(raw, func(seq string) string {
		if seq[1] != '[' {
			return ""
		}
		switch seq[len(seq)-1] {
		case 'C':
			return " "
		case 'B', 'E', 'H', 'f', 'd':
			return "\n"
		}
		return ""
	})
	return strings.ReplaceAll(strings.ReplaceAll(out, "\r\n", "\n"), "\r", "\n")
}

// loginScanner đọc output của CLI đăng nhập và báo mỗi loại bước đúng một lần. Chỉ ba loại: URL đầu tiên, mã thiết bị
// (Codex) và lời nhắc dán mã (Claude); mọi thứ khác bị bỏ, và lời nhắc là câu cố định chứ không phải câu của CLI.
type loginScanner struct {
	cli  string
	send func(kind, text string)

	raw                           []byte
	sentURL, sentCode, sentPrompt bool
}

func (s *loginScanner) feed(chunk []byte) {
	s.raw = append(s.raw, chunk...)
	if len(s.raw) > maxScan {
		s.raw = s.raw[len(s.raw)-maxScan:]
	}
	text := stripANSI(string(s.raw))
	if !s.sentURL {
		// URL chưa có ký tự nào theo sau có thể mới tới nửa chừng; chờ lần đọc sau.
		if loc := urlPattern.FindStringIndex(text); loc != nil && loc[1] < len(text) {
			if url := trimURL(text[loc[0]:loc[1]]); len(url) <= maxEventText {
				s.sentURL = true
				s.send(LoginURL, url)
			}
		}
	}
	if s.cli == "codex" && !s.sentCode {
		// Bỏ URL trước khi tìm mã: tham số trong URL (client_id, state) có thể giống một mã.
		plain := urlPattern.ReplaceAllString(text, " ")
		for _, w := range codeWord.FindAllStringIndex(plain, -1) {
			window := plain[w[0]:min(len(plain), w[0]+200)]
			if loc := codePattern.FindStringIndex(window); loc != nil && w[0]+loc[1] < len(plain) {
				s.sentCode = true
				s.send(LoginCode, window[loc[0]:loc[1]])
				break
			}
		}
	}
	if !s.sentPrompt && promptPattern.MatchString(text) {
		s.sentPrompt = true
		s.send(LoginPrompt, msgPasteCode)
	}
}

// trimURL bỏ dấu câu CLI in liền sau URL.
func trimURL(u string) string {
	u = strings.TrimRight(u, ".,;:")
	if strings.HasSuffix(u, ")") && !strings.Contains(u, "(") {
		u = strings.TrimSuffix(u, ")")
	}
	return u
}
