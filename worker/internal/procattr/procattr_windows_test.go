package procattr

import (
	"os/exec"
	"syscall"
	"testing"

	"golang.org/x/sys/windows"
)

func TestHideSetsNoWindow(t *testing.T) {
	cmd := Command("cmd.exe", "/C", "exit")
	if cmd.SysProcAttr == nil || !cmd.SysProcAttr.HideWindow {
		t.Fatalf("SysProcAttr = %+v, muốn HideWindow", cmd.SysProcAttr)
	}
	if cmd.SysProcAttr.CreationFlags&windows.CREATE_NO_WINDOW == 0 {
		t.Fatalf("CreationFlags = %#x, thiếu CREATE_NO_WINDOW", cmd.SysProcAttr.CreationFlags)
	}
}

func TestHideKeepsExistingFlags(t *testing.T) {
	cmd := exec.Command("cmd.exe", "/C", "exit") // procattr:allow
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP, CmdLine: "cmd.exe /C exit"}
	Hide(cmd)
	want := uint32(syscall.CREATE_NEW_PROCESS_GROUP | windows.CREATE_NO_WINDOW)
	if cmd.SysProcAttr.CreationFlags != want {
		t.Fatalf("CreationFlags = %#x, muốn %#x", cmd.SysProcAttr.CreationFlags, want)
	}
	if cmd.SysProcAttr.CmdLine != "cmd.exe /C exit" || !cmd.SysProcAttr.HideWindow {
		t.Fatalf("SysProcAttr = %+v, mất trường đã đặt", cmd.SysProcAttr)
	}
	if err := cmd.Run(); err != nil {
		t.Fatal(err)
	}
}
