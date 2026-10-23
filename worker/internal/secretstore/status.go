package secretstore

import (
	"errors"
	"runtime"

	"github.com/zalando/go-keyring"
)

// Status là StoreStatus của contracts/sidecar-cli.md. Locked và Reason là con trỏ vì null có nghĩa riêng: null ở Locked là
// không biết được mà không bật hộp thoại.
type Status struct {
	Available bool    `json:"available"`
	Locked    *bool   `json:"locked"`
	Backend   string  `json:"backend"`
	Reason    *string `json:"reason"`
}

// probeAccount không thể là tên bí mật (tên chỉ có chữ in hoa, số, _), nên đọc thử không đụng mục của người dùng.
const probeAccount = "~status"

func backendName() string {
	switch runtime.GOOS {
	case "windows":
		return "wincred"
	case "darwin":
		return "keychain"
	case "linux", "freebsd", "openbsd", "netbsd":
		return "secret-service"
	}
	return "unknown"
}

// Keychain giữ trạng thái chưa biết để không bật hộp thoại từ màn danh sách. Backend Linux kiểm Locked mà không gọi
// Unlock/Prompt; Credential Manager không có hộp mở khoá, nên cả hai có thể đọc thử một tên không tồn tại.
func (s *Store) Status() Status {
	st := Status{Available: true, Backend: backendName()}
	if runtime.GOOS != "windows" && runtime.GOOS != "linux" {
		return st
	}
	no := false
	st.Locked = &no
	if _, err := s.kr.Get(Service, probeAccount); err != nil && !errors.Is(err, keyring.ErrNotFound) {
		e := classify(err)
		st.Available = e.Code != CodeStoreUnavailable
		if e.Code == CodeStoreLocked {
			yes := true
			st.Locked = &yes
		}
		st.Reason = &e.Message
	}
	return st
}
