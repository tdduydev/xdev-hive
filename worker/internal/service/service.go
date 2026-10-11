// Package service cài worker như dịch vụ đăng nhập của người dùng hiện tại.
package service

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

const ID = "dev.xdev-hive.worker"

type Plan struct {
	OS, File, Log string
	Content       string
	Commands      [][]string
}

func Build(goos, executable, home, pathEnv, configPath string, capacity int) (Plan, error) {
	if capacity < 1 {
		return Plan{}, fmt.Errorf("capacity phải lớn hơn 0")
	}
	executable, _ = filepath.Abs(executable)
	var args []string
	if configPath != "" {
		configPath, _ = filepath.Abs(configPath)
		args = append(args, "--config", configPath)
	}
	args = append(args, "--capacity", strconv.Itoa(capacity))
	base := Plan{OS: goos}
	switch goos {
	case "linux":
		unitExec := systemdExec(executable, append([]string{"run"}, args...))
		base.File = filepath.Join(home, ".config/systemd/user/hive-worker.service")
		base.Log = "journalctl --user -u hive-worker"
		base.Content = "[Unit]\nDescription=xDev Hive Worker\n\n[Service]\nType=simple\nExecStart=" + unitExec + "\nRestart=on-failure\nRestartPreventExitStatus=3\nEnvironment=HOME=" + systemdQuote(home) + "\nEnvironment=PATH=" + systemdQuote(pathEnv) + "\n"
		if configPath != "" {
			base.Content += "Environment=HIVE_WORKER_CONFIG=" + systemdQuote(configPath) + "\n"
		}
		base.Content += "\n[Install]\nWantedBy=default.target\n"
		base.Commands = [][]string{{"systemctl", "--user", "daemon-reload"}, {"systemctl", "--user", "enable", "--now", "hive-worker.service"}}
	case "darwin":
		base.File = filepath.Join(home, "Library/LaunchAgents", ID+".plist")
		base.Log = filepath.Join(home, "Library/Logs/xdev-hive/worker.log")
		base.Content = plist(executable, append([]string{"run"}, args...), home, pathEnv, configPath, base.Log)
		uid := strconv.Itoa(os.Getuid())
		base.Commands = [][]string{{"launchctl", "bootout", "gui/" + uid + "/" + ID}, {"launchctl", "bootstrap", "gui/" + uid, base.File}}
	case "windows":
		windowsExec := windowsCommand(executable, append([]string{"run"}, args...))
		base.File = "Task Scheduler: " + ID
		local := os.Getenv("LOCALAPPDATA")
		if local == "" {
			local = filepath.Join(home, "AppData/Local")
		}
		base.Log = filepath.Join(local, "xdev-hive/worker.log")
		base.Content = "Task Scheduler task (on logon, least privilege)\nExecutable: " + executable + "\nArguments: run " + strings.Join(args, " ") + "\nHOME: " + home + "\nPATH: " + pathEnv + "\nLog: " + base.Log + "\n"
		wrapped := `cmd.exe /d /s /c "set "HOME=` + home + `"&&set "PATH=` + pathEnv + `"`
		if configPath != "" {
			wrapped += `&&set "HIVE_WORKER_CONFIG=` + configPath + `"`
		}
		wrapped += `&& ` + windowsExec + ` >> "` + base.Log + `" 2>&1"`
		base.Commands = [][]string{{"schtasks", "/Create", "/TN", ID, "/SC", "ONLOGON", "/RL", "LIMITED", "/TR", wrapped, "/F"}, {"schtasks", "/Run", "/TN", ID}}
	default:
		return Plan{}, fmt.Errorf("hệ điều hành %s chưa được hỗ trợ", goos)
	}
	return base, nil
}

