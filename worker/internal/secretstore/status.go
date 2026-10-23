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

// Status cho desktop biết kho dùng được không. Chỉ Credential Manager được đọc thử: nó không bao giờ khoá hay bật hộp
// thoại. Keychain và Secret Service có thể bật hộp mở khoá khi đọc, nên chưa thử; cách kiểm không hộp thoại theo từng
// hệ điều hành thuộc T035.
func (s *Store) Status() Status {
	st := Status{Available: true, Backend: backendName()}
	if runtime.GOOS != "windows" {
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
