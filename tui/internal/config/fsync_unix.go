//go:build unix

package config

import "os"

// syncDir flushes a directory entry after a rename so a crash cannot lose the
// new file. Failure is ignored: the data is already written.
func syncDir(dir string) {
	file, err := os.Open(dir)
	if err != nil {
		return
	}
	_ = file.Sync()
	_ = file.Close()
}
