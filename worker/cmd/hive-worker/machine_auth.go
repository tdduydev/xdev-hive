package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"sync"

	"github.com/tdduydev/xdev-hive/worker/internal/config"
	"github.com/tdduydev/xdev-hive/worker/internal/hubclient"
	"github.com/tdduydev/xdev-hive/worker/internal/machinekey"
)

// newKeyStore là chỗ test thay keychain thật bằng bản giả, để test không ghi vào keychain của máy dev.
var newKeyStore = machinekey.NewStore

// tokenSources giữ một TokenSource cho mỗi worker.json và hub, để kênh WSS và hộp thư đi trong cùng tiến trình dùng chung
// một access token thay vì mỗi bên tự ký.
var tokenSources sync.Map

// machineAuth trả TokenSource khi máy có khoá. Máy cài trước spec 027 còn machine token thì gửi khoá lên hub trước;
// hub cũ hay không gọi được hub thì trả nil và máy dùng tiếp machine token, lần chạy sau thử lại.
func machineAuth(ctx context.Context, cfg *config.Config) (*hubclient.TokenSource, error) {
	if !cfg.Registered() {
		return nil, config.ErrNotRegistered
	}
	if cfg.KeyStorage == "" && cfg.Path == "" {
		// Không biết worker.json ở đâu thì không có chỗ cất khoá và id máy; dùng machine token.
		return nil, nil
	}
	if cfg.Path == "" {
		return nil, errors.New("không biết worker.json ở đâu để tìm khoá máy")
	}
	store := newKeyStore(cfg.Path)
	if cfg.KeyStorage == "" {
		if err := migrateMachineKey(ctx, cfg, store); err != nil {
			slog.Warn("chưa gửi được khoá máy lên hub, dùng tạm machine token", "err", err)
			return nil, nil
		}
	}
	if cfg.ID == "" {
		return nil, hubclient.ErrNoMachineID
	}
	cacheKey := cfg.Path + "\n" + cfg.HubURL
	if ts, ok := tokenSources.Load(cacheKey); ok {
		return ts.(*hubclient.TokenSource), nil
	}
	key, err := store.Load(cfg.HubURL, cfg.MachineID)
	if errors.Is(err, machinekey.ErrNoKey) {
		return nil, errors.New("không thấy khoá máy trong keychain hay file cạnh worker.json; chạy lại `hive-worker register`")
	}
	if err != nil {
		return nil, err
	}
	ts, _ := tokenSources.LoadOrStore(cacheKey, &hubclient.TokenSource{Client: hubclient.New(cfg.HubURL), HubURL: cfg.HubURL, MachineID: cfg.ID, Key: key})
	return ts.(*hubclient.TokenSource), nil
}

// migrateMachineKey tạo khoá, gửi lên hub bằng machine token rồi xoá token khỏi worker.json. Hub vô hiệu machine token
// ngay khi nhận khoá, nên ghi file hỏng sau bước đó thì máy phải đăng ký lại; báo rõ trong log.
func migrateMachineKey(ctx context.Context, cfg *config.Config, store *machinekey.Store) error {
	key, err := store.Load(cfg.HubURL, cfg.MachineID)
	if errors.Is(err, machinekey.ErrNoKey) {
		key, err = store.Create(cfg.HubURL, cfg.MachineID)
	}
	if err != nil {
		return err
	}
	id, err := hubclient.New(cfg.HubURL).RegisterKey(ctx, cfg.MachineToken, key.PublicKey(), key.Storage)
	if err != nil {
		return err
	}
	next := *cfg
	next.ID, next.KeyStorage, next.MachineToken = id, key.Storage, ""
	if err := config.Save(cfg.Path, next); err != nil {
		slog.Error("hub đã nhận khoá máy nhưng không ghi được worker.json; chạy lại `hive-worker register` nếu worker không nối được", "err", err)
	}
	*cfg = next
	return nil
}

// keyWorks thử đổi khoá lấy access token ngay sau khi đăng ký. Hub cũ không có route token (404) thì máy giữ machine
// token; lỗi khác (mạng chập chờn) vẫn tin khoá vì hub mới đã vô hiệu machine token lúc nhận khoá.
func keyWorks(ctx context.Context, client *hubclient.HealthClient, hubURL, id string, key hubclient.Signer) bool {
	if id == "" {
		return false
	}
	ts := &hubclient.TokenSource{Client: client, HubURL: hubURL, MachineID: id, Key: key}
	_, _, err := ts.Token(ctx, true)
	var se *hubclient.StatusError
	if errors.As(err, &se) && se.Status == http.StatusNotFound {
		return false
	}
	if err != nil {
		slog.Warn("chưa đổi được khoá máy lấy access token", "err", err)
	}
	return true
}

// hubBearer là token gửi kèm lời gọi HTTP của worker: access token khi máy có khoá, machine token khi chưa.
func hubBearer(ctx context.Context, cfg *config.Config) (string, error) {
	ts, err := machineAuth(ctx, cfg)
	if err != nil {
		return "", err
	}
	if ts == nil {
		return cfg.MachineToken, nil
	}
	token, _, err := ts.Token(ctx, false)
	return token, err
}
