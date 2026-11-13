package ui

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

// clipboardImageReadTimeout bounds one native image read. PowerShell has to
// start, read the bitmap, and encode it before the first byte arrives, so
// images get a longer budget than text.
const clipboardImageReadTimeout = 10 * time.Second

// pastedImageAttempts bounds the sequence numbers tried for one paste name.
const pastedImageAttempts = 1000

var (
	errNoClipboardImage       = errors.New("clipboard has no image")
	errNoClipboardImageReader = errors.New("no clipboard image reader available; use /image <path>")
)

// clipboardImage is one image read from the system clipboard.
type clipboardImage struct {
	data     []byte
	mimeType string
}

// pastedImageMsg reports the outcome of saving a clipboard image. name is the
// pasted file's base name inside the working directory; the caller inserts its
// @ mention into the composer.
type pastedImageMsg struct {
	name string
	err  error
}

// clipboardImageExtensions maps a clipboard MIME type to the extension of the
// file written into the working directory. It matches the web client's map, so
// a screenshot pasted into either client gets the same kind of name.
var clipboardImageExtensions = map[string]string{
	"image/png":     "png",
	"image/jpeg":    "jpg",
	"image/gif":     "gif",
	"image/webp":    "webp",
	"image/svg+xml": "svg",
}

// clipboardImageTypes is the preference order for a clipboard that offers
// several image flavours.
var clipboardImageTypes = []string{
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
	"image/svg+xml",
}

// imageClipboardReader is one native clipboard image reader.
type imageClipboardReader struct {
	name string
	read func() (clipboardImage, error)
}

// nativeImageReaders lists image readers in preference order. Missing tools
// are skipped by readNativeImage.
func nativeImageReaders() []imageClipboardReader {
	switch runtime.GOOS {
	case "darwin":
		return []imageClipboardReader{
			{name: "pngpaste", read: readPNGPaste},
			{name: "osascript", read: readAppleScriptImage},
		}
	case "windows":
		return []imageClipboardReader{
			{name: "powershell", read: readPowerShellImage("powershell")},
			{name: "pwsh", read: readPowerShellImage("pwsh")},
		}
	}

	if os.Getenv("TERMUX_VERSION") != "" {
		// Termux clipboard tools expose text only, not image data.
		return nil
	}
	var readers []imageClipboardReader
	if os.Getenv("WAYLAND_DISPLAY") != "" || os.Getenv("XDG_SESSION_TYPE") == "wayland" {
		readers = append(readers, imageClipboardReader{name: "wl-paste", read: readWLPasteImage})
	}
	readers = append(readers, imageClipboardReader{name: "xclip", read: readXclipImage})
	if os.Getenv("WSL_DISTRO_NAME") != "" || os.Getenv("WSL_INTEROP") != "" {
		readers = append(readers,
			imageClipboardReader{name: "powershell.exe", read: readPowerShellImage("powershell.exe")},
			imageClipboardReader{name: "pwsh.exe", read: readPowerShellImage("pwsh.exe")},
		)
	}
	return readers
}

// readNativeImage runs the first available image reader that finds an image.
// A reader that works but finds no image is not an error, so an empty
// clipboard is reported as such rather than as a broken tool.
func readNativeImage() (clipboardImage, error) {
	var lastErr error
	sawNoImage := false
	ran := false
	for _, reader := range nativeImageReaders() {
		if _, err := exec.LookPath(reader.name); err != nil {
			lastErr = err
			continue
		}
		ran = true
		image, err := reader.read()
		if err == nil {
			return image, nil
		}
		if errors.Is(err, errNoClipboardImage) {
			sawNoImage = true
			continue
		}
		lastErr = err
	}
	if !ran {
		if lastErr != nil {
			return clipboardImage{}, fmt.Errorf("%w: %v", errNoClipboardImageReader, lastErr)
		}
		return clipboardImage{}, errNoClipboardImageReader
	}
	if sawNoImage {
		return clipboardImage{}, errNoClipboardImage
	}
	if lastErr != nil {
		return clipboardImage{}, lastErr
	}
	return clipboardImage{}, errNoClipboardImage
}

