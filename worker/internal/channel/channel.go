package channel

import (
	"bufio"
	"context"
	cryptorand "crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/tdduydev/xdev-hive/worker/internal/accounts"
	"github.com/tdduydev/xdev-hive/worker/internal/hubclient"
	"github.com/tdduydev/xdev-hive/worker/internal/hubtls"
	"github.com/tdduydev/xdev-hive/worker/internal/projects"
	"github.com/tdduydev/xdev-hive/worker/internal/runner"
	"github.com/tdduydev/xdev-hive/worker/internal/terminal"
)

const protocolVersion = 1

func hostMemoryMB() uint64 {
	file, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) >= 2 && fields[0] == "MemTotal:" {
			kb, err := strconv.ParseUint(fields[1], 10, 64)
			if err == nil {
				return kb / 1024
			}
		}
	}
	return 0
}

type Config struct {
	HubURL  string
	Machine string
	// Token là machine token nhận khi đăng ký, gửi trong header Authorization lúc mở WSS. Chỉ dùng khi không có
	// AccessToken (máy chưa có khoá, hub cũ).
	Token string
	// AccessToken lấy access token của khoá máy (hubclient.TokenSource.Token); fresh là đòi token mới thay vì token đang
	// giữ. Lỗi hubclient.IsAuthFailed là hub đã từ chối khoá.
	AccessToken func(ctx context.Context, fresh bool) (string, time.Time, error)
	// RefreshBefore ghi đè lúc đổi token trước hạn; 0 là hubclient.RefreshBefore. Chỉ dùng trong test.
	RefreshBefore time.Duration
	Version       string
	CLIs          []string
	Capacity      int
	RunnerMode    string
	Sandbox       *runner.SandboxConfig
	Logger        *slog.Logger
	HTTP          *http.Client
	MinBackoff    time.Duration
	MaxBackoff    time.Duration
	// Heartbeat ghi đè chu kỳ heartbeat hub gửi trong welcome; 0 là theo hub. Chỉ dùng trong test.
	Heartbeat time.Duration
	// DataDir chứa repo cache, worktree của run, gói chờ ack (pending) và marker run đang chạy (active).
	DataDir string
	// Project là project key mặc định cho HIVE_PROJECT khi spec của job không có.
	Project     string
	CLICommands map[string]runner.Command
	// Accounts chọn tài khoản CLI cho từng run (accounts.json, spec 008 US13); nil là đăng nhập mặc định của CLI.
	Accounts *accounts.Pool
	// Projects là projects.json: dự án đã gắn repo trên máy và công tắc toàn quyền (ADR 0020). Rỗng (runner host) là
	// không có dự án nào gắn.
	Projects string
	// StopTimeout là thời gian chờ run đang chạy dừng hẳn khi worker tắt; 0 là 30 giây.
	StopTimeout time.Duration
	// OnStatus nhận trạng thái kết nối, để app desktop hiện trên khay hệ thống (hive-worker run --status-json).
	OnStatus func(Status)
	// SelfUpdate: nhận lệnh `update` của hub. Tắt với worker đi kèm app desktop, vì app tự cập nhật cả gói.
	SelfUpdate bool
	// Terminal điều khiển phiên terminal trên máy cá nhân theo gói term_* của hub (specs/010). nil là máy chưa hỗ trợ:
	// gói đó bị bỏ qua, kênh vẫn chạy.
	Terminal terminal.Handler
}

// Status là trạng thái kết nối tới hub. Error chỉ có khi State là "disconnected" hoặc "stopped" vì lỗi.
type Status struct {
	State string `json:"status"`
	Error string `json:"error,omitempty"`
}

func (c Config) status(state string, err error) {
	if c.OnStatus == nil {
		return
	}
	s := Status{State: state}
	if err != nil {
		s.Error = err.Error()
	}
	c.OnStatus(s)
}

