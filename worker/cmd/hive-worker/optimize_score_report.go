package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/config"
	"github.com/tdduydev/xdev-hive/worker/internal/hubtls"
	"github.com/tdduydev/xdev-hive/worker/internal/outbox"
	"github.com/tdduydev/xdev-hive/worker/internal/score"
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
	if err != nil || cfg.HubURL == "" || cfg.MachineToken == "" {
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
