// Package bridge ships the extension that gives pie the runtime commands
// pi's RPC mode does not expose.
package bridge

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
)

//go:embed pie-bridge.ts
var files embed.FS

// Name is the base name of the extension file on disk.
const Name = "pie-bridge"

// Ensure writes the embedded extension into dir/bridge and returns its path.
// The content hash in the file name makes an upgrade self-cleaning: a new
// binary writes a new file, and the old one is removed.
func Ensure(dir string) (string, error) {
	source, err := files.ReadFile("pie-bridge.ts")
	if err != nil {
		return "", fmt.Errorf("read embedded bridge: %w", err)
	}
	sum := sha256.Sum256(source)
	name := fmt.Sprintf("%s-%s.ts", Name, hex.EncodeToString(sum[:6]))
	targetDir := filepath.Join(dir, "bridge")
	path := filepath.Join(targetDir, name)

	if info, statErr := os.Stat(path); statErr == nil && info.Size() == int64(len(source)) {
		return path, nil
	}
	if err := os.MkdirAll(targetDir, 0o700); err != nil {
		return "", fmt.Errorf("create bridge directory: %w", err)
	}
	temp, err := os.CreateTemp(targetDir, "."+name+".tmp-*")
	if err != nil {
		return "", fmt.Errorf("create bridge file: %w", err)
	}
	tempName := temp.Name()
	defer func() { _ = os.Remove(tempName) }()
	if err := temp.Chmod(0o600); err != nil {
		_ = temp.Close()
		return "", err
	}
	if _, err := temp.Write(source); err != nil {
		_ = temp.Close()
		return "", err
	}
	if err := temp.Close(); err != nil {
		return "", err
	}
	if err := os.Rename(tempName, path); err != nil {
		return "", err
	}

	// Remove files from earlier versions; a failure only leaves a stale file
	// behind, which is harmless.
	matches, _ := filepath.Glob(filepath.Join(targetDir, Name+"-*.ts"))
	for _, match := range matches {
		if match != path {
			_ = os.Remove(match)
		}
	}
	return path, nil
}
