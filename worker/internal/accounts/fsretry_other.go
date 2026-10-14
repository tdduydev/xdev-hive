//go:build !windows

package accounts

func transient(error) bool { return false }