// powershellImageScript writes the clipboard bitmap to stdout as base64. The
// encoding happens in PowerShell so the console code page cannot corrupt the
// PNG on its way back to Go. An empty clipboard prints nothing and exits zero.
const powershellImageScript = `Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$image = [System.Windows.Forms.Clipboard]::GetImage()
if ($image -eq $null) { return }
$stream = New-Object System.IO.MemoryStream
try {
  $image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $image.Dispose()
}
[Convert]::ToBase64String($stream.ToArray())`

// readPowerShellImage reads the clipboard bitmap through one PowerShell host.
// -STA is required before the clipboard can be opened from a console session.
func readPowerShellImage(shell string) func() (clipboardImage, error) {
	return func() (clipboardImage, error) {
		output, err := runClipboardCommand(clipboardImageReadTimeout, shell,
			"-NoProfile", "-NonInteractive", "-STA", "-Command", powershellImageScript)
		if err != nil {
			return clipboardImage{}, err
		}
		encoded := strings.TrimSpace(string(output))
		if encoded == "" {
			return clipboardImage{}, errNoClipboardImage
		}
		data, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			return clipboardImage{}, fmt.Errorf("decode clipboard image: %w", err)
		}
		if len(data) == 0 {
			return clipboardImage{}, errNoClipboardImage
		}
		return clipboardImage{data: data, mimeType: "image/png"}, nil
	}
}

// readPNGPaste reads the clipboard through pngpaste when it is installed.
func readPNGPaste() (clipboardImage, error) {
	output, err := runClipboardCommand(clipboardImageReadTimeout, "pngpaste", "-")
	if err != nil {
		if clipboardCommandSaysEmpty(err, "no image", "doesn't contain", "not contain") {
			return clipboardImage{}, errNoClipboardImage
		}
		return clipboardImage{}, err
	}
	if len(output) == 0 {
		return clipboardImage{}, errNoClipboardImage
	}
	return clipboardImage{data: output, mimeType: "image/png"}, nil
}

// readAppleScriptImage reads the clipboard PNG through osascript, which every
// macOS installation has. The data goes to a temporary file because AppleScript
// cannot write binary to stdout.
func readAppleScriptImage() (clipboardImage, error) {
	temp, err := os.CreateTemp("", "pie-clipboard-*.png")
	if err != nil {
		return clipboardImage{}, err
	}
	path := temp.Name()
	if err := temp.Close(); err != nil {
		_ = os.Remove(path)
		return clipboardImage{}, err
	}
	defer os.Remove(path)

	script := appleScriptClipboardImage(path)
	if _, err := runClipboardCommand(clipboardImageReadTimeout, "osascript", "-e", script); err != nil {
		// -1700 is AppleScript's "clipboard doesn't contain that data type".
		if clipboardCommandSaysEmpty(err, "-1700", "doesn't contain") {
			return clipboardImage{}, errNoClipboardImage
		}
		return clipboardImage{}, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return clipboardImage{}, err
	}
	if len(data) == 0 {
		return clipboardImage{}, errNoClipboardImage
	}
	return clipboardImage{data: data, mimeType: "image/png"}, nil
}

// appleScriptClipboardImage builds the script that writes the clipboard PNG to
// path.
func appleScriptClipboardImage(path string) string {
	return fmt.Sprintf(`set pngData to the clipboard as «class PNGf»
set target to open for access POSIX file %s with write permission
set eof target to 0
write pngData to target
close access target`, appleScriptString(path))
}

