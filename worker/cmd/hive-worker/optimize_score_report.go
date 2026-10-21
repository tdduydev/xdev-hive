package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/config"
	"github.com/tdduydev/xdev-hive/worker/internal/hubclient"
	"github.com/tdduydev/xdev-hive/worker/internal/hubtls"
	"github.com/tdduydev/xdev-hive/worker/internal/score"
)

// scoreReportEvery là khoảng tối thiểu giữa hai lần gửi điểm (ADR 0036): điểm là số đọc mới nhất, gửi dày hơn không
// cho người quản trị thêm gì.
const scoreReportEvery = time.Hour

const scoreReportKind = "machine.token_score"

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

// optimizeScoreReport bật, tắt hoặc xem việc gửi điểm lên hub. Tắt thì bỏ luôn báo cáo đang chờ, vì người dùng đã
// không muốn gửi nữa.
func optimizeScoreReport(dir, cfgPath, sub string, asJSON bool, stdout, stderr io.Writer) int {
	var (
		st  score.ReportState
		err error
	)
	switch sub {
	case "on", "off":
		st, err = score.UpdateReportState(dir, func(st *score.ReportState) error {
			st.Enabled = sub == "on"
			if !st.Enabled {
				st.Pending = nil
			}
			return nil
		})
	default:
		st, err = score.LoadReportState(dir)
	}
	if err != nil {
		fmt.Fprintln(stderr, "không ghi được cài đặt gửi điểm:", err)
		return 1
	}
	_, registered := registeredHub(cfgPath)
	view := scoreReportView{Enabled: st.Enabled, Registered: registered, LastSentAt: st.LastSentAt, Pending: st.Pending != nil}
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

// errReportSkip dừng UpdateReportState mà không ghi file: chưa bật hoặc chưa đủ một giờ.
var errReportSkip = errors.New("bỏ qua gửi điểm")

// sendScoreReport gửi điểm vừa chấm lên hub khi người dùng đã bật và máy đã đăng ký. Lỗi chỉ in một dòng ra stderr:
// gửi điểm là phần phụ, không được làm hỏng lệnh chấm điểm.
func sendScoreReport(dir, cfgPath string, res *score.Result, now time.Time, stderr io.Writer) {
	if st, err := score.LoadReportState(dir); err != nil || !st.Enabled {
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
	ev := hubclient.ClientEvent{Key: newEventKey(now), Kind: scoreReportKind, CreatedAt: now.UTC().Format(time.RFC3339), Payload: payload}
	body, err := json.Marshal(ev)
	if err != nil {
		fmt.Fprintln(stderr, "không dựng được báo cáo điểm để gửi hub:", err)
		return
	}
	// Ghi báo cáo chờ trước khi gửi: tiến trình chết giữa chừng thì lần sau vẫn biết còn báo cáo chưa tới hub. Bản mới
	// thay bản cũ chưa gửi vì hub chỉ cần số đọc mới nhất.
	_, err = score.UpdateReportState(dir, func(st *score.ReportState) error {
		if !st.Enabled || (st.LastSentAt != nil && now.Sub(*st.LastSentAt) < scoreReportEvery) {
			return errReportSkip
		}
		st.Pending = &score.PendingReport{Key: ev.Key, Body: body}
		return nil
	})
	if errors.Is(err, errReportSkip) {
		return
	}
	if err != nil {
		fmt.Fprintln(stderr, "không ghi được báo cáo điểm chờ gửi:", err)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	result, err := hubclient.PostClientEvent(ctx, optimizeHubHTTP(), cfg.HubURL, cfg.MachineToken, ev)
	var statusErr *hubclient.StatusError
	retry := err != nil && (!errors.As(err, &statusErr) || statusErr.Retryable())
	if retry {
		fmt.Fprintln(stderr, "chưa gửi được điểm tối ưu token lên hub, sẽ gửi lại lần chấm sau:", err)
		return
	}
	sent := err == nil && (result.Outcome == hubclient.OutcomeAccepted || result.Outcome == hubclient.OutcomeDuplicate)
	switch {
	case err != nil:
		fmt.Fprintln(stderr, "hub không nhận điểm tối ưu token:", err)
	case !sent:
		fmt.Fprintf(stderr, "hub không nhận điểm tối ưu token: %s (%s)\n", result.Reason, result.Code)
	}
	// Hub đã trả lời dứt khoát (nhận, trùng hay từ chối): gửi lại cùng body cũng không khác, nên bỏ báo cáo chờ.
	_, err = score.UpdateReportState(dir, func(st *score.ReportState) error {
		if st.Pending != nil && st.Pending.Key == ev.Key {
			st.Pending = nil
		}
		if sent {
			t := now.UTC()
			st.LastSentAt = &t
		}
		return nil
	})
	if err != nil {
		fmt.Fprintln(stderr, "không ghi được trạng thái gửi điểm:", err)
	}
}

// newEventKey tạo khoá chống trùng dạng ULID (26 ký tự Crockford base32): 48 bit thời gian mili giây rồi 80 bit
// ngẫu nhiên, nên khoá xếp theo thời gian như khoá ULID của các client khác.
func newEventKey(now time.Time) string {
	const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
	var b [16]byte
	ms := uint64(now.UnixMilli())
	for i := 5; i >= 0; i-- {
		b[i] = byte(ms)
		ms >>= 8
	}
	_, _ = rand.Read(b[6:])
	// 128 bit chia thành 26 ký tự: ký tự đầu lấy 3 bit cao, còn lại mỗi ký tự 5 bit, như ULID chuẩn.
	out := make([]byte, 26)
	out[0] = alphabet[b[0]>>5]
	acc, bits, j := uint32(b[0]&0x1f), 5, 1
	for i := 1; i < 16; i++ {
		acc = acc<<8 | uint32(b[i])
		bits += 8
		for bits >= 5 {
			bits -= 5
			out[j] = alphabet[(acc>>bits)&0x1f]
			j++
		}
	}
	return string(out)
}