type jobSpec struct {
	Execution      string                   `json:"execution"`
	Sandbox        *runner.SandboxJobConfig `json:"sandbox"`
	Kind           string                   `json:"kind"`
	Budget         runner.Budget            `json:"budget"`
	RunPermissions string                   `json:"runPermissions"`
	// FullAllowed: chính sách tổ chức cho toàn quyền; nil với hub cũ.
	FullAllowed *bool              `json:"fullAllowed"`
	ProjectID   string             `json:"projectId"`
	Repo        string             `json:"repo"`
	RepoURL     string             `json:"repoUrl"`
	Project     string             `json:"project"`
	ProjectKey  string             `json:"projectKey"`
	CLI         string             `json:"cli"`
	Model       string             `json:"model"`
	Prompt      string             `json:"prompt"`
	BaseBranch  string             `json:"baseBranch"`
	Branch      string             `json:"branch"`
	TimeoutSec  int                `json:"timeoutSec"`
	SetupScript string             `json:"setupScript"`
	Image       string             `json:"image"`
	SetupEnv    map[string]string  `json:"setupEnv"`
	MCPServers  []runner.MCPServer `json:"mcpServers"`
	Policy      runner.JobPolicy   `json:"policy"`
	// TokenSaving là cài đặt "Tiết kiệm token" của dự án; nil với hub cũ.
	TokenSaving *runner.TokenSavingJob `json:"tokenSaving"`
	// Effort, Advisor, Tier: lựa chọn của định tuyến theo cấp độ task; rỗng với hub cũ hay dự án tắt định tuyến.
	Effort  string `json:"effort"`
	Advisor string `json:"advisor"`
	Tier    string `json:"tier"`
	Checks  *struct {
		Commands []runner.CheckCommand `json:"commands"`
	} `json:"checks"`
	Brief *struct {
		SHA string `json:"sha"`
	} `json:"brief"`
	// SDLC là spec.sdlc của run sdlc (file ghi trước, file thu về sau); nil với kind khác và hub cũ.
	SDLC *runner.SdlcJob `json:"sdlc"`
	// TaskText là tiêu đề, mô tả và kế hoạch đã duyệt của task, nguồn từ khoá của context pack; rỗng với hub cũ.
	TaskText string `json:"taskText"`
}

// normalizeRepoURL: hub cũ gửi "owner/repo" của GitHub thay cho URL.
func normalizeRepoURL(repo string) string {
	if repo != "" && !strings.Contains(repo, "://") && !strings.HasPrefix(repo, "git@") {
		return "https://github.com/" + strings.Trim(repo, "/") + ".git"
	}
	return repo
}

func decodeJob(o *JobOffer, l Lease, hub, project string) (runner.Job, error) {
	var s jobSpec
	if err := json.Unmarshal(o.Spec, &s); err != nil {
		return runner.Job{}, err
	}
	if err := s.validateExecution(); err != nil {
		return runner.Job{}, err
	}
	repo := s.RepoURL
	if repo == "" {
		repo = s.Repo
	}
	repo = normalizeRepoURL(repo)
	switch {
	case s.ProjectKey != "":
		project = s.ProjectKey
	case s.Project != "":
		project = s.Project
	}
	// Template .mcp.json của dự án đọc HIVE_MCP_TOKEN; hub và tài liệu gọi là HIVE_RUN_TOKEN. Đặt cả hai.
	env := map[string]string{"HIVE_RUN_TOKEN": l.RunToken, "HIVE_MCP_TOKEN": l.RunToken, "HIVE_HUB_URL": hub, "HIVE_PROJECT": project}
	j := runner.Job{Execution: s.Execution, SandboxPolicy: s.Sandbox, RunID: o.RunID, Kind: s.Kind, Budget: s.Budget, Attempt: o.Attempt, RepoURL: repo, BaseBranch: s.BaseBranch, Branch: s.Branch, CLI: s.CLI, Model: s.Model, RunPermissions: s.RunPermissions, Prompt: s.Prompt, Timeout: time.Duration(s.TimeoutSec) * time.Second, SetupScript: s.SetupScript, EnvironmentImage: s.Image, Env: env, SetupEnv: s.SetupEnv, Policy: s.Policy, ProjectID: strings.ToLower(s.ProjectID)}
	j.MCPServers = s.MCPServers
	j.TokenSaving = s.TokenSaving
	j.Effort, j.Advisor, j.Tier = s.Effort, s.Advisor, s.Tier
	j.TaskText = s.TaskText
	if s.Checks != nil {
		j.Checks = s.Checks.Commands
	}
	if s.Brief != nil {
		j.BriefSHA = s.Brief.SHA
	}
	j.SDLC = s.SDLC
	if s.Sandbox != nil {
		j.EnvironmentImage = s.Sandbox.Image.BaseImage
	}
	if j.BaseBranch == "" {
		j.BaseBranch = "main"
	}
	if j.Branch == "" {
		j.Branch = "ai/" + o.RunID
	}
	return j, nil
}

