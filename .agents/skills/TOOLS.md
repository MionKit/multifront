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
| `milestone-step` | `.claude/agents/milestone-step.md` | `run-milestone` (step.md) |
| `milestone-qa` | `.claude/agents/milestone-qa.md` | `run-milestone` (qa.md) |
| `public-docs-writer` | `.claude/agents/public-docs-writer.md` | `run-milestone` (docs.md) |

- Claude Code: `Agent` with `subagent_type` set to the role.
- Role missing → spawn `general-purpose` with the body of its definition.
- Fresh context: never pass the author's reasoning or the parent conversation.
- Independent agents unavailable → say so. Never replace the independent pass with one by the author.
- Subagent that cannot start agents → asks its parent to start the independent pass and send back the report.
  (run-milestone does this.)
- Research + planning: Claude's `Explore` or `Plan` agent types where available.

## User-visible background sessions

- Separate from internal agents. User must be able to inspect + steer the new session in their sessions list.
- Claude: the Claude session tools in this session's cloud environment, or a supported local agent-view session.
  Supply the source and the stable revision.
- Codex: an exposed user-visible session API if available. An internal subagent alone does not satisfy this workflow.
- Session API, source support or authorization missing → file the finding as a guidelines todo in the current PR.
  Format: the header of the delegate-finding skill.
- Never claim delegation succeeded until a session exists.
- Record the stable commit, the child session link and the merge-order dependency, as the skill requires.

## Pull requests and CI

- PR creation, metadata, checks: the available GitHub connector or `gh`. Keep literal newlines in PR descriptions.
- Claude may expose `subscribe_pr_activity` → use it when available.
- Else poll the checks with bounded waits, fix failures, verify the latest commit.
- Report missing authentication or monitoring tools. Never report CI as green without checking it.
