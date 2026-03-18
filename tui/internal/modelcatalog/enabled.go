package modelcatalog

import (
	"regexp"
	"sort"
	"strings"

	"github.com/lihaozhe013/pie/tui/internal/config"
)

// Resolution is how one enabledModels pattern resolves against the catalog.
type Resolution struct {
	Pattern string
	Matched []string
	Pin     string
}

// EnabledSet resolves enabledModels. hasPatterns false means every model is
// enabled. Pins maps a reference to the thinking level its pattern fixes.
func EnabledSet(patterns []string, patternsSet bool, models []*Model) (enabled map[string]bool, pins map[string]string, resolutions []Resolution) {
	enabled = make(map[string]bool, len(models))
	pins = map[string]string{}
	for _, model := range models {
		enabled[model.Ref()] = false
	}
	if !patternsSet {
		for _, model := range models {
			enabled[model.Ref()] = true
		}
		return enabled, pins, nil
	}
	for _, pattern := range patterns {
		base, pin := splitPin(pattern)
		resolution := Resolution{Pattern: pattern, Pin: pin}
		for _, model := range matchPattern(base, models) {
			resolution.Matched = append(resolution.Matched, model.Ref())
			enabled[model.Ref()] = true
			if pin != "" {
				pins[model.Ref()] = pin
			}
		}
		resolutions = append(resolutions, resolution)
	}
	return enabled, pins, resolutions
}

// StalePatterns lists configured patterns that match no model in the catalog.
func StalePatterns(resolutions []Resolution) []string {
	var stale []string
	for _, resolution := range resolutions {
		if len(resolution.Matched) == 0 {
			stale = append(stale, resolution.Pattern)
		}
	}
	return stale
}

// SetEnabled turns one model on or off with a minimal edit of the pattern list,
// the same policy pie follows: a pattern that covers the model is expanded in
// place, and unmatched patterns are never touched.
func SetEnabled(patterns []string, patternsSet bool, models []*Model, ref string, on bool) ([]string, bool) {
	enabled, pins, resolutions := EnabledSet(patterns, patternsSet, models)
	if on == enabled[ref] {
		return patterns, patternsSet
	}

	if on {
		if !patternsSet {
			return patterns, true
		}
		next := append([]string(nil), patterns...)
		entry := ref
		if pin := pins[ref]; pin != "" {
			entry += ":" + pin
		}
		return append(next, entry), true
	}

	if !patternsSet {
		// Materialize "everything" as explicit references, then drop one.
		out := make([]string, 0, len(models))
		for _, model := range models {
			if model.Ref() == ref {
				continue
			}
			out = append(out, model.Ref())
		}
		return out, true
	}

	next := make([]string, 0, len(patterns)+4)
	for _, resolution := range resolutions {
		contains := false
		for _, matched := range resolution.Matched {
			if matched == ref {
				contains = true
				break
			}
		}
		if !contains {
			next = append(next, resolution.Pattern)
			continue
		}
		// Expand in place: every other model the pattern covered keeps its pin.
		for _, matched := range resolution.Matched {
			if matched == ref {
				continue
			}
			entry := matched
			if resolution.Pin != "" {
				entry += ":" + resolution.Pin
			}
			next = append(next, entry)
		}
	}
	return next, true
}

// SetAllEnabled returns the pattern list for "every model on": no patterns.
func SetAllEnabled() ([]string, bool) { return nil, false }

// SetAllDisabled returns one kept reference, because pi needs a model to start.
func SetAllDisabled(models []*Model) ([]string, bool) {
	if len(models) == 0 {
		return []string{}, true
	}
	return []string{models[0].Ref()}, true
}

func splitPin(pattern string) (string, string) {
	index := strings.LastIndex(pattern, ":")
	if index <= 0 || index == len(pattern)-1 {
		return pattern, ""
	}
	level := pattern[index+1:]
	if !config.IsThinkingLevel(level) {
		return pattern, ""
	}
	return pattern[:index], level
}

// matchPattern resolves one enabledModels pattern the way pi's model scope
// does: an exact provider/id or bare id wins, a glob uses minimatch syntax
// where * does not cross "/", and anything else falls back to a case-
// insensitive substring search that keeps pi's best match.
func matchPattern(pattern string, models []*Model) []*Model {
	text := strings.ToLower(strings.TrimSpace(pattern))
	if text == "" {
		return nil
	}
	provider, rest := splitProviderPrefix(text, models)

	exact := make([]*Model, 0, 1)
	for _, model := range models {
		if provider != "" && !strings.EqualFold(model.ProviderID, provider) {
			continue
		}
		id := model.ID
		if provider != "" {
			if strings.EqualFold(id, rest) {
				exact = append(exact, model)
			}
			continue
		}
		if strings.EqualFold(model.Ref(), text) || strings.EqualFold(id, text) {
			exact = append(exact, model)
		}
	}
	if len(exact) > 0 {
		return exact
	}

	if strings.ContainsAny(text, "*?[") {
		return globMatches(text, provider, models)
	}

	var fuzzy []*Model
	for _, model := range models {
		if provider != "" && !strings.EqualFold(model.ProviderID, provider) {
			continue
		}
		query := text
		if provider != "" {
			query = rest
		}
		if strings.Contains(strings.ToLower(model.ID), query) ||
			(model.Name != "" && strings.Contains(strings.ToLower(model.Name), query)) {
			fuzzy = append(fuzzy, model)
		}
	}
	return bestFuzzyMatches(fuzzy)
}