// fullAllowed: hub cũ không gửi fullAllowed, nhưng nó chỉ gửi runPermissions full khi chính sách tổ chức cho phép.
func (s jobSpec) fullAllowed() bool {
	if s.FullAllowed != nil {
		return *s.FullAllowed
	}
	return s.RunPermissions == "full"
}

// localProject áp mục projects.json của dự án cho job (ADR 0020): run tạo worktree từ repo đã gắn, và quyền CLI theo
// công tắc của máy thay cho quyền hub gửi. Job sandbox (runner host) giữ nguyên.
func localProject(job runner.Job, s jobSpec, list []projects.Project) runner.Job {
	if job.Execution == "sandbox" || job.SandboxPolicy != nil {
		return job
	}
	p := projects.Find(list, job.ProjectID)
	if p != nil {
		job.LocalRepo = p.Folder
		job.LocalID = p.LocalID
	}
	job.RunPermissions = projects.Effective(p, job.RunPermissions, s.fullAllowed())
	return job
}

func (s jobSpec) validateExecution() error {
	if s.Execution != "" && s.Execution != "worker" && s.Execution != "sandbox" {
		return fmt.Errorf("loại thực thi job không hợp lệ")
	}
	if (s.Execution == "sandbox") != (s.Sandbox != nil) {
		return fmt.Errorf("job sandbox phải có snapshot allowlist và image")
	}
	if s.Sandbox != nil {
		return s.Sandbox.Validate()
	}
	return nil
}

type UpgradeError struct{ Message UpgradeRequired }

// UpdateRequest: hub yêu cầu cập nhật và worker đã chờ run đang chạy xong. Run trả lỗi này để lệnh gọi tự cập nhật rồi
// khởi động lại. Version rỗng là bản mới nhất.
type UpdateRequest struct{ Version string }

func (e *UpdateRequest) Error() string {
	if e.Version == "" {
		return "hub yêu cầu cập nhật worker lên bản mới nhất"
	}
	return "hub yêu cầu cập nhật worker lên bản " + e.Version
}

func (e *UpgradeError) Error() string {
	return fmt.Sprintf("hub yêu cầu nâng cấp worker: %s", e.Message.URL)
}

// RejectedError là khi hub từ chối máy theo cách nối lại cũng không khỏi (token sai, máy bị thu hồi, giao thức lệch).
// Run dừng thay vì thử lại mãi.
type RejectedError struct {
	Code   int
	Reason string
}

func (e *RejectedError) Error() string {
	return fmt.Sprintf("hub từ chối máy (mã %d): %s", e.Code, e.Reason)
}

// Mã đóng kết nối hub dùng khi nối lại vô ích (apps/hub/src/modules/fleet/gateway.ts).
var fatalCloseCodes = map[websocket.StatusCode]bool{4401: true, 4403: true, 4426: true}

