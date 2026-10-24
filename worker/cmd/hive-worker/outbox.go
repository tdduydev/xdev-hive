package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/config"
	"github.com/tdduydev/xdev-hive/worker/internal/hubclient"
	"github.com/tdduydev/xdev-hive/worker/internal/optimizer"
	"github.com/tdduydev/xdev-hive/worker/internal/outbox"
	"github.com/tdduydev/xdev-hive/worker/internal/score"
)

const outboxUsage = "Cách dùng: hive-worker outbox [status | submit --kind KIND (--payload JSON | --payload-file FILE) [--stream S] [--source S] | flush | drop KHOÁ] [--config FILE] [--json]"

// outboxFlushEvery là nhịp `hive-worker run` thử gửi hộp thư đi; mục hỏng còn chờ backoff riêng (5 giây tới 5 phút).
const outboxFlushEvery = 15 * time.Second

type outboxItemView struct {
	Key           string     `json:"key"`
	Kind          string     `json:"kind"`
	Stream        string     `json:"stream"`
	Source        string     `json:"source"`
	State         string     `json:"state"`
	Attempts      int        `json:"attempts"`
	CreatedAt     time.Time  `json:"createdAt"`
	NextAttemptAt *time.Time `json:"nextAttemptAt,omitempty"`
	LastError     string     `json:"lastError,omitempty"`
	Code          string     `json:"code,omitempty"`
	Reason        string     `json:"reason,omitempty"`
}

// outboxStatusView là `outbox status --json` cho app desktop. Không in body hay token.
type outboxStatusView struct {
	Registered bool             `json:"registered"`
	Pending    int              `json:"pending"`
	Rejected   int              `json:"rejected"`
	Expired    int              `json:"expired"`
	SentRecent int              `json:"sentRecent"`
	Items      []outboxItemView `json:"items"`
}

type outboxFlushView struct {
	Registered bool `json:"registered"`
	outbox.FlushResult
	// Remaining là số mục còn chờ gửi (pending, sending) sau lượt này.
	Remaining int `json:"remaining"`
}

func itemView(it outbox.Item) outboxItemView {
	v := outboxItemView{
		Key: it.Key, Kind: it.Kind, Stream: it.Stream, Source: it.Source, State: string(it.State), Attempts: it.Attempts,
		CreatedAt: it.CreatedAt, NextAttemptAt: it.NextAttemptAt, LastError: it.LastError,
	}
	if it.Result != nil {
		v.Code, v.Reason = it.Result.Code, it.Result.Reason
	}
	return v
}

func waiting(it outbox.Item) bool {
	return it.State == outbox.StatePending || it.State == outbox.StateSending
}

func machineOutbox() (outbox.Store, error) {
	home, err := optimizeHome()
	if err != nil {
		return outbox.Store{}, err
	}
	// Hỏi mốc database của hub trong lượt gửi để gửi lại việc hub mất khi khôi phục (spec 027 FR-042).
	return outbox.Store{Root: filepath.Join(home, ".xdev-hive", "outbox"), Now: optimizeNow, Epoch: outbox.HubEpoch(optimizeHubHTTP())}, nil
}

func machineIdentity(cfg config.Config) outbox.Identity {
	return outbox.Identity{HubURL: cfg.HubURL, MachineID: cfg.MachineID}
}

