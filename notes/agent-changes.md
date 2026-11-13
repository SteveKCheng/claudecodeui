# Fork agent changes: launching claude through CLAUDE_CLI_PATH

Changes this fork makes to how CloudCLI starts agents, and how to keep
them when merging an upstream release.

We merge upstream release tags into `main`; we don't rebase. These commit
hashes therefore stay valid, and `git show <hash>` gives the exact change
and its reasoning.

## Why

Each agent runs in a bwrap sandbox. `CLAUDE_CLI_PATH` points at
`~/bin/inner-claude`, a launcher that sets up the sandbox for the
workspace and then runs the read-only `claude` binary from `/opt/claude`
(see `distribution.md`). The sandbox hides CloudCLI's socket, database and
`~/.cloudcli` from the agent, and blocks ptrace and `/proc` access to
CloudCLI (see `server-changes.md` for the deployment).

That isolation only holds if every way CloudCLI starts `claude` goes
through `CLAUDE_CLI_PATH`. A bare `claude` from `PATH` runs unsandboxed,
with CloudCLI's own access.

## Commits

| Commit | Change |
|---|---|
| `1b6ac460` fix(shell): launch claude through CLAUDE_CLI_PATH in the Shell tab | Chat runs already used `CLAUDE_CLI_PATH`, but the Shell tab ran a bare `claude`. It now uses the configured executable, quoted, and run via `&` on PowerShell, for new, resumed and bypass-permissions launches. It does the same for a caller's command that starts the CLI, such as the login button's `claude --dangerously-skip-permissions /login`. Other commands, including `claudette`, are left alone. Without `CLAUDE_CLI_PATH`, launches are unchanged. |

The same commit changed how the light theme is passed. A light Shell tab
used to pass its theme as `--settings <file under ~/.cloudcli>`. The
sandbox hides that directory, and the CLI refuses to start when the
settings file is missing. bash launches now pass inline JSON
(`--settings '{"theme":"light"}'`) and write no file. PowerShell keeps
the file, because it strips the double quotes from inline JSON.

## Where the code lives

`server/modules/websocket/services/shell-websocket.service.ts`, upstream's
file:

- **`getClaudeLaunchCommand()`** (ours): `CLAUDE_CLI_PATH`, resolved by
  `resolveClaudeCodeExecutablePath()` and quoted, or `claude` when unset.
- **`withConfiguredClaude(command)`** (ours): rewrites a leading `claude`
  word, and nothing else.
- **`buildShellCommand()`**: the plain-shell, resume, caller-command and
  default branches use the two functions above instead of the literal
  `claude`.
- **`buildClaudeThemeLaunch()`**: non-win32 platforms return the inline
  JSON flag before the settings-file path runs.
- **Tests:** `server/modules/websocket/tests/shell-websocket.service.test.ts`.

Upstream already routes everything else that starts Claude through
`resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH)`:

| File | What it starts |
|---|---|
| `claude-runtime.provider.ts` | chat runs (`pathToClaudeCodeExecutable`) |
| `claude-side-question.provider.ts` | side questions (new in v1.37.8) |
| `claude-auth.provider.ts` | auth status |
| `provider-cli.service.ts` | version and update |

The first three are under `server/modules/providers/list/claude/`; the
last is under `server/modules/providers/services/`.

## Resolving conflicts

- **Upstream changes `buildShellCommand()`** (new providers, new launch
  flags, new resume logic): take their structure. Then make sure every
  string that starts the Claude CLI begins with `${claude}` (from
  `getClaudeLaunchCommand()`), and that caller commands pass through
  `withConfiguredClaude()`.
- **Upstream changes the theme launch:** keep inline JSON for
  non-Windows. Any new `--settings <path>`, `--mcp-config <path>` or
  similar pointing into `~/.cloudcli` will fail inside the sandbox in the
  same way. Prefer inline values, or a path the sandbox can see.
- **Upstream fixes the Shell tab themselves:** compare with ours and drop
  ours if theirs covers bash, resume and the login command.

## Checks after a merge

Look for new code that starts `claude` without going through
`CLAUDE_CLI_PATH`:

```sh
# Every place that resolves the executable (expect the five files above, plus claude-cli-path.ts):
grep -rln "resolveClaudeCodeExecutablePath" server --include=*.ts | grep -v /tests/
# Literal launches: spawn/exec of "claude", or command strings that start with it.
# As of v1.37.8 this matches only comments:
grep -rnE "(spawn|exec|execFile)[A-Za-z]*\(\s*['\"]claude['\"]|['\"\`]claude (--|/|\\$)" server --include=*.ts | grep -v /tests/
```

Also check new SDK runtime imports. Every `query` call must pass
`pathToClaudeCodeExecutable`. Without it, the SDK runs its own bundled
binary. Our install deletes that binary, so the call fails rather than
running outside the sandbox, but it is still broken.

```sh
grep -rn "from '@anthropic-ai/claude-agent-sdk'" server --include=*.ts | grep -v /tests/ | grep -v "import type"
grep -rn "pathToClaudeCodeExecutable" server --include=*.ts | grep -v /tests/
```

As of v1.37.8, the first command finds `query` in
`claude-runtime.provider.ts` and `claude-side-question.provider.ts`, and
the second finds both. It also finds `forkSession` in
`claude-fork.provider.ts`, which rewrites session files and doesn't start
the CLI.

Then, in the deployed instance:

1. Open a Shell tab, start Claude, and ask it to list `~/.cloudcli` and
   the directory holding CloudCLI's socket. If it can't see either, it is
   running inside the sandbox.
2. Do the same for a chat session and a side question.