func (c Config) Run(ctx context.Context) error {
	if c.Machine == "" {
		return errors.New("machine ID không được để trống")
	}
	if c.Logger == nil {
		c.Logger = slog.Default()
	}
	if c.DataDir == "" {
		d, err := os.UserCacheDir()
		if err != nil {
			return err
		}
		c.DataDir = filepath.Join(d, "xdev-hive", "worker")
	}
	if err := os.MkdirAll(filepath.Join(c.DataDir, "pending"), 0700); err != nil {
		return err
	}
	if err := recoverInterrupted(c.DataDir, c.Logger); err != nil {
		return fmt.Errorf("khôi phục run bị ngắt: %w", err)
	}
	// Vừa khởi động thì không còn CLI nào chạy: mọi worktree còn lại là của run đã chết.
	if err := runner.ReapOrphans(c.DataDir, nil); err != nil {
		return fmt.Errorf("dọn run cũ: %w", err)
	}
	if c.Sandbox != nil {
		if err := runner.ReapSandboxOrphans(ctx, *c.Sandbox); err != nil {
			return fmt.Errorf("dọn container cũ: %w", err)
		}
	}
	// Phiên terminal Leader không sống qua lần khởi động: worktree còn trong terminals/ là rác.
	if err := runner.ReapTerminals(c.DataDir); err != nil {
		c.Logger.Warn("Không dọn được worktree của phiên terminal cũ", "error", err)
	}
	// Phiên đăng nhập gói từ web không sống qua lần khởi động: tài khoản dở còn lại là rác của lần worker chết giữa chừng.
	if c.Accounts != nil {
		if n, err := accounts.CleanupPending(c.Accounts.Path(), c.Accounts.Home()); err != nil {
			c.Logger.Warn("Không dọn được tài khoản đăng nhập dở", "error", err)
		} else if n > 0 {
			c.Logger.Info("Đã dọn tài khoản đăng nhập dở từ lần chạy trước", "count", n)
		}
	}
	if c.MinBackoff <= 0 {
		c.MinBackoff = time.Second
	}
	if c.MaxBackoff <= 0 {
		c.MaxBackoff = 30 * time.Second
	}
	if c.MaxBackoff < c.MinBackoff {
		c.MaxBackoff = c.MinBackoff
	}
	if c.StopTimeout <= 0 {
		c.StopTimeout = 30 * time.Second
	}
	jobs := newJobs(ctx, c)
	// Worker tắt (Ctrl-C, dịch vụ dừng): run nhận lệnh huỷ theo ctx, chờ chúng ghi kết quả xuống đĩa rồi mới thoát.
	defer jobs.wait(c.StopTimeout)
	backoff := c.MinBackoff
	for {
		if ctx.Err() != nil {
			return nil
		}
		if jobs.finished() {
			return jobs.exitReason()
		}
		c.status("connecting", nil)
		err := c.connect(ctx, jobs)
		var upgrade *UpgradeError
		var rejected *RejectedError
		if errors.As(err, &rejected) && c.expired(ctx, rejected) {
			// Access token hết hạn giữa chừng (máy ngủ quá giờ reauth) chứ máy không bị thu hồi: token mới đã có, nối lại.
			err = fmt.Errorf("access token hết hạn: %s", rejected.Reason)
			rejected = nil
		}
		if errors.As(err, &upgrade) || rejected != nil {
			c.status("stopped", err)
			return err
		}
		if ctx.Err() != nil {
			c.status("stopped", nil)
			return nil
		}
		if jobs.finished() {
			c.status("stopped", nil)
			return jobs.exitReason()
		}
		c.status("disconnected", err)
		c.Logger.Warn("Kênh worker mất kết nối, sẽ thử lại", "error", err)
		delay := time.Duration(rand.Int64N(int64(backoff) + 1))
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil
		case <-jobs.done:
			timer.Stop()
			return jobs.exitReason()
		case <-timer.C:
		}
		backoff *= 2
		if backoff > c.MaxBackoff {
			backoff = c.MaxBackoff
		}
	}
}

func (c Config) healthHTTP() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return hubtls.NewClient(10 * time.Second)
}

