package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/accounts"
	"github.com/tdduydev/xdev-hive/worker/internal/config"
	"github.com/tdduydev/xdev-hive/worker/internal/hubtls"
	"github.com/tdduydev/xdev-hive/worker/internal/optimizer"
	"github.com/tdduydev/xdev-hive/worker/internal/outbox"
	"github.com/tdduydev/xdev-hive/worker/internal/projects"
	"github.com/tdduydev/xdev-hive/worker/internal/score"
	"github.com/tdduydev/xdev-hive/worker/internal/tokenreport"
)

// scoreReportEvery là khoảng tối thiểu giữa hai lần gửi điểm (ADR 0036): điểm là số đọc mới nhất, gửi dày hơn không
// cho người quản trị thêm gì.
const scoreReportEvery = time.Hour

// optimizeHubHTTP cho test thay client gọi hub; mặc định dùng CA hub người dùng đã xác nhận như kênh WSS.
var optimizeHubHTTP = func() *http.Client { return hubtls.NewClient(10 * time.Second) }

// scoreReportView là kết quả `optimize report on|off|status --json` cho app desktop. Không in body báo cáo hay token.
type scoreReportView struct {
	Enabled    bool       `json:"enabled"`
	Registered bool       `json:"registered"`
	LastSentAt *time.Time `json:"lastSentAt"`
	Pending    bool       `json:"pending"`
}

func registeredHub(cfgPath string) (config.Config, bool) {
	cfg, err := config.Load(cfgPath)
	if err != nil || !cfg.Registered() {
		return cfg, false
	}
	return cfg, true
}

// optimizeScoreReport bật, tắt hoặc xem việc gửi điểm lên hub. Tắt thì bỏ luôn điểm đang chờ trong hộp thư đi, vì
// người dùng đã không muốn gửi nữa.
func optimizeScoreReport(dir, cfgPath, sub string, asJSON bool, stdout, stderr io.Writer) int {
	var (
		st  score.ReportState
		err error
	)
	cfg, registered := registeredHub(cfgPath)
	store, err := machineOutbox()
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	id := machineIdentity(cfg)
	switch sub {
	case "on", "off":
		st, err = score.UpdateReportState(dir, func(st *score.ReportState) error {
			st.Enabled = sub == "on"
			if !st.Enabled {
				st.Pending = nil
			}
			return nil
		})
		if err == nil && sub == "off" && cfg.MachineID != "" {
			_, err = store.DropKind(id, outbox.KindTokenScore)
		}
	default:
		st, err = score.LoadReportState(dir)
	}
	if err != nil {
		fmt.Fprintln(stderr, "không ghi được cài đặt gửi điểm:", err)
		return 1
	}
	view := scoreReportView{
		Enabled: st.Enabled, Registered: registered, LastSentAt: st.LastSentAt,
		Pending: st.Pending != nil || pendingKind(store, id, outbox.KindTokenScore),
	}
	if asJSON {
		return printJSON(stdout, stderr, view)
	}
	if view.Enabled {
		fmt.Fprintln(stdout, "Gửi điểm tối ưu token lên hub: bật (tối đa mỗi giờ một lần, chỉ gửi số điểm).")
	} else {
		fmt.Fprintln(stdout, "Gửi điểm tối ưu token lên hub: tắt.")
	}
	if !registered {
		fmt.Fprintln(stdout, "Máy chưa đăng ký với hub nên chưa gửi được.")
	}
	if view.LastSentAt != nil {
		fmt.Fprintf(stdout, "Lần hub nhận gần nhất: %s\n", view.LastSentAt.Local().Format("2006-01-02 15:04"))
	}
	return 0
}

