package secretstore

import (
	"context"
	"errors"
	"testing"

	"github.com/godbus/dbus/v5"
)

func TestLinuxStatusWithoutSessionBus(t *testing.T) {
	t.Setenv("DBUS_SESSION_BUS_ADDRESS", "")
	t.Setenv("XDG_RUNTIME_DIR", "")
	st := NewSystemStore().Status()
	if st.Available || st.Reason == nil {
		t.Fatal("máy không có bus vẫn báo kho sẵn sàng")
	}
}

func TestLinuxKeyringErrorClassification(t *testing.T) {
	for _, err := range []error{
		dbus.Error{Name: "org.freedesktop.Secret.Error.IsLocked"},
		&dbus.Error{Name: "org.freedesktop.Secret.Error.IsLocked"},
		context.DeadlineExceeded,
	} {
		if !errors.Is(classify(err), ErrLocked) {
			t.Fatal("kho khoá hoặc hết giờ phải báo khoá")
		}
	}
	if !errors.Is(classify(dbus.Error{Name: "org.freedesktop.DBus.Error.ServiceUnknown"}), ErrUnavailable) {
		t.Fatal("không có Secret Service phải báo kho không dùng được")
	}
}
