package session

import "encoding/json"

// Goal entry types written by the goal packages Pie supports.
const (
	GoalEntryType       = "pi-better-goal"
	LegacyGoalEntryType = "pi-codex-goal"
)

// Goal is what the goal package last said about the session's goal.
type Goal struct {
	ID          string
	Status      string
	Objective   string
	TokensUsed  int64
	HasTokens   bool
	TokenBudget *int64
}

// ReadGoal returns the newest goal on the branch. A clear record retracts it,
// and an unreadable record says nothing rather than guessing.
func ReadGoal(entries []LogEntry) (Goal, bool) {
	for i := len(entries) - 1; i >= 0; i-- {
		entry := entries[i]
		if entry.Type != "custom" {
			continue
		}
		if entry.CustomType != GoalEntryType && entry.CustomType != LegacyGoalEntryType {
			continue
		}
		var data struct {
			Version int    `json:"version"`
			Kind    string `json:"kind"`
			Goal    struct {
				GoalID      string `json:"goalId"`
				Objective   string `json:"objective"`
				Status      string `json:"status"`
				TokenBudget *int64 `json:"tokenBudget"`
				Usage       struct {
					TokensUsed *int64 `json:"tokensUsed"`
				} `json:"usage"`
			} `json:"goal"`
		}
		if err := json.Unmarshal(entry.Data, &data); err != nil {
			continue
		}
		switch data.Kind {
		case "clear":
			return Goal{}, false
		case "set":
			if data.Goal.Status == "" {
				continue
			}
			goal := Goal{
				ID:          data.Goal.GoalID,
				Status:      data.Goal.Status,
				Objective:   data.Goal.Objective,
				TokenBudget: data.Goal.TokenBudget,
			}
			if data.Goal.Usage.TokensUsed != nil {
				goal.TokensUsed = *data.Goal.Usage.TokensUsed
				goal.HasTokens = true
			}
			return goal, true
		}
	}
	return Goal{}, false
}

// GoalPhase maps a package status to the three states the UI shows. A word
// this client does not know still means the goal exists, so it waits.
func GoalPhase(status string) string {
	switch status {
	case "complete":
		return "done"
	case "active":
		return "running"
	default:
		return "waiting"
	}
}
