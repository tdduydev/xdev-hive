package main

import (
	"os"

	"golang.org/x/term"
)

// console là terminal của người dùng; tách thành interface để test chạy không cần tty thật.
type console interface {
	IsTerminal() bool
	// MakeRaw đặt stdin ở chế độ raw (phím đi thẳng tới agent, kể cả Ctrl-C); restore trả lại chế độ cũ.
	MakeRaw() (restore func(), err error)
	Size() (cols, rows int, ok bool)
}

type stdConsole struct{}

func (stdConsole) IsTerminal() bool {
	return term.IsTerminal(int(os.Stdin.Fd())) && term.IsTerminal(int(os.Stdout.Fd()))
}

func (stdConsole) MakeRaw() (func(), error) {
	fd := int(os.Stdin.Fd())
	old, err := term.MakeRaw(fd)
	if err != nil {
		return nil, err
	}
	return func() { _ = term.Restore(fd, old) }, nil
}

func (stdConsole) Size() (int, int, bool) {
	cols, rows, err := term.GetSize(int(os.Stdout.Fd()))
	if err != nil || cols <= 0 || rows <= 0 {
		return 0, 0, false
	}
	return cols, rows, true
}
