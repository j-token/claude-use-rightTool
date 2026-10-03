# use-right-tool

**English** | [한국어](README.ko.md)

A Claude Code plugin that stops Claude from hand-rolling loops, polling, and monitoring in Bash or PowerShell
(`while true; sleep`, `tail -f`, `sleep 60 && cat log`, ...). A PreToolUse hook blocks those commands and tells Claude
which built-in feature to use instead. The judgment is made by TypeSafe's **Jev** model.

| Jev verdict | Foreground | `run_in_background: true` | Suggested feature |
| --- | --- | --- | --- |
| `poll_until_condition` (waits for external state, then exits) | Block | Allow (the officially recommended pattern) | `run_in_background` + `until`, `Monitor` |
| `wait_for_completion` (sleeps, then checks a result) | Block | Allow | `run_in_background` notification |
| `stream_follow` (tail -f, Get-Content -Wait, watch) | Block | Block | `Monitor` |
| `repeat_forever` (interval loop running for a long time, bounded or not) | Block | Block | `Monitor`, `/loop`, `CronCreate` |
| `watch_mode_process` (attached dev server, `--watch`) | Block | Allow | `run_in_background` + `Monitor` |
| `finite_iteration`, `single_action` | Allow | Allow | - |

## How it works

1. **Every** Bash and PowerShell command is checked. A keyword filter would miss workarounds such as `node -e "setTimeout(...)"`, `ping -n 61 127.0.0.1` (a Windows sleep trick), or a `sleep` hidden inside a script file.
2. The hook collects the code the command will **actually execute**, so that Jev judges code instead of names:
   - script files passed to an interpreter (`python`, `node`, `tsx`, `deno`, `bun`, `bash`, `pwsh -File`, `php`, `ruby`, `perl`, `lua`, `go run`, `cmd /c`, ...), scripts run directly (`./runner`, `.\build.ps1`), and `source` / `.`
   - `npm` / `pnpm` / `yarn` / `bun` scripts from `package.json`, and `make` / `just` recipes (with one level of prerequisites)
   - one level of local imports from those scripts (`from lib.helpers import ...`, `require("./util")`)

   A small shell tokenizer handles quotes (including bash `$'...'`), paths with spaces, redirects, heredocs, command substitutions (`$(...)`, backticks), `cd dir &&` (but not a `cd` inside a subshell, in the background, or to a missing directory), `~`, `$PWD`, and Git Bash drive paths (`/c/...`). Files that a command only views, writes, formats, lints, copies, or commits (`cat x.py`, `code x.py`, `black x.py`, `cat > x.sh <<EOF`, `git commit -m "x.py"`) are **not** read, and neither are files behind options that do not run them (`python -c`, `node --check`, `php -l`, `--help`, `make -n`).
3. Short code is sent whole. For long code and very long commands, the hook sends the first and last parts plus every line that looks loop-related, so a loop in the middle of a file is still visible.
4. A single Choice question classifies what the command will do over time. If the combined probability of the blocked categories is at or above the threshold (default 0.6), the hook returns `permissionDecision: "deny"` with an English message telling Claude which feature to use instead. Within ±0.15 of the threshold, it asks Jev a second time and averages the two answers, because answers to identical input vary by about ±0.05–0.1.
5. If the API key is missing, the Jev request fails, or the hook runs past its 12-second deadline, the command is allowed (fail-open) so your work is never stuck.

Cost: about 1,800 input tokens per plain command and up to about 3,400 with long source code, so $0.00008–0.00014 at Jev 1.13 pricing ($0.042 per million tokens). The whole hook adds about 400–500 ms, and about twice the Jev time in the rare borderline cases.

Example message Claude receives:

```
[use-right-tool] Blocked: this command was not run. (Jev verdict: stream_follow, p=1.00)
This command follows a log or output stream continuously (tail -f, Get-Content -Wait, watch, ...).
- Use the `Monitor` tool. Filter with `grep --line-buffered` so that only the lines you would act on, both success and failure signals, become events.
```

## What gets sent to TypeSafe

