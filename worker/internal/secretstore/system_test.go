package secretstore

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/zalando/go-keyring"
)

func TestSystemBackendTimeoutAndSafeErrors(t *testing.T) {
	keyring.MockInit()
	gate := make(chan struct{})
	kr := newSlowKeyring(0)
	kr.block = gate
	b := timedBackend{inner: kr, timeout: 10 * time.Millisecond}
	start := time.Now()
	_, err := b.Get(Service, "DEMO_CREDENTIAL")
	close(gate)
	if !errors.Is(err, ErrLocked) || time.Since(start) > time.Second {
		t.Fatal("backend không dừng khi hết giờ")
	}
	if got := classify(errors.New("fake-credential-should-not-print")); strings.Contains(got.Error(), "fake-credential") {
		t.Fatal("lỗi hệ điều hành làm lộ dữ liệu")
	}
}
