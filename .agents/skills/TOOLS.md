# Tools for shared skills

Use the tools the current host exposes. These mappings keep the skill's requirements; they grant no permissions.

## Questions and plan approval

- Claude Code: `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode` when available.
- Codex: `request_user_input`, or ask in chat. Never answer a required question for the user.

## Independent agents

| Role | Claude Code definition | Skill |
| --- | --- | --- |
| `pr-reviewer` | `.claude/agents/pr-reviewer.md` | `review-pr` |
| `comments-simplifier` | `.claude/agents/comments-simplifier.md` | `simplify-comments` |

- Claude Code: `Agent` with `subagent_type` set to the role. If the role is missing, spawn `general-purpose` with the body of its definition.
- Use a fresh context: never pass the author's reasoning or the parent conversation.
- If independent agents are unavailable, say so. Never replace the independent pass with one by the author.
- For research and planning, use Claude's `Explore` or `Plan` agent types where available.

## User-visible background sessions

These are separate from internal agents. The user must be able to inspect and steer the new session in their sessions list.

- Claude: use the available Claude session tools in this session's cloud environment, or a supported local agent-view session. Supply the source and the stable revision.
- Codex: use an exposed user-visible session API if one is available. An internal subagent alone does not satisfy this workflow.
- If the session API, source support or authorization is missing, file the finding as a guidelines todo in the current PR instead (the header of the delegate-finding skill). Never claim delegation succeeded until a session exists.
- Record the stable commit, the child session link and the merge-order dependency, as the skill requires.

## Pull requests and CI

- Use the available GitHub connector or `gh` for PR creation, metadata and checks. Keep literal newlines in PR descriptions.
- Claude may expose `subscribe_pr_activity`; use it when available. Otherwise poll the checks with bounded waits, fix failures and verify the latest commit.
- Report missing authentication or monitoring tools. Never report CI as green without checking it.