func windowsCommand(executable string, args []string) string {
	quote := func(s string) string { return `"` + strings.ReplaceAll(s, `"`, `\"`) + `"` }
	parts := []string{quote(executable)}
	for _, arg := range args {
		parts = append(parts, quote(arg))
	}
	return strings.Join(parts, " ")
}
func systemdQuote(s string) string {
	return `"` + strings.ReplaceAll(strings.ReplaceAll(s, `\`, `\\`), `"`, `\"`) + `"`
}
func systemdExec(executable string, args []string) string {
	parts := []string{systemdQuote(executable)}
	for _, arg := range args {
		parts = append(parts, systemdQuote(arg))
	}
	return strings.Join(parts, " ")
}

func plist(exe string, args []string, home, pathEnv, config, log string) string {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?>` + "\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict>\n")
	value := func(k, v string) { fmt.Fprintf(&b, "<key>%s</key><string>%s</string>\n", k, xmlEscape(v)) }
	value("Label", ID)
	array := append([]string{exe}, args...)
	b.WriteString("<key>ProgramArguments</key><array>\n")
	for _, a := range array {
		fmt.Fprintf(&b, "<string>%s</string>\n", xmlEscape(a))
	}
	b.WriteString("</array>\n")
	b.WriteString("<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n")
	value("StandardOutPath", log)
	value("StandardErrorPath", log)
	b.WriteString("<key>EnvironmentVariables</key><dict>\n")
	value("HOME", home)
	value("PATH", pathEnv)
	value("HIVE_WORKER_LAUNCHD", "1")
	if config != "" {
		value("HIVE_WORKER_CONFIG", config)
	}
	b.WriteString("</dict>\n</dict></plist>\n")
	return b.String()
}
func xmlEscape(s string) string {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&apos;")
	return r.Replace(s)
}

type Runner func(name string, args ...string) error
type Manager struct {
	Run  Runner
	GOOS string
	Home string
}

func (m Manager) command(name string, args ...string) error {
	if m.Run != nil {
		return m.Run(name, args...)
	}
	return exec.Command(name, args...).Run()
}
func (m Manager) Install(plan Plan, dryRun bool, out io.Writer) error {
	if dryRun {
		fmt.Fprintf(out, "%s\n", plan.Content)
		for _, c := range plan.Commands {
			fmt.Fprintf(out, "$ %s\n", strings.Join(c, " "))
		}
		return nil
	}
	if plan.OS != "windows" {
		if err := os.MkdirAll(filepath.Dir(plan.File), 0o700); err != nil {
			return err
		}
		if err := os.WriteFile(plan.File, []byte(plan.Content), 0o600); err != nil {
			return err
		}
		if plan.OS == "darwin" {
			_ = os.MkdirAll(filepath.Dir(plan.Log), 0o700)
		}
	} else if err := os.MkdirAll(filepath.Dir(plan.Log), 0o700); err != nil {
		return err
	}
	for i, c := range plan.Commands {
		if err := m.command(c[0], c[1:]...); err != nil {
			// macOS bootout trả lỗi nếu job chưa được nạp; bootstrap kế tiếp vẫn là kết quả cần thiết.
			if !(plan.OS == "darwin" && i == 0) {
				return err
			}
		}
	}
	return nil
}

func (m Manager) Uninstall(plan Plan) error {
	switch plan.OS {
	case "linux":
		_ = m.command("systemctl", "--user", "disable", "--now", "hive-worker.service")
		if err := os.Remove(plan.File); err != nil && !os.IsNotExist(err) {
			return err
		}
		return m.command("systemctl", "--user", "daemon-reload")
	case "darwin":
		uid := strconv.Itoa(os.Getuid())
		_ = m.command("launchctl", "bootout", "gui/"+uid+"/"+ID)
		if err := os.Remove(plan.File); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	case "windows":
		return m.command("schtasks", "/Delete", "/TN", ID, "/F")
	default:
		return fmt.Errorf("hệ điều hành %s chưa được hỗ trợ", plan.OS)
	}
}

func (m Manager) Status(plan Plan, out io.Writer) bool {
	var err error
	switch plan.OS {
	case "linux":
		err = m.command("systemctl", "--user", "is-active", "--quiet", "hive-worker.service")
	case "darwin":
		err = m.command("launchctl", "print", "gui/"+strconv.Itoa(os.Getuid())+"/"+ID)
	case "windows":
		err = m.command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "$s=(Get-ScheduledTask -TaskName '"+ID+"' -ErrorAction SilentlyContinue).State; if ($s -eq 'Running') { exit 0 } else { exit 1 }")
	}
	state := "đang dừng"
	if err == nil {
		state = "đang chạy"
	}
	fmt.Fprintf(out, "Worker %s.\nTệp dịch vụ: %s\nLog: %s\n", state, plan.File, plan.Log)
	return err == nil
}
