package secretstore

import (
	"context"
	"errors"
	"testing"

	"github.com/zalando/go-keyring"
)

func TestDarwinLockedStoreStopsBeforeOtherItems(t *testing.T) {
	for _, err := range []error{locked(), unavailable()} {
		keyring.MockInitWithError(err)
		_, got := readAll(t.Context(), NewStore(), []string{"FIRST_KEY", "SECOND_KEY"})
		var storeErr *Error
		if !errors.As(got, &storeErr) || len(storeErr.Names) != 1 || storeErr.Names[0] != "FIRST_KEY" {
			t.Fatal("kho không đọc được vẫn thử các mục còn lại, có thể bật thêm hộp thoại")
		}
	}
}

func TestDarwinKeyringDeadlineIsLocked(t *testing.T) {
	if !errors.Is(classify(context.DeadlineExceeded), ErrLocked) {
		t.Fatal("hết giờ mở khoá phải báo khoá")
	}
}
