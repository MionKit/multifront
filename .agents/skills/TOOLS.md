# Tools for shared skills

Use the tools the current host exposes. These mappings keep the skill's requirements; they grant no permissions.

## Questions and plan approval

- Claude Code: `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode` when available.
- Codex: `request_user_input`, or ask in chat. Never answer a required question for the user.

## Independent agents

| Role | Claude Code definition | Skill |
| --- | --- | --- |
| `comments-simplifier` | `.claude/agents/comments-simplifier.md` | `simplify-comments` |

- Claude Code: `Agent` with `subagent_type` set to the role. If the role is missing, spawn `general-purpose` with the body of its definition.
- Use a fresh context: never pass the author's reasoning or the parent conversation.
- If independent agents are unavailable, say so. Never replace the independent pass with one by the author.
