package terminal

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"

	"github.com/tdduydev/xdev-hive/worker/internal/accounts"
	"github.com/tdduydev/xdev-hive/worker/internal/remoteauth"
)

// Mở phiên mới từ điện thoại (specs/010 T050; FR-018–FR-020). Hub chỉ chuyển term_start; máy tự kiểm chữ ký, chỉ mở CLI
// máy có trong thư mục được phép (đã giải symlink), áp model và mức quyền hub gửi theo chính sách tổ chức nhưng không bao
// giờ chạy toàn quyền khi chủ máy chưa bật "Cho phiên từ xa chạy toàn quyền" tại máy. Không nhận lệnh, đối số tự do hay
// biến môi trường từ xa: đối số của CLI do máy dựng từ các trường có kiểu.

// Mức quyền của term_start.permissions.
const (
	PermAsk       = "ask"
	PermWorkspace = "workspace"
	PermFull      = "full"
)

// Mã từ chối của term_start ngoài mã của Controller và remoteauth.
const (
	codeRootMissing        = "ROOT_MISSING"
	codeRootEscape         = "ROOT_ESCAPE"
	codeCLIMissing         = "CLI_MISSING"
	codeAccountUnavailable = "ACCOUNT_UNAVAILABLE"
	codeConfirmDenied      = "CONFIRM_DENIED"
	codeConfirmTimeout     = "CONFIRM_TIMEOUT"
	codeBusy               = "BUSY"
)

// startDenyText là câu cho người dùng của term_denied (khớp TERM_DENY_MESSAGES của contracts); mã khác dùng câu chung.
var startDenyText = map[string]string{
	codeRemoteDisabled:                remoteDisabledText,
	codeMachineShared:                 "Máy dùng chung không cho điều khiển từ xa bằng thiết bị cá nhân.",
	codeRootMissing:                   "Thư mục không còn trong danh sách được phép hoặc không tồn tại.",
	codeRootEscape:                    "Đường dẫn đi ra ngoài thư mục được phép.",
	codeCLIMissing:                    "Máy không có CLI này.",
	codeAccountUnavailable:            "Không có tài khoản CLI dùng được trên máy.",
	codeConfirmDenied:                 "Chủ máy đã từ chối tại máy.",
	codeConfirmTimeout:                "Không có ai xác nhận tại máy trong 60 giây.",
	codeBusy:                          "Máy đang chạy tối đa số phiên.",
	remoteauth.CodeAuthStale:          "Yêu cầu đã quá hạn hoặc đồng hồ thiết bị lệch quá 2 phút. Thử lại.",
	remoteauth.CodeAuthReplay:         "Yêu cầu này đã được dùng. Thử lại.",
	remoteauth.CodeDeviceUnknown:      "Thiết bị chưa được ghép với máy này hoặc đã bị gỡ.",
	remoteauth.CodeDeviceUserMismatch: "Thiết bị được ghép cho người dùng khác.",
	remoteauth.CodeTOTPInvalid:        "Mã Authenticator không đúng.",
	remoteauth.CodeTOTPReplay:         "Mã này vừa được dùng. Chờ mã mới rồi thử lại.",
	remoteauth.CodeTOTPLocked:         "Nhập sai mã quá nhiều lần, máy tạm khoá mã Authenticator.",
	remoteauth.CodeTOTPNotAllowed:     "Tổ chức hoặc máy không cho dùng mã Authenticator (TOTP) cho hub này.",
}

