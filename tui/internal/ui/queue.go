package ui

import (
	"fmt"
	"strings"
)

// maxQueuedPreviews caps the staged messages drawn above the composer. The
// header still reports the complete count; the queue itself lives in pi.
const maxQueuedPreviews = 3

// queuedPreview is one staged steering or follow-up message.
type queuedPreview struct {
	kind string
	text string
}

// queuedPreviews lists the staged messages in delivery order: steering first,
// then follow-ups, matching the order of pi's queue_update payload.
func (m *Model) queuedPreviews() []queuedPreview {
	previews := make([]queuedPreview, 0, len(m.queue.Steering)+len(m.queue.FollowUp))
	for _, text := range m.queue.Steering {
		previews = append(previews, queuedPreview{kind: "steer", text: text})
	}
	for _, text := range m.queue.FollowUp {
		previews = append(previews, queuedPreview{kind: "follow-up", text: text})
	}
	return previews
}

// queueRows is the height the staged panel reserves in the frame. Very short
// terminals keep only the count row so the editor and one transcript row still
// fit.
func (m *Model) queueRows() int {
	count := len(m.queuedPreviews())
	if count == 0 {
		return 0
	}
	rows := 1 + minInt(count, maxQueuedPreviews)
	if limit := m.height - 6 - m.activityRows(); rows > limit {
		rows = limit
	}
	if rows < 0 {
		return 0
	}
	return rows
}

// renderQueue draws the staged messages above the composer. A message joins
// the transcript only when pi delivers it, so this panel is the only place a
// queued steer or follow-up appears before then.
func (m *Model) renderQueue() []string {
	previews := m.queuedPreviews()
	rows := m.queueRows()
	if len(previews) == 0 || rows == 0 {
		return nil
	}

	width := m.frameWidth()
	lines := make([]string, 0, rows)
	lines = append(lines, m.styles.notice.Render(fmt.Sprintf("%d queued", len(previews))))
	for i := 0; i < len(previews) && i < rows-1; i++ {
		preview := previews[i]
		label := preview.kind
		labelStyle := m.styles.accent
		if preview.kind != "steer" {
			labelStyle = m.styles.muted
		}
		// The message column starts after the longest label plus a gap.
		prefix := "  " + labelStyle.Render(label) + strings.Repeat(" ", 10-len(label))
		text := strings.Join(strings.Fields(preview.text), " ")
		lines = append(lines, truncateLine(prefix+m.styles.userText.Render(text), width))
	}
	return lines
}