- The command, the `description` Claude wrote for it, and the code it executes (see above).
- Only files inside the session's working directory or `CLAUDE_PROJECT_DIR` are read. Files outside the project, network paths (`\\server\share`), and binary files are only mentioned by name, with a note that they were not read.
- Reads are bounded: up to 5 sources, the first and last 64 KB of large files, and at most 40 file checks per command.
- Common secret shapes are replaced with `<redacted>` in everything sent and logged, including source paths, the bypass reason, and API error messages: `KEY=value`-style assignments of keys, tokens, and passwords (quoted or not); `Authorization` headers; credentials in URLs; private-key blocks; and tokens with well-known prefixes (`sk-`, `ghp_`, `AKIA`, `xox*-`, JWTs). Values that look like code (`token = getToken()`) are left alone so loops stay visible. This is a safety net, not a guarantee.
- Malformed responses from the API (unknown categories, probabilities outside 0–1, or a total far from 1) are treated as errors and allow the command.

## Installation

```
/plugin marketplace add j-token/claude-use-rightTool
/plugin install use-right-tool@use-right-tool
```

Requires Node.js 18 or later and the `TYPESAFE_API_KEY` environment variable.

## Configuration (environment variables)

| Variable | Default | Description |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | (required) | TypeSafe API key |
| `USE_RIGHT_TOOL_THRESHOLD` | `0.6` | Probability threshold for blocking, in (0, 1]. Invalid values fall back to 0.6 with a warning. |
| `USE_RIGHT_TOOL_MODEL` | `jev-1.13.0` | The threshold and criteria were tuned on this version. Rerun `node test/cases.mjs` before switching (for example to `jev-latest`). |
| `USE_RIGHT_TOOL_LOG` | (unset) | When set, verdicts and bypasses are appended to this file as JSONL (with secrets redacted) |
| `USE_RIGHT_TOOL_PREFILTER` | (unset) | Set to `1` to call Jev only when the command or the code it runs contains a hint such as `while`, `sleep`, `setTimeout`, `tail -f`, `-Wait`, or `--watch`. Cheaper and faster, but obfuscated workarounds can slip through. |
| `USE_RIGHT_TOOL_ENDPOINT` | TypeSafe API | Override the API URL (used by the offline tests) |

## Bypass

If a command is blocked by mistake, re-run it with a trailing comment that gives a reason:

```
for i in 1 2 3; do curl -sf https://example.com && break; sleep 5; done # use-right-tool:allow: three fixed retries
```

The marker counts only as a real shell comment (not inside quotes, arguments, or URLs) and only with a reason after the colon. Every bypass is logged when `USE_RIGHT_TOOL_LOG` is set. The block message mentions the bypass only when the verdict is uncertain (p < 0.9).

## Testing

```
node --test test/unit.test.mjs   # offline, 78 tests: tokenizer, source collection, redaction, policy, hook I/O (stub server, no API key)
node test/cases.mjs              # live: 58 commands (31 to block, 27 to allow) through the real Jev model
```

The live cases include the red-team findings: loops hidden in scripts with neutral names, npm scripts, make targets, imports, long files, bounded loops that act as schedulers, small retry loops, and commands that only view or write loop code. Fixtures live in `test/fixtures/`.

## Limitations

- The hook does not follow imports more than one level deep, code loaded at run time (`exec(open(...).read())`, `curl ... | sh`), or task runners other than npm/pnpm/yarn/bun/make/just.
- The tokenizer is an approximation, not a full shell parser. Scripts inside function definitions (`f() { python x.py; }`), scriptblocks assigned to a variable (`$s = { python x.py }`), or branches that cannot run (`false && python x.py`) are treated as if they run, so their code is read and sent.
- The 12-second deadline cannot interrupt synchronous file reads. Network paths are skipped and reads are bounded, so this should only matter on an unusually slow local disk.
- Some waits are a judgment call and are blocked in the foreground, for example `kubectl wait`, `kubectl rollout status`, and `sleep 2 && curl ...`. Use `run_in_background: true` or the bypass comment.
- The plugin is a workflow guide for Claude, not a security boundary. It fails open, and the bypass is available to Claude.