// modelName: model là một đối số của CLI nên chỉ nhận dạng tên model, không nhận chuỗi bắt đầu bằng `-` (sẽ thành cờ).
var modelName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/@\[\]-]{0,99}$`)

// Start là term_start; kiểm chữ ký, chờ chủ máy và spawn PTY chạy riêng để không chặn vòng đọc của kênh.
func (c *Controller) Start(req StartRequest) {
	go func() {
		if code := c.start(req); code != "" {
			c.denyStart(req, code)
		}
	}()
}

// start trả mã từ chối, rỗng là đã mở phiên (term_opened do Recorder gửi kèm requestId).
func (c *Controller) start(req StartRequest) string {
	cfg, code := c.allowed()
	if code != "" {
		return code
	}
	res, code := c.verifyStart(req, cfg)
	if code != "" {
		c.Remote.audit("start_denied", byHub(req.UserID), map[string]any{"requestId": req.RequestID,
			"deviceId": req.DeviceID, "code": code})
		return code
	}
	// Kiểm chữ ký trước mọi điều kiện của máy, để yêu cầu không có chữ ký không dò được máy có CLI hay thư mục nào.
	code, opened := c.openStart(req, cfg, res)
	data := map[string]any{"requestId": req.RequestID, "deviceId": req.DeviceID, "cli": req.CLI, "rootId": req.RootID}
	if code != "" {
		data["code"] = code
		c.Remote.audit("start_denied", byHub(req.UserID), data)
		return code
	}
	data["sessionId"], data["permissions"], data["cwd"] = opened.rec.ID(), opened.perm, opened.cwdLabel
	c.Remote.audit("start", byHub(req.UserID), data)
	c.log().Info("Đã mở phiên từ xa", "request", req.RequestID, "session", opened.rec.ID(), "cli", req.CLI,
		"permissions", opened.perm)
	return ""
}

func (c *Controller) verifyStart(req StartRequest, cfg remoteauth.Config) (remoteauth.Result, string) {
	a := req.Auth
	auth := remoteauth.Auth{Kind: a.Kind, Code: a.Code, EphPub: a.EphPub, TS: a.TS, Nonce: a.Nonce}
	if a.Assertion != nil {
		auth.Assertion = &remoteauth.Assertion{CredentialID: a.Assertion.CredentialID,
			AuthenticatorData: a.Assertion.AuthenticatorData, ClientDataJSON: a.Assertion.ClientDataJSON,
			Signature: a.Assertion.Signature, UserHandle: a.Assertion.UserHandle}
	}
	c.mu.Lock()
	policy := c.policy
	c.mu.Unlock()
	owner := cfg.OwnerUserID
	if o := c.Remote.welcomeOwner(); o != nil && o.UserID != "" {
		owner = o.UserID
	}
	// Model và mức quyền không nằm trong phần ký: hub gắn theo chính sách tổ chức, máy chỉ hạ xuống chứ không nâng.
	res, err := c.Verifier.VerifyAuth(remoteauth.Request{
		MachineID: c.Remote.Machine, Action: "start",
		Params: remoteauth.StartParams(req.UserID, req.DeviceID, req.CLI, req.AccountID, req.RootID, req.Subdir,
			req.ProjectID, req.TaskID, req.Prompt, req.Cols, req.Rows),
		Auth: auth,
	}, remoteauth.Policy{HubURL: c.Remote.HubURL, TOTPFallback: policy, TOTPOnHTTPS: cfg.TOTPOnHTTPS, OwnerUserID: owner})
	if auth.Kind == remoteauth.KindTOTP {
		c.Remote.changed()
	}
	if err != nil {
		c.log().Info("Từ chối mở phiên từ xa", "request", req.RequestID, "code", remoteauth.Code(err), "error", err)
		return res, remoteauth.Code(err)
	}
	return res, ""
}

type startedSession struct {
	rec            *RecordedSession
	perm, cwdLabel string
}

func (c *Controller) openStart(req StartRequest, cfg remoteauth.Config, res remoteauth.Result) (string, startedSession) {
	if !slices.Contains(LocalCLIs, req.CLI) || !slices.Contains(c.Remote.CLIs, req.CLI) {
		return codeCLIMissing, startedSession{}
	}
	path, err := c.Local.cliPath(req.CLI)
	if err != nil {
		return codeCLIMissing, startedSession{}
	}
	i := slices.IndexFunc(cfg.Roots, func(r remoteauth.Root) bool { return r.ID == req.RootID })
	if i < 0 {
		return codeRootMissing, startedSession{}
	}
	root := cfg.Roots[i]
	cwd, rel, code := resolveRoot(root.Path, req.Subdir)
	if code != "" {
		return code, startedSession{}
	}
	label := root.Label
	if rel != "." {
		label += "/" + rel
	}
	perm := startPermissions(req.Permissions, cfg.AllowFullAccess)
	model := req.Model
	if model != "" && !modelName.MatchString(model) {
		// Hub lỗi gửi model lạ: chạy model mặc định của CLI thay vì đưa chuỗi lạ vào dòng lệnh.
		c.log().Warn("Bỏ model không hợp lệ của term_start", "request", req.RequestID)
		model = ""
	}
	args, typed := startArgs(req.CLI, model, perm, req.Prompt, batchShim(path))

	if cfg.ConfirmOnMachine {
		allow, answered := c.Remote.ask(req.RequestID, watchEvent{Event: eventStartRequest, RequestID: req.RequestID,
			UserID: req.UserID, Label: deviceLabel(cfg, res), CLI: req.CLI, Cwd: label})
		reason := ""
		switch {
		case !answered:
			reason = codeConfirmTimeout
		case !allow:
			reason = codeConfirmDenied
		}
		c.Remote.broadcast(watchEvent{Event: "start_done", RequestID: req.RequestID, OK: reason == "", Reason: reason})
		if reason != "" {
			return reason, startedSession{}
		}
		// Chủ máy có thể đã tắt từ xa trong lúc hộp xác nhận còn mở.
		if _, code := c.allowed(); code != "" {
			return code, startedSession{}
		}
	}

	id, err := c.Local.reserve()
	if err != nil {
		return codeBusy, startedSession{}
	}
	s, err := c.Local.start(id, CreateParams{CLI: req.CLI, Cwd: cwd, Args: args, Account: req.AccountID,
		ProjectID: req.ProjectID, TaskID: req.TaskID, origin: OriginRemote, requestID: req.RequestID, permissions: perm,
		cwdLabel: label, typed: typed}, fitSize(req.Cols, 80), fitSize(req.Rows, 24), "xterm-256color")
	if err != nil {
		c.Local.release(id)
		c.log().Warn("Không mở được phiên từ xa", "request", req.RequestID, "cli", req.CLI, "error", err)
		if errors.Is(err, accounts.ErrNoAccount) || errors.Is(err, accounts.ErrBusy) {
			return codeAccountUnavailable, startedSession{}
		}
		return codeCLIMissing, startedSession{}
	}
	if s.rec == nil {
		// Không ghi được lên hub thì điện thoại không thấy phiên: ngắt ngay thay vì để CLI chạy không ai điều khiển.
		s.stop(ReasonClosed, "Phiên mở từ xa không ghi được lên hub.")
		return codeRemoteDisabled, startedSession{}
	}
	return "", startedSession{rec: s.rec, perm: perm, cwdLabel: label}
}

func (c *Controller) denyStart(req StartRequest, code string) {
	text, ok := startDenyText[code]
	if !ok {
		text = "Máy từ chối mở phiên (" + code + ")."
	}
	d := Denied{RequestID: req.RequestID, Code: code, Reason: text}
	c.send(func(l Sender) error { return l.Denied(d) })
}

// resolveRoot trả thư mục làm việc (đã giải symlink) và đường dẫn tương đối dạng `/` trong root. subdir ra ngoài root,
// kể cả qua symlink, là ROOT_ESCAPE; root hay thư mục con không còn là ROOT_MISSING.
func resolveRoot(root, subdir string) (cwd, rel, code string) {
	base, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", "", codeRootMissing
	}
	if st, err := os.Stat(base); err != nil || !st.IsDir() {
		return "", "", codeRootMissing
	}
	target := base
	if subdir != "" {
		// Điện thoại gửi `/`; trên Windows `\` cũng là dấu phân cách nên chuẩn hoá trước khi xét đi ngược ra ngoài.
		clean := filepath.Clean(filepath.FromSlash(subdir))
		if filepath.IsAbs(clean) || filepath.VolumeName(clean) != "" || strings.HasPrefix(clean, string(filepath.Separator)) ||
			outside(clean) {
			return "", "", codeRootEscape
		}
		if target, err = filepath.EvalSymlinks(filepath.Join(base, clean)); err != nil {
			return "", "", codeRootMissing
		}
	}
	inside, err := filepath.Rel(base, target)
	if err != nil || filepath.IsAbs(inside) || outside(inside) {
		return "", "", codeRootEscape
	}
	if st, err := os.Stat(target); err != nil || !st.IsDir() {
		return "", "", codeRootMissing
	}
	return target, filepath.ToSlash(inside), ""
}

func outside(rel string) bool {
	return rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// startPermissions: toàn quyền chỉ khi hub cho (chính sách tổ chức) và chủ máy bật tại máy; không thì hạ về workspace.
func startPermissions(want string, allowFull bool) string {
	switch want {
	case PermAsk:
		return PermAsk
	case PermFull:
		if allowFull {
			return PermFull
		}
	}
	return PermWorkspace
}

// batchShim: CLI cài bằng npm trên Windows là file .cmd, chạy qua cmd.exe nên ký tự như `&` trong đối số thành lệnh.
func batchShim(path string) bool {
	if runtime.GOOS != "windows" {
		return false
	}
	ext := strings.ToLower(filepath.Ext(path))
	return ext == ".cmd" || ext == ".bat"
}

// startArgs dựng đối số CLI cho phiên tương tác. Lời nhắc đi sau `--` để chữ bắt đầu bằng `-` không thành cờ; với file
// .cmd của Windows thì gõ lời nhắc vào PTY (typed) thay vì đưa qua cmd.exe.
func startArgs(cli, model, perm, prompt string, shim bool) (args []string, typed string) {
	switch cli {
	case "claude":
		if model != "" {
			args = append(args, "--model", model)
		}
		switch perm {
		case PermWorkspace:
			args = append(args, "--permission-mode", "acceptEdits")
		case PermFull:
			args = append(args, "--permission-mode", "bypassPermissions")
		}
	case "codex":
		if model != "" {
			args = append(args, "-m", model)
		}
		switch perm {
		case PermAsk:
			args = append(args, "-c", `approval_policy="untrusted"`)
		case PermWorkspace:
			args = append(args, "-s", "workspace-write", "-c", `approval_policy="on-request"`)
		case PermFull:
			args = append(args, "--dangerously-bypass-approvals-and-sandbox")
		}
	case "gemini":
		if model != "" {
			args = append(args, "-m", model)
		}
		switch perm {
		case PermWorkspace:
			args = append(args, "--approval-mode", "auto_edit")
		case PermFull:
			args = append(args, "--approval-mode", "yolo")
		}
	}
	if prompt == "" {
		return args, ""
	}
	if shim {
		return args, prompt
	}
	if cli == "gemini" {
		// Câu hỏi đầu của gemini tương tác đi bằng -i; dạng `--cờ=giá trị` giữ nguyên chữ bắt đầu bằng `-`.
		return append(args, "--prompt-interactive="+prompt), ""
	}
	return append(args, "--", prompt), ""
}
