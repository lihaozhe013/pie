package config

// ReadInstructions reads the global AGENTS.md. A missing file reads as empty.
func ReadInstructions(paths Paths) (string, error) {
	return ReadText(paths.Agents())
}

// WriteInstructions replaces the global AGENTS.md atomically.
func WriteInstructions(paths Paths, text string) error {
	return WriteText(paths.Agents(), text)
}
