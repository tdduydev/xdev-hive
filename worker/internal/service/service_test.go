package service

import (
	"errors"
	"strings"
	"testing"
)

func TestBuildGoldenPlatforms(t *testing.T) {
	tests := []struct{ goos, file, log, want string }{
		{"linux", "/home/lin/.config/systemd/user/hive-worker.service", "journalctl --user -u hive-worker", "RestartPreventExitStatus=3\nEnvironment=HOME=\"/home/lin\"\nEnvironment=PATH=\"/usr/bin:/home/lin/bin\"\nEnvironment=HIVE_WORKER_CONFIG=\"/tmp/worker config.json\""},
		{"darwin", "/home/mac/Library/LaunchAgents/dev.xdev-hive.worker.plist", "/home/mac/Library/Logs/xdev-hive/worker.log", "<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>"},
		{"windows", "Task Scheduler: dev.xdev-hive.worker", "/home/dev/AppData/Local/xdev-hive/worker.log", "Task Scheduler task"},
	}
	for _, tc := range tests {
		t.Run(tc.goos, func(t *testing.T) {
			p, err := Build(tc.goos, "/opt/hive worker", "/home/"+map[string]string{"linux": "lin", "darwin": "mac", "windows": "dev"}[tc.goos], "/usr/bin:/home/lin/bin", "/tmp/worker config.json", 4)
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
	p, _ := Build("linux", "/bin/worker", "/home/test", "/bin", "", 1)
	calls := 0
	m := Manager{Run: func(name string, args ...string) error { calls++; return errors.New("expected failure") }}
	// A deliberately invalid destination proves the command runner is only reached after a successful file write.
	p.File = "/dev/null/hive-worker.service"
	if err := m.Install(p, false, &strings.Builder{}); err == nil || calls != 0 {
		t.Fatalf("err=%v calls=%d", err, calls)
	}
}
