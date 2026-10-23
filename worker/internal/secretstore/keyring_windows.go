package secretstore

import (
	"errors"
	"syscall"
)

func init() {
	classify = func(err error) *Error {
		var own *Error
		if errors.As(err, &own) {
			return &Error{Code: own.Code, Message: own.Message}
		}
		if errors.Is(err, syscall.Errno(5)) || errors.Is(err, syscall.Errno(1312)) {
			return locked()
		}
		return unavailable()
	}
}