// sendScoreReport xếp điểm vừa chấm vào hộp thư đi rồi gửi ngay khi người dùng đã bật và máy đã đăng ký. Hub vắng thì
// điểm nằm lại hộp thư đi, `hive-worker run` hay lần chấm sau gửi tiếp. Lỗi chỉ in một dòng ra stderr: gửi điểm là phần
// phụ, không được làm hỏng lệnh chấm điểm.
func sendScoreReport(dir, cfgPath string, res *score.Result, now time.Time, stderr io.Writer) {
	// Số liệu theo dự án có cờ riêng, không phụ thuộc cờ gửi điểm máy.
	defer sendProjectUsage(dir, cfgPath, res, now, stderr)
	st, err := score.LoadReportState(dir)
	if err != nil || !st.Enabled || (st.LastSentAt != nil && now.Sub(*st.LastSentAt) < scoreReportEvery) {
		return
	}
	cfg, ok := registeredHub(cfgPath)
	if !ok {
		return
	}
	payload, err := json.Marshal(score.BuildReport(res))
	if err != nil {
		fmt.Fprintln(stderr, "không dựng được báo cáo điểm để gửi hub:", err)
		return
	}
	store, err := machineOutbox()
	if err != nil {
		fmt.Fprintln(stderr, "không ghi được báo cáo điểm chờ gửi:", err)
		return
	}
	// Replace: hub chỉ cần số đọc mới nhất, điểm cũ chưa gửi được (hay bị từ chối) không còn nghĩa.
	it, err := store.Submit(machineIdentity(cfg), outbox.Submission{
		Kind: outbox.KindTokenScore, Key: newEventKey(now), CreatedAt: now, Payload: payload, Replace: true,
	})
	if err != nil {
		fmt.Fprintln(stderr, "không ghi được báo cáo điểm chờ gửi:", err)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	flushed, err := flushMachineOutbox(ctx, cfg)
	if err != nil {
		fmt.Fprintln(stderr, "chưa gửi được điểm tối ưu token lên hub, sẽ gửi lại sau:", err)
		return
	}
	for _, o := range flushed.Items {
		if o.Key != it.Key {
			continue
		}
		switch o.State {
		case outbox.StatePending:
			fmt.Fprintln(stderr, "chưa gửi được điểm tối ưu token lên hub, sẽ gửi lại sau:", o.Error)
		case outbox.StateRejected:
			fmt.Fprintf(stderr, "hub không nhận điểm tối ưu token: %s (%s)\n", o.Reason, o.Code)
		}
	}
}

// newEventKey tạo khoá chống trùng dạng ULID, như khoá của các client khác.
func newEventKey(now time.Time) string { return outbox.NewKey(now) }

var projectIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// projectPolicyDrift trả các mục chính sách của dự án mà máy đang lệch. Chính sách dự án do hub giữ (devOptimizer) và
// chưa có bản lưu trên máy, nên mặc định không báo lệch; ctxsync/optimizeall gắn nguồn khi có.
var projectPolicyDrift = func(projectID string) []string { return nil }

// projectUsageView là kết quả `optimizeProjectUsage` cho app desktop. Không in số liệu hay đường dẫn.
type projectUsageView struct {
	ProjectID  string     `json:"projectId"`
	Enabled    bool       `json:"enabled"`
	Registered bool       `json:"registered"`
	LastSentAt *time.Time `json:"lastSentAt"`
	Pending    bool       `json:"pending"`
}

func projectUsageStream(projectID string) string {
	return outbox.KindProjectTokenUsage + ":" + projectID
}

// optimizeProjectUsage bật, tắt hoặc xem việc gửi số liệu token của một dự án (spec 029 FR-050, mặc định tắt). Tắt thì
// bỏ luôn số liệu đang chờ trong hộp thư đi của dự án đó.
func optimizeProjectUsage(dir, cfgPath, projectID, sub string, asJSON bool, stdout, stderr io.Writer) int {
	if !projectIDPattern.MatchString(projectID) {
		fmt.Fprintln(stderr, "mã dự án không hợp lệ")
		return 1
	}
	projectID = strings.ToLower(projectID)
	cfg, registered := registeredHub(cfgPath)
	store, err := machineOutbox()
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	id := machineIdentity(cfg)
	if sub == "on" || sub == "off" {
		err = setProjectUsageFlag(dir, projectID, sub == "on")
		if err == nil && sub == "off" && cfg.MachineID != "" {
			err = dropProjectUsage(store, id, projectID)
		}
		if err != nil {
			fmt.Fprintln(stderr, "không ghi được cài đặt gửi số liệu dự án:", err)
			return 1
		}
	}
	st, err := tokenreport.LoadUsageState(dir)
	if err != nil {
		fmt.Fprintln(stderr, "không đọc được cài đặt gửi số liệu dự án:", err)
		return 1
	}
	f := st.Projects[projectID]
	view := projectUsageView{ProjectID: projectID, Enabled: f.Enabled, Registered: registered, LastSentAt: f.LastSentAt,
		Pending: registered && hasProjectUsage(store, id, projectID)}
	if asJSON {
		return printJSON(stdout, stderr, view)
	}
	if view.Enabled {
		fmt.Fprintln(stdout, "Gửi số token của dự án lên hub: bật (tối đa mỗi giờ một lần, chỉ gửi số).")
	} else {
		fmt.Fprintln(stdout, "Gửi số token của dự án lên hub: tắt.")
	}
	if !registered {
		fmt.Fprintln(stdout, "Máy chưa đăng ký với hub nên chưa gửi được.")
	}
	return 0
}

// updateProjectUsage đọc, sửa và ghi cờ trong khoá lịch sử điểm, để bật/tắt từ app và lần chấm điểm không ghi đè nhau.
func updateProjectUsage(dir string, change func(*tokenreport.UsageState)) error {
	unlock, err := score.LockHistory(dir)
	if err != nil {
		return err
	}
	defer unlock()
	st, err := tokenreport.LoadUsageState(dir)
	if err != nil {
		return err
	}
	change(&st)
	return tokenreport.SaveUsageState(dir, st)
}

func setProjectUsageFlag(dir, projectID string, on bool) error {
	return updateProjectUsage(dir, func(st *tokenreport.UsageState) {
		f := st.Projects[projectID]
		f.Enabled = on
		st.Projects[projectID] = f
	})
}

func hasProjectUsage(store outbox.Store, id outbox.Identity, projectID string) bool {
	items, err := store.List(id)
	if err != nil {
		return false
	}
	for _, it := range items {
		if it.Stream == projectUsageStream(projectID) && it.State != outbox.StateAccepted && it.State != outbox.StateDuplicate {
			return true
		}
	}
	return false
}

// dropProjectUsage bỏ số liệu của dự án chưa gửi tới hub. Mục đang `sending` giữ lại: có thể đã tới hub.
func dropProjectUsage(store outbox.Store, id outbox.Identity, projectID string) error {
	items, err := store.List(id)
	if err != nil {
		return err
	}
	for _, it := range items {
		if it.Stream == projectUsageStream(projectID) && it.State != outbox.StateSending {
			if err := store.Drop(id, it.Key); err != nil {
				return err
			}
		}
	}
	return nil
}

// projectSessions đọc phiên 7 ngày của mọi gói CLI trên máy, kể cả gói có thư mục cấu hình ngoài ~/.xdev-hive/accounts.
func projectSessions(cfgPath string) ([]tokenreport.SessionSummary, error) {
	home, err := optimizeHome()
	if err != nil {
		return nil, err
	}
	o := optimizer.New(home)
	view, err := optimizeStatus(o, accounts.DefaultPath(cfgPath))
	if err != nil {
		return nil, err
	}
	var roots []tokenreport.Root
	for _, p := range scoreProfiles(o, view) {
		if p.CLI == "claude" || p.CLI == "codex" {
			roots = append(roots, tokenreport.Root{Account: p.ID, CLI: p.CLI, Dir: p.Dir})
		}
	}
	if len(roots) == 0 {
		return nil, nil
	}
	return tokenreport.Sessions(context.Background(), tokenreport.Options{
		Home: home, Days: tokenreport.UsageWindowDays, Now: optimizeNow, Roots: roots, NoRTK: true,
	})
}

// sendProjectUsage xếp số liệu 7 ngày của từng dự án đã bật vào hộp thư đi rồi gửi. Không dự án nào bật thì không đọc
// transcript và không gửi gì. Lỗi chỉ in một dòng ra stderr: gửi số liệu là phần phụ của lệnh chấm điểm.
func sendProjectUsage(dir, cfgPath string, res *score.Result, now time.Time, stderr io.Writer) {
	st, err := tokenreport.LoadUsageState(dir)
	if err != nil {
		return
	}
	enabled := map[string]bool{}
	for id, f := range st.Projects {
		if f.Enabled && (f.LastSentAt == nil || now.Sub(*f.LastSentAt) >= scoreReportEvery) {
			enabled[id] = true
		}
	}
	if len(enabled) == 0 {
		return
	}
	cfg, ok := registeredHub(cfgPath)
	if !ok {
		return
	}
	list, err := projects.Load(projects.DefaultPath(cfgPath))
	if err != nil {
		fmt.Fprintln(stderr, "không đọc được danh sách dự án để gửi số liệu:", err)
		return
	}
	folders := make([]tokenreport.ProjectFolder, 0, len(list))
	for _, p := range list {
		folders = append(folders, tokenreport.ProjectFolder{ProjectID: strings.ToLower(p.ProjectID), Folder: p.Folder})
	}
	sessions, err := projectSessions(cfgPath)
	if err != nil {
		fmt.Fprintln(stderr, "không đọc được phiên để gửi số liệu dự án:", err)
		return
	}
	drift := map[string][]string{}
	for id := range enabled {
		drift[id] = projectPolicyDrift(id)
	}
	var machineScore *float64
	if res != nil {
		machineScore = res.Machine.Score
	}
	payloads := tokenreport.BuildProjectUsage(tokenreport.UsageInput{
		Sessions: sessions, Folders: folders, Enabled: enabled, Now: now, Score: machineScore, Drift: drift,
	})
	if len(payloads) == 0 {
		return
	}
	store, err := machineOutbox()
	if err != nil {
		fmt.Fprintln(stderr, "không ghi được số liệu dự án chờ gửi:", err)
		return
	}
	id := machineIdentity(cfg)
	keys := map[string]string{}
	for _, p := range payloads {
		body, err := json.Marshal(p)
		if err != nil {
			fmt.Fprintln(stderr, "không dựng được số liệu dự án để gửi hub:", err)
			return
		}
		// Số liệu cũ chưa gửi được không còn nghĩa khi đã có số mới hơn của cùng dự án.
		if err := dropProjectUsage(store, id, p.ProjectID); err != nil {
			fmt.Fprintln(stderr, "không ghi được số liệu dự án chờ gửi:", err)
			return
		}
		it, err := store.Submit(id, outbox.Submission{
			Kind: outbox.KindProjectTokenUsage, Stream: projectUsageStream(p.ProjectID), Key: newEventKey(now), CreatedAt: now, Payload: body,
		})
		if err != nil {
			fmt.Fprintln(stderr, "không ghi được số liệu dự án chờ gửi:", err)
			return
		}
		keys[it.Key] = p.ProjectID
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	flushed, err := flushMachineOutbox(ctx, cfg)
	if err != nil {
		fmt.Fprintln(stderr, "chưa gửi được số liệu dự án lên hub, sẽ gửi lại sau:", err)
		return
	}
	var sent []string
	for _, o := range flushed.Items {
		pid, ok := keys[o.Key]
		if !ok {
			continue
		}
		switch o.State {
		case outbox.StateAccepted, outbox.StateDuplicate:
			sent = append(sent, pid)
		case outbox.StatePending:
			fmt.Fprintln(stderr, "chưa gửi được số liệu dự án lên hub, sẽ gửi lại sau:", o.Error)
		case outbox.StateRejected:
			fmt.Fprintf(stderr, "hub không nhận số liệu dự án: %s (%s)\n", o.Reason, o.Code)
		}
	}
	if len(sent) == 0 {
		return
	}
	_ = updateProjectUsage(dir, func(cur *tokenreport.UsageState) {
		for _, pid := range sent {
			f := cur.Projects[pid]
			t := now
			f.LastSentAt = &t
			cur.Projects[pid] = f
		}
	})
}
