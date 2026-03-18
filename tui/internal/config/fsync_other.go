//go:build !unix

package config

// syncDir is a no-op where directories cannot be fsynced.
func syncDir(string) {}
