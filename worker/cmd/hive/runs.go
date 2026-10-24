package main

import "github.com/tdduydev/xdev-hive/worker/internal/runlogs"

func (a *app) runs(args []string) int {
	return runlogs.Command(args, a.stdout, a.stderr, a.socket)
}