func outboxCommand(args []string, stdout, stderr io.Writer) int {
	action := "status"
	if len(args) > 0 && args[0] != "" && args[0][0] != '-' {
		action, args = args[0], args[1:]
	}
	dropKey := ""
	if action == "drop" && len(args) > 0 && args[0] != "" && args[0][0] != '-' {
		dropKey, args = args[0], args[1:]
	}
	fs := flag.NewFlagSet("outbox "+action, flag.ContinueOnError)
	fs.SetOutput(stderr)
	configPath := fs.String("config", "", "file cấu hình worker")
	asJSON := fs.Bool("json", false, "in dạng JSON (cho app desktop)")
	kind := fs.String("kind", "", "submit: loại việc (machine.token_score, memory.propose, project.token_usage)")
	payload := fs.String("payload", "", "submit: nội dung JSON")
	payloadFile := fs.String("payload-file", "", "submit: file chứa nội dung JSON")
	stream := fs.String("stream", "", "submit: nhóm giữ thứ tự gửi (mặc định theo loại việc)")
	source := fs.String("source", "", "submit: nơi tạo việc (mặc định worker)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	fail := func(err error) int {
		fmt.Fprintln(stderr, err)
		return 1
	}
	path, err := pathOr(*configPath)
	if err != nil {
		return fail(err)
	}
	cfg, registered := registeredHub(path)
	store, err := machineOutbox()
	if err != nil {
		return fail(err)
	}
	id := machineIdentity(cfg)

	switch action {
	case "submit":
		if *kind == "" || (*payload == "") == (*payloadFile == "") {
			fmt.Fprintln(stderr, outboxUsage)
			return 2
		}
		if !registered {
			return fail(config.ErrNotRegistered)
		}
		body := []byte(*payload)
		if *payloadFile != "" {
			if body, err = os.ReadFile(*payloadFile); err != nil {
				return fail(fmt.Errorf("không đọc được nội dung gửi: %w", err))
			}
		}
		it, err := store.Submit(id, outbox.Submission{Kind: *kind, Source: *source, Stream: *stream, Payload: body})
		if err != nil {
			return fail(err)
		}
		if *asJSON {
			return printJSON(stdout, stderr, itemView(it))
		}
		fmt.Fprintf(stdout, "Đã xếp việc %s vào hộp thư đi (%s).\n", it.Key, it.Kind)
	case "flush":
		view := outboxFlushView{Registered: registered, FlushResult: outbox.FlushResult{Items: []outbox.Outcome{}}}
		if registered {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
			defer cancel()
			if view.FlushResult, err = flushMachineOutbox(ctx, cfg); err != nil {
				return fail(fmt.Errorf("không gửi được hộp thư đi: %w", err))
			}
			items, err := store.List(id)
			if err != nil {
				return fail(err)
			}
			for _, it := range items {
				if waiting(it) {
					view.Remaining++
				}
			}
		}
		if *asJSON {
			return printJSON(stdout, stderr, view)
		}
		if !registered {
			fmt.Fprintln(stdout, "Máy chưa đăng ký với hub nên chưa gửi được.")
			return 0
		}
		fmt.Fprintf(stdout, "Hub nhận %d, trùng %d, từ chối %d, hết hạn %d; còn %d việc chờ gửi.\n",
			view.Accepted, view.Duplicate, view.Rejected, view.Expired, view.Remaining)
	case "status":
		view := outboxStatusView{Registered: registered, Items: []outboxItemView{}}
		if cfg.MachineID != "" {
			items, err := store.List(id)
			if err != nil {
				return fail(err)
			}
			for _, it := range items {
				switch {
				case waiting(it):
					view.Pending++
				case it.State == outbox.StateRejected:
					view.Rejected++
				case it.State == outbox.StateExpired:
					view.Expired++
				}
				view.Items = append(view.Items, itemView(it))
			}
			sent, err := store.Sent(id)
			if err != nil {
				return fail(err)
			}
			view.SentRecent = len(sent)
		}
		if *asJSON {
			return printJSON(stdout, stderr, view)
		}
		fmt.Fprintf(stdout, "Hộp thư đi: %d việc chờ gửi, %d bị từ chối, %d hết hạn; hub đã nhận %d việc trong 14 ngày.\n",
			view.Pending, view.Rejected, view.Expired, view.SentRecent)
		for _, it := range view.Items {
			line := fmt.Sprintf("  %s  %s  %s", it.Key, it.Kind, it.State)
			if it.Reason != "" {
				line += fmt.Sprintf("  %s (%s)", it.Reason, it.Code)
			} else if it.LastError != "" {
				line += "  " + it.LastError
			}
			fmt.Fprintln(stdout, line)
		}
		if !registered {
			fmt.Fprintln(stdout, "Máy chưa đăng ký với hub nên chưa gửi được.")
		}
	case "drop":
		if dropKey == "" {
			fmt.Fprintln(stderr, outboxUsage)
			return 2
		}
		if cfg.MachineID == "" {
			return fail(config.ErrNotRegistered)
		}
		if err := store.Drop(id, dropKey); err != nil {
			return fail(err)
		}
		if *asJSON {
			return printJSON(stdout, stderr, map[string]string{"dropped": dropKey})
		}
		fmt.Fprintf(stdout, "Đã bỏ việc %s khỏi hộp thư đi.\n", dropKey)
	default:
		fmt.Fprintln(stderr, outboxUsage)
		return 2
	}
	return 0
}

