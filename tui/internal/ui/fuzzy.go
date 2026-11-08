package ui

import (
	"sort"
	"strings"
	"unicode"
)

// fuzzyScore reports whether query appears in text as a case-insensitive
// subsequence and returns a relevance score. A negative score means no match.
// Contiguous runs at word boundaries rank highest, so a short acronym still
// prefers a real label over a scattered match in a long help line.
func fuzzyScore(query, text string) int {
	q := []rune(strings.ToLower(query))
	t := []rune(strings.ToLower(text))
	if len(q) == 0 {
		return 0
	}
	if len(q) > len(t) {
		return -1
	}

	best := -1
	// Starting from every occurrence of the first rune lets a later, tighter
	// run win over an earlier scattered one without a quadratic search.
	for start := 0; start < len(t); start++ {
		if t[start] != q[0] {
			continue
		}
		if score, ok := fuzzyScoreFrom(q, t, start); ok && score > best {
			best = score
		}
	}
	return best
}

func fuzzyScoreFrom(q, t []rune, start int) (int, bool) {
	score := 16
	if start == 0 || !isWordRune(t[start-1]) {
		score += 10
	}
	if start == 0 {
		score += 12
	}

	prev := start
	pos := start
	for i := 1; i < len(q); i++ {
		pos++
		for pos < len(t) && t[pos] != q[i] {
			pos++
		}
		if pos == len(t) {
			return 0, false
		}

		score += 12
		if pos == prev+1 {
			score += 9
		} else if gap := pos - prev - 1; gap > 0 {
			score -= minInt(5, gap)
			if gap > 4 {
				score -= 4
			}
		}
		if !isWordRune(t[pos-1]) {
			score += 14
		}
		prev = pos
	}

	if start == 0 && len(q) == len(t) {
		score += 40
	}
	return score, true
}

// substringScore rates a literal substring match. Subsequences use fuzzyScore;
// keeping these separate stops a scattered match in a help paragraph from
// outranking a contiguous one.
func substringScore(query, text string) int {
	q := strings.ToLower(query)
	lower := strings.ToLower(text)
	if q == "" {
		return 0
	}
	byteIndex := strings.Index(lower, q)
	if byteIndex < 0 {
		return -1
	}
	runes := []rune(lower)
	index := len([]rune(lower[:byteIndex]))
	length := len([]rune(q))
	score := 100 + length*5
	if index == 0 || !isWordRune(runes[index-1]) {
		score += 35
	}
	score -= minInt(15, index/8)
	return score
}

func isWordRune(r rune) bool {
	return unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_'
}

// fuzzyFilterItems filters and ranks picker rows. A term that appears in the
// label always beats the same term found only in the keywords, then the fuzzy
// score decides the order. Original order breaks ties.
func fuzzyFilterItems(items []pickerItem, query string) []pickerItem {
	terms := strings.Fields(strings.ToLower(strings.TrimSpace(query)))
	if len(terms) == 0 {
		return append([]pickerItem(nil), items...)
	}

	type ranked struct {
		item  pickerItem
		score int
	}
	matches := make([]ranked, 0, len(items))
	for _, item := range items {
		score, ok := fuzzyPickerScore(terms, item)
		if !ok {
			continue
		}
		matches = append(matches, ranked{item: item, score: score})
	}
	sort.SliceStable(matches, func(i, j int) bool {
		return matches[i].score > matches[j].score
	})

	filtered := make([]pickerItem, len(matches))
	for i, match := range matches {
		filtered[i] = match.item
	}
	return filtered
}

func fuzzyPickerScore(terms []string, item pickerItem) (int, bool) {
	label := strings.ToLower(item.Label)
	keywords := strings.ToLower(item.Keywords + " " + item.Detail)
	total := 0
	for _, term := range terms {
		if score := fuzzyScore(term, label); score >= 0 {
			total += 1000 + score
			continue
		}
		score := substringScore(term, keywords)
		if score < 0 {
			return 0, false
		}
		total += score
	}
	return total, true
}
