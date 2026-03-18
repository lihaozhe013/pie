//go:build !unix

package rpc

import "os/exec"

// setProcessGroup is a no-op on platforms without Unix process groups.
func setProcessGroup(cmd *exec.Cmd) {}

// terminateProcess stops the child process.
func terminateProcess(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	return cmd.Process.Kill()
}
