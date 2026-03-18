// Package skills discovers the skills pi loads and edits their
// disable-model-invocation frontmatter without disturbing the rest of the file.
package skills

import (
	"strings"
)

// Frontmatter is the simple key/value form SKILL.md files use.
type Frontmatter struct {
	Values map[string]string
	Body   string
	Has    bool
}

// ParseFrontmatter reads the frontmatter of a SKILL.md file. The subset is
// deliberately small: keys, quoted or block scalars, and booleans.
func ParseFrontmatter(content string) Frontmatter {
	content = strings.TrimPrefix(content, "\uFEFF")
	content = normalizeNewlines(content)
	openEnd, closeStart, _, ok := frontmatterBlock(content)
	if !ok {
		return Frontmatter{Body: content}
	}
	values := map[string]string{}
	lines := strings.Split(content[openEnd:closeStart], "\n")
	for i := 0; i < len(lines); i++ {
		line := lines[i]
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		colon := strings.Index(line, ":")
		if colon < 0 {
			continue
		}
		key := unquote(strings.TrimSpace(line[:colon]))
		value := strings.TrimSpace(line[colon+1:])
		switch value {
		case "|", "|-", "|+", ">", ">-", ">+":
			var block []string
			for i+1 < len(lines) {
				next := lines[i+1]
				if strings.TrimSpace(next) != "" && !strings.HasPrefix(next, " ") && !strings.HasPrefix(next, "\t") {
					break
				}
				block = append(block, strings.TrimSpace(next))
				i++
			}
			separator := "\n"
			if strings.HasPrefix(value, ">") {
				separator = " "
			}
			values[key] = strings.TrimSpace(strings.Join(block, separator))
		default:
			values[key] = unquote(value)
		}
	}
	bodyStart := closeStart + 3
	if strings.HasPrefix(content[bodyStart:], "\n") {
		bodyStart++
	}
	return Frontmatter{Values: values, Body: strings.TrimSpace(content[bodyStart:]), Has: true}
}

func normalizeNewlines(value string) string {
	value = strings.ReplaceAll(value, "\r\n", "\n")
	return strings.ReplaceAll(value, "\r", "\n")
}

func unquote(value string) string {
	if len(value) >= 2 {
		if (value[0] == '"' && value[len(value)-1] == '"') || (value[0] == '\'' && value[len(value)-1] == '\'') {
			return value[1 : len(value)-1]
		}
	}
	return value
}

// frontmatterBlock locates the opening and closing fences. closeStart is the
// index of the closing `---`, so the head is content[openEnd:closeStart].
func frontmatterBlock(content string) (openEnd, closeStart int, newline string, ok bool) {
	start := 0
	if strings.HasPrefix(content, "\uFEFF") {
		start = 1
	}
	if !strings.HasPrefix(content[start:], "---") {
		return 0, 0, "", false
	}
	after := start + 3
	for after < len(content) && (content[after] == ' ' || content[after] == '\t') {
		after++
	}
	switch {
	case strings.HasPrefix(content[after:], "\r\n"):
		newline = "\r\n"
	case strings.HasPrefix(content[after:], "\n"):
		newline = "\n"
	case strings.HasPrefix(content[after:], "\r"):
		newline = "\r"
	default:
		return 0, 0, "", false
	}
	openEnd = after + len(newline)

	searchFrom := openEnd
	for {
		relative := strings.Index(content[searchFrom:], "---")
		if relative < 0 {
			return 0, 0, "", false
		}
		absolute := searchFrom + relative
		if absolute == openEnd || content[absolute-1] == '\n' || content[absolute-1] == '\r' {
			return openEnd, absolute, newline, true
		}
		searchFrom = absolute + 1
	}
}

const disableKey = "disable-model-invocation"

// SetDisableModelInvocation toggles the frontmatter key with a surgical line
// edit. Setting it to false on a skill that has no key leaves the file alone.
func SetDisableModelInvocation(content string, disable bool) (string, error) {
	bom := ""
	if strings.HasPrefix(content, "\uFEFF") {
		bom = "\uFEFF"
		content = content[1:]
	}
	frontmatter := ParseFrontmatter(content)
	hasKey := false
	if _, ok := frontmatter.Values[disableKey]; ok {
		hasKey = true
	}
	if !disable && !hasKey {
		return bom + content, nil
	}

	openEnd, closeStart, newline, hasBlock := frontmatterBlock(content)
	if !hasBlock {
		if !disable {
			return bom + content, nil
		}
		if strings.HasPrefix(content, "---") {
			return "", errUnsupported
		}
		return bom + "---\n" + disableKey + ": true\n---\n" + content, nil
	}

	head := content[openEnd:closeStart]
	if disable {
		if hasKey {
			start, end, found := findKeyLine(head)
			if !found {
				return "", errUnsupported
			}
			colon := strings.Index(head[start:end], ":")
			if colon < 0 {
				return "", errUnsupported
			}
			replaced := head[:start+colon+1] + " true" + head[end:]
			return bom + content[:openEnd] + replaced + content[closeStart:], nil
		}
		return bom + content[:openEnd] + disableKey + ": true" + newline + content[openEnd:], nil
	}

	start, end, found := findKeyLine(head)
	if !found {
		return "", errUnsupported
	}
	// Keep the newline before the key and drop the key's own line break.
	removeStart := start
	if removeStart > 0 && head[removeStart-1] == '\n' {
		removeStart--
		if removeStart > 0 && head[removeStart-1] == '\r' {
			removeStart--
		}
	}
	removeEnd := end
	if strings.HasPrefix(head[removeEnd:], "\r\n") {
		removeEnd += 2
	} else if strings.HasPrefix(head[removeEnd:], "\n") {
		removeEnd++
	}
	return bom + content[:openEnd] + head[:removeStart] + head[removeEnd:] + content[closeStart:], nil
}

type frontmatterError string

func (e frontmatterError) Error() string { return string(e) }

const errUnsupported frontmatterError = "unsupported frontmatter formatting"

// findKeyLine returns the key line's bounds in head, excluding the line break.
func findKeyLine(head string) (start, end int, ok bool) {
	for lineStart := 0; lineStart <= len(head); {
		newlineIndex := strings.IndexByte(head[lineStart:], '\n')
		rawEnd := len(head)
		if newlineIndex >= 0 {
			rawEnd = lineStart + newlineIndex
		}
		lineEnd := rawEnd
		if lineEnd > lineStart && head[lineEnd-1] == '\r' {
			lineEnd--
		}
		line := head[lineStart:lineEnd]
		trimmed := strings.TrimSpace(line)
		colon := strings.Index(trimmed, ":")
		if colon > 0 {
			key := unquote(strings.TrimSpace(trimmed[:colon]))
			if key == disableKey {
				// Map the trimmed key back to its position in the raw line.
				offset := lineStart + strings.Index(line, trimmed)
				return offset, lineEnd, true
			}
		}
		if rawEnd == len(head) {
			break
		}
		lineStart = rawEnd + 1
	}
	return 0, 0, false
}