// splitProviderPrefix finds the longest known provider id followed by "/".
func splitProviderPrefix(text string, models []*Model) (provider, rest string) {
	best := ""
	for _, model := range models {
		id := strings.ToLower(model.ProviderID)
		if id == "" || len(id) >= len(text) || len(id) <= len(best) {
			continue
		}
		if strings.HasPrefix(text, id+"/") && len(text) > len(id)+1 {
			best = id
		}
	}
	if best == "" {
		return "", text
	}
	return best, text[len(best)+1:]
}

// globMatches applies minimatch's shape: * and ? stay inside one path segment,
// ** crosses slashes, and character classes pass through.
func globMatches(pattern, provider string, models []*Model) []*Model {
	glob := pattern
	if provider != "" {
		glob = strings.TrimPrefix(pattern, provider+"/")
	}
	expression, err := globRegexp(glob)
	if err != nil {
		return nil
	}
	matches := make([]*Model, 0, len(models))
	for _, model := range models {
		if provider != "" && !strings.EqualFold(model.ProviderID, provider) {
			continue
		}
		if expression.MatchString(strings.ToLower(model.ID)) {
			matches = append(matches, model)
			continue
		}
		if provider == "" && expression.MatchString(strings.ToLower(model.Ref())) {
			matches = append(matches, model)
		}
	}
	return matches
}

func globRegexp(pattern string) (*regexp.Regexp, error) {
	var b strings.Builder
	b.WriteString("(?i)^")
	for i := 0; i < len(pattern); i++ {
		switch c := pattern[i]; c {
		case '*':
			if i+1 < len(pattern) && pattern[i+1] == '*' {
				b.WriteString(".*")
				i++
			} else {
				b.WriteString("[^/]*")
			}
		case '?':
			b.WriteString("[^/]")
		case '[':
			end := i + 1
			if end < len(pattern) && (pattern[end] == '!' || pattern[end] == '^') {
				end++
			}
			for end < len(pattern) && pattern[end] != ']' {
				end++
			}
			if end < len(pattern) {
				b.WriteString(pattern[i : end+1])
				i = end
			} else {
				b.WriteString("\\[")
			}
		case '.', '+', '(', ')', '|', '^', '$', '{', '}', '\\':
			b.WriteByte('\\')
			b.WriteByte(c)
		default:
			b.WriteByte(c)
		}
	}
	b.WriteString("$")
	return regexp.Compile(b.String())
}

// bestFuzzyMatches picks aliases first and then the lexicographically largest
// id, then keeps every provider that carries that id, as pi does.
func bestFuzzyMatches(matches []*Model) []*Model {
	if len(matches) == 0 {
		return nil
	}
	pool := matches
	aliases := make([]*Model, 0, len(matches))
	for _, model := range matches {
		if isAlias(model.ID) {
			aliases = append(aliases, model)
		}
	}
	if len(aliases) > 0 {
		pool = aliases
	}
	best := pool[0]
	for _, model := range pool[1:] {
		if strings.ToLower(model.ID) > strings.ToLower(best.ID) {
			best = model
		}
	}
	tied := make([]*Model, 0, 1)
	for _, model := range matches {
		if model.ID == best.ID {
			tied = append(tied, model)
		}
	}
	return tied
}

func isAlias(id string) bool {
	if strings.HasSuffix(id, "-latest") {
		return true
	}
	if len(id) < 9 {
		return true
	}
	// A date-suffixed snapshot is not an alias.
	suffix := id[len(id)-9:]
	if suffix[0] != '-' {
		return true
	}
	for _, c := range suffix[1:] {
		if c < '0' || c > '9' {
			return true
		}
	}
	return false
}

// EnabledRefs returns enabled references in catalog order.
func EnabledRefs(models []*Model, enabled map[string]bool) []string {
	refs := make([]string, 0, len(enabled))
	for _, model := range models {
		if enabled[model.Ref()] {
			refs = append(refs, model.Ref())
		}
	}
	return refs
}

// SortRefs orders references by provider then model id.
func SortRefs(refs []string) []string {
	sorted := append([]string(nil), refs...)
	sort.Strings(sorted)
	return sorted
}