// appleScriptString quotes one path as an AppleScript string literal.
func appleScriptString(value string) string {
	replacer := strings.NewReplacer(`\`, `\\`, `"`, `\"`)
	return `"` + replacer.Replace(value) + `"`
}

// readWLPasteImage reads the clipboard through wl-paste on Wayland.
func readWLPasteImage() (clipboardImage, error) {
	types, err := runClipboardCommand(clipboardImageReadTimeout, "wl-paste", "--list-types")
	if err != nil {
		if clipboardCommandSaysEmpty(err, "no selection", "nothing is copied") {
			return clipboardImage{}, errNoClipboardImage
		}
		return clipboardImage{}, err
	}
	mimeType := selectClipboardImageType(string(types))
	if mimeType == "" {
		return clipboardImage{}, errNoClipboardImage
	}
	data, err := runClipboardCommand(clipboardImageReadTimeout, "wl-paste", "--type", mimeType)
	if err != nil {
		return clipboardImage{}, err
	}
	if len(data) == 0 {
		return clipboardImage{}, errNoClipboardImage
	}
	return clipboardImage{data: data, mimeType: mimeType}, nil
}

// readXclipImage reads the clipboard through xclip on X11. xsel is skipped
// because it has no image support.
func readXclipImage() (clipboardImage, error) {
	targets, err := runClipboardCommand(clipboardImageReadTimeout, "xclip",
		"-selection", "clipboard", "-t", "TARGETS", "-o")
	if err != nil {
		if clipboardCommandSaysEmpty(err, "not available", "no selection") {
			return clipboardImage{}, errNoClipboardImage
		}
		return clipboardImage{}, err
	}
	mimeType := selectClipboardImageType(string(targets))
	if mimeType == "" {
		return clipboardImage{}, errNoClipboardImage
	}
	data, err := runClipboardCommand(clipboardImageReadTimeout, "xclip",
		"-selection", "clipboard", "-t", mimeType, "-o")
	if err != nil {
		return clipboardImage{}, err
	}
	if len(data) == 0 {
		return clipboardImage{}, errNoClipboardImage
	}
	return clipboardImage{data: data, mimeType: mimeType}, nil
}

// selectClipboardImageType picks the best supported image type from a reader's
// target list.
func selectClipboardImageType(list string) string {
	available := make(map[string]bool)
	for _, line := range strings.Split(list, "\n") {
		line = strings.ToLower(strings.TrimSpace(strings.TrimSuffix(line, "\r")))
		if line != "" {
			available[line] = true
		}
	}
	for _, mimeType := range clipboardImageTypes {
		if available[mimeType] {
			return mimeType
		}
	}
	return ""
}

// runClipboardCommand runs one clipboard tool with a timeout.
func runClipboardCommand(timeout time.Duration, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	output, err := cmd.Output()
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return nil, fmt.Errorf("%s: timed out after %s", name, timeout)
		}
		return nil, fmt.Errorf("%s: %w", name, err)
	}
	return output, nil
}

// clipboardCommandSaysEmpty reports whether a failed reader said, in its own
// words, that the clipboard holds no matching data.
func clipboardCommandSaysEmpty(err error, phrases ...string) bool {
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) {
		return false
	}
	stderr := strings.ToLower(string(exitErr.Stderr))
	if stderr == "" {
		return false
	}
	for _, phrase := range phrases {
		if strings.Contains(stderr, strings.ToLower(phrase)) {
			return true
		}
	}
	return false
}

// savePastedImage writes one clipboard image into dir under a timestamped name
// and returns its base name. The file is created exclusively, so a paste never
// replaces a file already there; a name collision moves to the next sequence.
func savePastedImage(dir string, image clipboardImage) (string, error) {
	if dir == "" {
		return "", errors.New("no working directory is set")
	}
	extension := clipboardImageExtensions[image.mimeType]
	if extension == "" {
		extension = "png"
	}
	stamp := time.Now().UTC().Format("20060102-150405")
	for sequence := 1; sequence <= pastedImageAttempts; sequence++ {
		name := fmt.Sprintf("pasted-%s-%d.%s", stamp, sequence, extension)
		path := filepath.Join(dir, name)
		file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if errors.Is(err, os.ErrExist) {
			continue
		}
		if err != nil {
			return "", err
		}
		if _, err := file.Write(image.data); err != nil {
			_ = file.Close()
			_ = os.Remove(path)
			return "", err
		}
		if err := file.Close(); err != nil {
			_ = os.Remove(path)
			return "", err
		}
		return name, nil
	}
	return "", fmt.Errorf("cannot find a free pasted image name in %s", dir)
}

// pasteClipboardImage reads one image from the system clipboard and saves it
// into the working directory. The result's name is inserted into the composer
// as an @ mention, which is the same reference the web client sends.
func (m *Model) pasteClipboardImage() tea.Cmd {
	dir := m.opts.CWD
	return func() tea.Msg {
		image, err := readNativeImage()
		if err != nil {
			return pastedImageMsg{err: err}
		}
		if len(image.data) > maxImageBytes {
			return pastedImageMsg{err: fmt.Errorf("clipboard image is larger than %d MB", maxImageBytes>>20)}
		}
		name, err := savePastedImage(dir, image)
		if err != nil {
			return pastedImageMsg{err: err}
		}
		return pastedImageMsg{name: name}
	}
}
