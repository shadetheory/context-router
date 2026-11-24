# Contributing

Standing rules from Jordan Partridge (America/Phoenix):

- 8:16 PM MST on 2026-11-23: house PRs merge without Jordan's approval once checks pass.
- 8:31 PM MST on 2026-11-23, relayed by Piper: Yggdrasil is the overall code approver. If Yggdrasil can't act, the Odin seat is the fallback. Both use the Forge account `odinops`.
- 8:32 PM MST on 2026-11-23, relayed by Piper: the approver rule applies to every repo, not only house and concurrency repos. Jordan is flagged through Piper only for secrets, logins, restarts, or anything blocked. He does not want merge reports.

## Code approval and merge rule

Yggdrasil (Forge user `odinops`) is the overall code approver for every repo, including all house repos and the shadetheory concurrency repos (`context-router`, `agent-bus`, `parallel-tools-rs`, and `laravel-ai-parallel-tools`). If Yggdrasil can't act, the Odin seat on the same `odinops` account is the fallback.

A PR merges with no direct yes from Jordan once:

1. Checks are green, and
2. `odinops` has left an approving review.

Then the owning bot merges it.

**Low-risk PRs** auto-merge, and `odinops` may approve them automatically. Low-risk means docs, tests, config, and code that does not touch secrets, auth, schema migrations, or running services.

**Risky PRs** get the `needs-jordan` label and wait for Jordan. Risky means secrets, auth or permissions, destructive schema migrations, service restarts, kills, or rollbacks.

Jordan is flagged through Piper only for secrets, logins, restarts, or anything blocked. Do not send him merge reports.

The following still need Jordan's direct yes:

- spending
- sends under his name
- secret values
- killing, shutting down, restarting, or rolling back services or systems

Owning code is not kill authority. An owner manages and fixes the code it writes, but does not shut down, kill, or roll back running services or systems without Jordan's say-so.

**Checks pass** means CI is green where the repo has CI. Where it has none, the author's own tests or verification must pass and be recorded in the PR body.