func (c Config) connect(ctx context.Context, jobs *jobs) error {
	url, err := websocketURL(c.HubURL)
	if err != nil {
		return err
	}
	header := http.Header{}
	token := c.Token
	if c.AccessToken != nil {
		if token, _, err = c.AccessToken(ctx, false); err != nil {
			if hubclient.IsAuthFailed(err) {
				return &RejectedError{Code: http.StatusUnauthorized, Reason: "hub không nhận khoá của máy (máy đã bị thu hồi hay khoá đã đổi); chạy lại `hive-worker register`"}
			}
			return fmt.Errorf("xin access token: %w", err)
		}
	}
	if token != "" {
		header.Set("Authorization", "Bearer "+token)
	}
	conn, resp, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPClient: c.healthHTTP(), HTTPHeader: header})
	if err != nil {
		if resp != nil && resp.StatusCode == http.StatusUnauthorized {
			return &RejectedError{Code: resp.StatusCode, Reason: "token máy không hợp lệ hoặc máy đã bị thu hồi; chạy lại `hive-worker register`"}
		}
		return fmt.Errorf("kết nối WSS tới hub: %w", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "worker ngắt kết nối")
	id, err := messageID()
	if err != nil {
		return err
	}
	// Hub cũ từ chối cả hello khi có CLI nó chưa biết; hỏi lại mỗi lần nối vì hub có thể vừa được cập nhật.
	clis, dropped := hubclient.NewWithHTTP(c.HubURL, c.healthHTTP()).SupportedCLIs(ctx, c.CLIs)
	if len(dropped) > 0 {
		c.Logger.Warn("Hub chưa nhận các CLI này; cập nhật hub để giao run cho chúng", "clis", dropped)
	}
	// Hub đòi mảng, không nhận null; slice nil của Go mã hoá thành null.
	hello := Hello{Type: "hello", V: protocolVersion, ID: id, MachineID: c.Machine, Version: c.Version, ProtoRange: [2]int{protocolVersion, protocolVersion}, OS: runtime.GOOS, CLIs: clis, Capacity: c.Capacity, Capabilities: c.helloCapabilities(), ResumeRuns: jobs.runIDs(), RunnerMode: c.RunnerMode, CPUCount: runtime.NumCPU()}
	if memory := hostMemoryMB(); memory > 0 {
		hello.MemoryMB = memory
	}
	hello.LocalProjects = jobs.localProjects()
	if err := conn.Write(ctx, websocket.MessageText, mustJSON(hello)); err != nil {
		return fmt.Errorf("gửi hello: %w", err)
	}
	_, payload, err := conn.Read(ctx)
	if err != nil {
		return closeError("chờ phản hồi hub", err)
	}
	var envelope struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return fmt.Errorf("đọc phản hồi hub: %w", err)
	}
	switch envelope.Type {
	case "welcome":
		var welcome Welcome
		if err := json.Unmarshal(payload, &welcome); err != nil {
			return err
		}
		c.Logger.Info("Đã kết nối hub", "sessionId", welcome.SessionID, "heartbeatSec", welcome.HeartbeatSec)
		c.status("online", nil)
		return c.session(ctx, conn, welcome, jobs)
	case "upgrade_required":
		var upgrade UpgradeRequired
		if err := json.Unmarshal(payload, &upgrade); err != nil {
			return err
		}
		return &UpgradeError{Message: upgrade}
	default:
		return fmt.Errorf("hub gửi gói không hỗ trợ %q", envelope.Type)
	}
}

func (c Config) session(ctx context.Context, conn *websocket.Conn, welcome Welcome, jobs *jobs) error {
	interval := c.Heartbeat
	if interval <= 0 {
		interval = time.Duration(welcome.HeartbeatSec) * time.Second
	}
	if interval <= 0 {
		interval = 30 * time.Second
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		// Drain xong thì đóng phiên để Run thoát.
		select {
		case <-jobs.done:
			cancel()
		case <-ctx.Done():
		}
	}()
	jobs.setShared(welcome)
	if err := jobs.attach(ctx, conn); err != nil {
		return err
	}
	defer jobs.detach(conn)
	link := newTermLink(ctx, jobs, welcome)
	if c.Terminal != nil {
		// Sau attach để Handler gửi được term_state ngay; hết phiên (defer chạy trước detach) thì báo để nó bỏ người xem.
		c.Terminal.OnWelcome(welcomeInfo(welcome), link)
		defer c.Terminal.OnDisconnect()
	}
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
			// Lỗi ghi sẽ hiện ra ở conn.Read bên dưới, nên không cần báo riêng.
			if jobs.write(jobs.heartbeat()) != nil {
				return
			}
		}
	}()
	// Hub chỉ nhận reauth khi kết nối mở bằng access token, và khi đó welcome có accessTokenExp.
	if exp, err := time.Parse(time.RFC3339Nano, welcome.AccessTokenExp); err == nil && c.AccessToken != nil {
		go c.reauth(ctx, jobs, exp)
	}
	for {
		_, payload, err := conn.Read(ctx)
		if err != nil {
			return closeError("hub đã đóng kênh", err)
		}
		msg, err := Decode(payload)
		if err != nil {
			c.Logger.Warn("Bỏ qua gói không đọc được từ hub", "error", err)
			continue
		}
		if jobs.routeRemote(link, msg) {
			continue
		}
		switch m := msg.(type) {
		case *HeartbeatAck:
			c.Logger.Debug("Hub xác nhận heartbeat", "renewed", m.Renewed, "cancel", m.Cancel)
			// Lease không còn (hết hạn, run đã giao máy khác, đang huỷ): dừng run, kết quả của nó hub sẽ bỏ.
			for _, runID := range m.Cancel {
				jobs.cancel(runID, defaultGrace)
			}
		case *JobOffer:
			jobs.onOffer(m)
		case *Lease:
			jobs.onLease(m)
		case *Ack:
			ackPending(jobs.pending, m.RunID, m.UptoSeq)
		case *Cancel:
			jobs.cancel(m.RunID, time.Duration(m.GraceSec)*time.Second)
		case *Drain:
			c.Logger.Info("Hub yêu cầu thoát: không nhận job mới, chờ run đang chạy xong")
			jobs.drain()
		case *Update:
			if c.SelfUpdate {
				c.Logger.Info("Hub yêu cầu cập nhật: không nhận job mới, chờ run đang chạy xong rồi cập nhật", "version", m.Version)
				jobs.requestUpdate(m.Version)
			} else {
				c.Logger.Info("Bỏ lệnh cập nhật của hub: worker đi kèm app desktop, cập nhật bằng app")
			}
		case *Steer:
			jobs.steer(m)
		case *AccountSet:
			jobs.onAccountSet(m)
		case *AccountLoginStart:
			jobs.onLoginStart(m)
		case *AccountLoginInput:
			jobs.onLoginInput(m)
		case *AccountLoginCancel:
			jobs.onLoginCancel(m)
		case *TermOpen:
			jobs.onTermOpen(m)
		case *TermInput:
			jobs.onTermInput(m)
		case *TermResize:
			jobs.onTermResize(m)
		case *TermClose:
			jobs.onTermClose(m)
		default:
			c.Logger.Info("Chưa xử lý gói từ hub", "type", fmt.Sprintf("%T", m))
		}
	}
}