// flushMachineOutbox gửi hộp thư đi của máy. Báo cáo điểm chờ của bản trước (score-report.json) được chuyển vào hộp
// thư đi trước, để chỉ còn một nơi giữ việc chưa gửi. Hub nhận điểm máy thì ghi lần gửi để giữ nhịp mỗi giờ một lần.
func flushMachineOutbox(ctx context.Context, cfg config.Config) (outbox.FlushResult, error) {
	store, err := machineOutbox()
	if err != nil {
		return outbox.FlushResult{}, err
	}
	home, err := optimizeHome()
	if err != nil {
		return outbox.FlushResult{}, err
	}
	id := machineIdentity(cfg)
	reportDir := filepath.Dir(optimizer.New(home).StatePath())
	if err := migrateScorePending(store, id, reportDir); err != nil {
		return outbox.FlushResult{}, err
	}
	bearer, err := hubBearer(ctx, &cfg)
	if err != nil {
		return outbox.FlushResult{}, err
	}
	res, err := store.Flush(ctx, id, outbox.HubSender(optimizeHubHTTP(), cfg.HubURL, bearer))
	sent := false
	for _, o := range res.Items {
		if o.Kind == outbox.KindTokenScore && (o.State == outbox.StateAccepted || o.State == outbox.StateDuplicate) {
			sent = true
		}
	}
	if sent {
		now := optimizeNow().UTC()
		if _, uerr := score.UpdateReportState(reportDir, func(st *score.ReportState) error {
			if st.LastSentAt == nil || now.After(*st.LastSentAt) {
				st.LastSentAt = &now
			}
			return nil
		}); uerr != nil {
			err = errors.Join(err, uerr)
		}
	}
	return res, err
}

// migrateScorePending chuyển báo cáo điểm chờ (spec 025) sang hộp thư đi, giữ khoá và createdAt cũ: hub có thể đã nhận
// báo cáo đó trước khi tiến trình cũ chết, gửi lại cùng khoá thì hub trả `duplicate`.
func migrateScorePending(store outbox.Store, id outbox.Identity, reportDir string) error {
	st, err := score.LoadReportState(reportDir)
	if err != nil || st.Pending == nil {
		return err
	}
	_, err = score.UpdateReportState(reportDir, func(st *score.ReportState) error {
		if st.Pending == nil {
			return nil
		}
		var ev hubclient.ClientEvent
		// Body hỏng không gửi được bao giờ: bỏ luôn thay vì kẹt mãi.
		if json.Unmarshal(st.Pending.Body, &ev) == nil && ev.Key == st.Pending.Key && len(ev.Payload) > 0 {
			created, _ := time.Parse(time.RFC3339, ev.CreatedAt)
			if _, err := store.Submit(id, outbox.Submission{
				Kind: outbox.KindTokenScore, Key: ev.Key, CreatedAt: created, Payload: ev.Payload,
			}); err != nil {
				return err
			}
		}
		st.Pending = nil
		return nil
	})
	return err
}

// outboxLoop gửi hộp thư đi trong lúc `hive-worker run` chạy: ngay khi bắt đầu (việc dồn lại lúc máy tắt) rồi theo nhịp.
// Gửi cả mục của người dùng, nên vẫn chạy khi máy chưa đăng ký.
func outboxLoop(ctx context.Context, cfg config.Config, every time.Duration) {
	svc, err := newOutboxService(ctx, cfg)
	if err != nil {
		slog.Warn("không mở được hộp thư đi", "err", err)
		return
	}
	svc.loop(every)
}

// pendingKind báo hộp thư đi còn việc chờ gửi của kind (dùng cho trạng thái gửi điểm).
func pendingKind(store outbox.Store, id outbox.Identity, kind string) bool {
	if id.MachineID == "" {
		return false
	}
	items, err := store.List(id)
	if err != nil {
		return false
	}
	for _, it := range items {
		if it.Kind == kind && waiting(it) && strings.TrimRight(it.Identity.HubURL, "/") == strings.TrimRight(id.HubURL, "/") {
			return true
		}
	}
	return false
}
