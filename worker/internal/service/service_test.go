package service

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

func TestBuildGoldenPlatforms(t *testing.T) {
	home := filepath.Join(t.TempDir(), "home")
	executable := filepath.Join(home, "hive worker")
	config := filepath.Join(home, "worker config.json")
	pathEnv := filepath.Join(home, "bin")
	// LOCALAPPDATA belongs to the runner, so isolate it from the generated fixtures.
	t.Setenv("LOCALAPPDATA", "")
	tests := []struct{ goos, file, log, want string }{
		{"linux", filepath.Join(home, ".config", "systemd", "user", "hive-worker.service"), "journalctl --user -u hive-worker", "RestartPreventExitStatus=3\nEnvironment=HOME=" + systemdQuote(home) + "\nEnvironment=PATH=" + systemdQuote(pathEnv) + "\nEnvironment=HIVE_WORKER_CONFIG=" + systemdQuote(config)},
		{"darwin", filepath.Join(home, "Library", "LaunchAgents", ID+".plist"), filepath.Join(home, "Library", "Logs", "xdev-hive", "worker.log"), "<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>"},
		{"windows", "Task Scheduler: dev.xdev-hive.worker", filepath.Join(home, "AppData", "Local", "xdev-hive", "worker.log"), "Task Scheduler task"},
	}
	for _, tc := range tests {
		t.Run(tc.goos, func(t *testing.T) {
			p, err := Build(tc.goos, executable, home, pathEnv, config, 4)
			if err != nil {
				t.Fatal(err)
			}
			if p.File != tc.file || p.Log != tc.log {
				t.Fatalf("paths = %q %q", p.File, p.Log)
			}
			if !strings.Contains(p.Content, tc.want) {
				t.Fatalf("generated content missing %q:\n%s", tc.want, p.Content)
			}
			if len(p.Commands) == 0 {
				t.Fatal("expected platform commands")
			}
			if tc.goos == "windows" && !strings.Contains(strings.Join(p.Commands[0], " "), "/SC ONLOGON") {
				t.Fatalf("schtasks arguments = %v", p.Commands[0])
			}
		})
	}
}

func TestBuildWindowsLocalAppData(t *testing.T) {
	home := t.TempDir()
	local := filepath.Join(home, "local app data")
	t.Setenv("LOCALAPPDATA", local)
	p, err := Build("windows", filepath.Join(home, "worker.exe"), home, "", "", 1)
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(local, "xdev-hive", "worker.log")
	if p.Log != want || !strings.Contains(strings.Join(p.Commands[0], " "), ` >> "`+want+`" 2>&1`) {
		t.Fatalf("log=%q commands=%v", p.Log, p.Commands)
	}
}

func TestInstallDryRunDoesNotWriteOrRunCommands(t *testing.T) {
	p, err := Build("linux", "/bin/worker", "/home/test", "/bin", "", 1)
	if err != nil {
		t.Fatal(err)
	}
	ran := false
	m := Manager{Run: func(string, ...string) error { ran = true; return nil }}
	var out strings.Builder
	if err := m.Install(p, true, &out); err != nil {
		t.Fatal(err)
	}
	if ran {
		t.Fatal("dry run executed a command")
	}
	if !strings.Contains(out.String(), "$ systemctl --user daemon-reload") {
		t.Fatalf("missing planned commands: %s", out.String())
	}
}

func TestInstallInjectsCommands(t *testing.T) {
	for _, failAt := range []int{0, 1, 2} {
		t.Run(strconv.Itoa(failAt), func(t *testing.T) {
			home := t.TempDir()
			p, err := Build("linux", filepath.Join(home, "worker"), home, "", "", 1)
			if err != nil {
				t.Fatal(err)
			}
			failure := errors.New("expected failure")
			var calls [][]string
			m := Manager{Run: func(name string, args ...string) error {
				content, err := os.ReadFile(p.File)
				if err != nil || string(content) != p.Content {
					t.Fatalf("service file must be written before commands: content=%q err=%v", content, err)
				}
				calls = append(calls, append([]string{name}, args...))
				if len(calls) == failAt {
					return failure
				}
				return nil
			}}
			err = m.Install(p, false, &strings.Builder{})
			wantCalls := len(p.Commands)
			if failAt != 0 {
				wantCalls = failAt
				if !errors.Is(err, failure) {
					t.Fatalf("expected command failure, got %v", err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(calls, p.Commands[:wantCalls]) {
				t.Fatalf("commands=%v want=%v", calls, p.Commands[:wantCalls])
			}
		})
	}
}

func TestInstallWriteFailureDoesNotRunCommands(t *testing.T) {
	home := t.TempDir()
	p, err := Build("linux", filepath.Join(home, "worker"), home, "", "", 1)
	if err != nil {
		t.Fatal(err)
	}
	parent := filepath.Join(home, "not-a-directory")
	if err := os.WriteFile(parent, []byte("occupied"), 0o600); err != nil {
		t.Fatal(err)
	}
	// A regular file cannot be a parent directory on any supported OS.
	p.File = filepath.Join(parent, "hive-worker.service")
	calls := 0
	m := Manager{Run: func(string, ...string) error { calls++; return nil }}
	if err := m.Install(p, false, &strings.Builder{}); err == nil || calls != 0 {
		t.Fatalf("err=%v calls=%d", err, calls)
	}
}

func TestRestartOnlyWhenRunning(t *testing.T) {
	for _, tc := range []struct {
		goos    string
		running bool
		want    []string
	}{
		{"linux", true, []string{"systemctl --user is-active --quiet hive-worker.service", "systemctl --user restart hive-worker.service"}},
		{"linux", false, []string{"systemctl --user is-active --quiet hive-worker.service"}},
		{"windows", true, []string{"powershell.exe", "schtasks /End /TN " + ID, "schtasks /Run /TN " + ID}},
		{"darwin", true, []string{"launchctl print", "launchctl kickstart -k"}},
	} {
		var calls []string
		m := Manager{Run: func(name string, args ...string) error {
			calls = append(calls, strings.Join(append([]string{name}, args...), " "))
			if (name == "systemctl" && args[1] == "is-active") || name == "powershell.exe" || (name == "launchctl" && args[0] == "print") {
				if !tc.running {
					return errors.New("không chạy")
				}
			}
			return nil
		}}
		restarted, err := m.Restart(Plan{OS: tc.goos})
		if err != nil || restarted != tc.running {
			t.Errorf("%s running=%v: restarted=%v err=%v", tc.goos, tc.running, restarted, err)
		}
		if len(calls) != len(tc.want) {
			t.Fatalf("%s: lệnh %q, cần %q", tc.goos, calls, tc.want)
		}
		for i, prefix := range tc.want {
			if !strings.HasPrefix(calls[i], prefix) {
				t.Errorf("%s: lệnh %d = %q, cần bắt đầu bằng %q", tc.goos, i, calls[i], prefix)
			}
		}
	}
}