// reauth đổi access token trước hạn và gửi cho hub trên kết nối đang mở, để run đang chạy không bị ngắt mỗi 15 phút.
// Đổi không được thì thử lại sau 30 giây; tới hạn mà vẫn hỏng thì hub đóng 4401 và Run nối lại bằng token mới.
func (c Config) reauth(ctx context.Context, jobs *jobs, exp time.Time) {
	before := c.RefreshBefore
	if before <= 0 {
		before = hubclient.RefreshBefore
	}
	wait := time.Until(exp) - before
	for {
		timer := time.NewTimer(max(wait, 0))
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		token, next, err := c.AccessToken(ctx, true)
		if err != nil {
			c.Logger.Warn("Không đổi được access token, sẽ thử lại", "error", err)
			wait = 30 * time.Second
			continue
		}
		id, err := messageID()
		if err != nil {
			return
		}
		if jobs.write(Reauth{Type: "reauth", V: protocolVersion, ID: id, AccessToken: token}) != nil {
			return
		}
		wait = time.Until(next) - before
	}
}

// expired cho biết hub đóng vì access token hết hạn chứ không phải vì máy bị thu hồi: đổi được token mới thì máy còn
// hợp lệ. Hub vắng lúc đổi thì cũng nối lại, vì dừng hẳn worker chỉ vì mạng chập là quá tay.
func (c Config) expired(ctx context.Context, r *RejectedError) bool {
	if c.AccessToken == nil || (r.Code != 4401 && r.Code != http.StatusUnauthorized) {
		return false
	}
	_, _, err := c.AccessToken(ctx, true)
	return err == nil || !hubclient.IsAuthFailed(err)
}

// closeError đổi lỗi đọc thành RejectedError khi hub đóng bằng mã cho biết nối lại vô ích.
func closeError(what string, err error) error {
	var ce websocket.CloseError
	if errors.As(err, &ce) && fatalCloseCodes[ce.Code] {
		return &RejectedError{Code: int(ce.Code), Reason: ce.Reason}
	}
	return fmt.Errorf("%s: %w", what, err)
}

func websocketURL(base string) (string, error) {
	base = strings.TrimRight(base, "/")
	switch {
	case strings.HasPrefix(base, "https://"):
		base = "wss://" + strings.TrimPrefix(base, "https://")
	case strings.HasPrefix(base, "http://"):
		base = "ws://" + strings.TrimPrefix(base, "http://")
	case strings.HasPrefix(base, "ws://"), strings.HasPrefix(base, "wss://"):
	default:
		return "", fmt.Errorf("địa chỉ hub không hợp lệ: %s", base)
	}
	return base + "/ws/worker", nil
}

func messageID() (string, error) {
	var b [16]byte
	if _, err := cryptorand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

func mustJSON(v any) []byte { b, _ := json.Marshal(v); return b }
