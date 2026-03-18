package ui

import (
	"context"
	"encoding/base64"
	"fmt"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/lihaozhe013/pie/tui/internal/rpc"
)

const maxImageBytes = 20 << 20

// sendImage attaches one local image to a prompt. The text after the path is
// the prompt; without one the model is asked to describe the image.
func (m *Model) sendImage(argument string) tea.Cmd {
	argument = strings.TrimSpace(argument)
	if argument == "" {
		m.setToast("usage: /image <path> [prompt]")
		return nil
	}
	if m.busy {
		m.setToast("wait for the current turn before attaching an image")
		return nil
	}
	path := argument
	prompt := ""
	if index := strings.IndexAny(argument, " \t"); index >= 0 {
		path = argument[:index]
		prompt = strings.TrimSpace(argument[index+1:])
	}
	path = expandHome(strings.TrimSpace(path))
	if !filepath.IsAbs(path) {
		path = filepath.Join(m.opts.CWD, path)
	}
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		m.addError("image: " + path + " is not a readable file")
		return nil
	}
	if info.Size() > maxImageBytes {
		m.addError(fmt.Sprintf("image: %s is larger than %d MB", path, maxImageBytes>>20))
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		m.addError("image: " + err.Error())
		return nil
	}
	mimeType := mime.TypeByExtension(strings.ToLower(filepath.Ext(path)))
	if !strings.HasPrefix(mimeType, "image/") {
		mimeType = http.DetectContentType(data)
	}
	if !strings.HasPrefix(mimeType, "image/") {
		m.addError("image: " + path + " is not a supported image")
		return nil
	}
	if prompt == "" {
		prompt = "Describe this image."
	}

	label := "[image] " + filepath.Base(path)
	if text := strings.TrimSpace(prompt); text != "" && text != "Describe this image." {
		label += "\n" + text
	}
	m.transcript.Add(newBlock(blockUser, label))
	m.transcript.ScrollToBottom()

	image := rpc.Image{
		Type:     "image",
		Data:     base64.StdEncoding.EncodeToString(data),
		MimeType: mimeType,
	}
	return m.sendPromptWithImages(prompt, []rpc.Image{image})
}

func (m *Model) sendPromptWithImages(text string, images []rpc.Image) tea.Cmd {
	client := m.client
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), commandTimeout)
		defer cancel()
		response, err := client.DoOK(ctx, rpc.PromptWithImages(text, images))
		return responseMsg{action: "prompt", resp: response, err: err}
	}
}
