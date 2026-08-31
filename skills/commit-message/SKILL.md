---
name: commit-message
description: Writes git commit messages. Use when committing changes, creating a commit, or when the user asks to save or commit their work.
---

When writing a commit message:

1. Run `git diff --staged` to review exactly what is being committed
2. Write a commit message following this format:

**Subject line:**
- Under 50 characters
- Present tense, specific action (e.g. "Add goal-aware EV threshold to scatter chart")
- Completes the sentence "This commit will..."
- Never use vague terms like "fix", "updates", "WIP", or "changes"

**Body (always include):**
- Blank line after subject
- Explain what changed and why, not just what the code does
- Be descriptive — prefer more detail over less
- If switching tools or approaches, explain the reasoning (e.g. "Switch from Opus to Sonnet — equivalent quality at lower latency and cost")
- Avoid messages that only describe timing like "before next feature" or "end of session"

**Co-author line (always include):**
- Add `Co-Authored-By: Claude <noreply@anthropic.com>` at the end