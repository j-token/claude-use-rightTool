# use-right-tool

**English** | [한국어](README.ko.md)

A Claude Code plugin that stops Claude from hand-rolling loops, polling, and monitoring in Bash or PowerShell
(`while true; sleep`, `tail -f`, `sleep 60 && cat log`, ...). A PreToolUse hook blocks those commands and tells Claude
which built-in feature to use instead. The judgment is made by TypeSafe's **Jev** model.
Commands that write, edit, or search files from the shell (`cat > x.py <<EOF`, `sed -i`, `python - <<EOF` that rewrites a file,
`grep -rn`) are also blocked, without calling Jev, and Claude is pointed to the `Write`, `Edit`, `Grep`, and `Glob` tools. Viewing files (`cat`, `head`, `sed -n`) is allowed.

| Tool rule (no Jev call) | Examples | Suggested tool |
| --- | --- | --- |
| `write` | `cat > f <<EOF`, `echo ... > f`, `printf > f`, `tee f <<EOF`, `Set-Content`, `"text" > f`, `[IO.File]::WriteAllText` | `Write`, `Edit` |
| `edit` | `sed -i`, `perl -pi`, inline scripts that write files (`python - <<EOF ... open(p,'w')`, `node -e "fs.writeFileSync(...)"`) | `Edit`, `Write` |
| `search` | the whole command only searches: `grep -rn x src`, `rg x`, `find . -name`, `Select-String`, `ls -R`, `Get-ChildItem -Recurse` | `Grep`, `Glob` |

Filtering or saving another command's output (`git log \| head`, `npm test > out.log`, `git commit -m "$(cat <<'EOF' ...)"`) is not blocked.

| Jev verdict | Foreground | `run_in_background: true` | Suggested feature |
| --- | --- | --- | --- |
| `poll_until_condition` (waits for external state, then exits) | Block | Allow (the officially recommended pattern) | `run_in_background` + `until`, `Monitor` |
| `wait_for_completion` (sleeps, then checks a result) | Block | Allow | `run_in_background` notification |
| `stream_follow` (tail -f, Get-Content -Wait, watch) | Block | Block | `Monitor` |
| `repeat_forever` (interval loop running for a long time, bounded or not) | Block | Block | `Monitor`, `/loop`, `CronCreate` |
| `watch_mode_process` (attached dev server, `--watch`) | Block | Allow | `run_in_background` + `Monitor` |
| `finite_iteration`, `single_action` | Allow | Allow | - |

## How it works

0. The hook first decides from the shape of the command alone (no Jev call, works without an API key).
   - Commands that match a tool rule above are blocked right away.
   - Commands made only of programs that cannot loop or wait (`git` subcommands that do not prompt or run other commands, `ls`, `mkdir`, `cp`, `rm`, `wc`, `Get-ChildItem`, ..., excluding forms such as `tail -f`, `find -exec`, `timeout`, `nohup`, and PowerShell loops) are allowed without asking Jev. Commands that run a script always go to Jev.
1. **Every** other Bash and PowerShell command is checked by Jev. A keyword filter would miss workarounds such as `node -e "setTimeout(...)"`, `ping -n 61 127.0.0.1` (a Windows sleep trick), or a `sleep` hidden inside a script file.
2. The hook collects the code the command will **actually execute**, so that Jev judges code instead of names:
   - script files passed to an interpreter (`python`, `node`, `tsx`, `deno`, `bun`, `bash`, `pwsh -File`, `php`, `ruby`, `perl`, `lua`, `go run`, `cmd /c`, ...), scripts run directly (`./runner`, `.\build.ps1`), and `source` / `.`
   - `npm` / `pnpm` / `yarn` / `bun` scripts from `package.json`, and `make` / `just` recipes (with one level of prerequisites)
   - one level of local imports from those scripts (`from lib.helpers import ...`, `require("./util")`)

   A small shell tokenizer handles quotes (including bash `$'...'`), paths with spaces, redirects, heredocs, command substitutions (`$(...)`, backticks), `cd dir &&` (but not a `cd` inside a subshell, in the background, or to a missing directory), `~`, `$PWD`, and Git Bash drive paths (`/c/...`). Files that a command only views, writes, formats, lints, copies, or commits (`cat x.py`, `code x.py`, `black x.py`, `cat > x.sh <<EOF`, `git commit -m "x.py"`) are **not** read, and neither are files behind options that do not run them (`python -c`, `node --check`, `php -l`, `--help`, `make -n`).
3. Short code is sent whole. For long code and very long commands, the hook sends the first and last parts plus every line that looks loop-related, so a loop in the middle of a file is still visible.
4. A single Choice question classifies what the command will do over time. If the combined probability of the blocked categories is at or above the threshold (default 0.6), the hook returns `permissionDecision: "deny"` with an English message telling Claude which feature to use instead. Within ±0.15 of the threshold, it asks Jev a second time and averages the two answers, because answers to identical input vary by about ±0.05–0.1.
5. If the API key is missing, the Jev request fails, or the hook runs past its 12-second deadline, the command is allowed (fail-open) so your work is never stuck.

Cost: about 1,150 input tokens per plain command sent to Jev and up to about 2,700 with long source code, so $0.00005–0.00011 at Jev 1.14 pricing ($0.042 per million tokens). Shorter category criteria cut about 35% per command compared with 0.2.0 (1,877 → 1,222 tokens on average over the test cases), and on about 8,000 commands from real Claude Code transcripts about 40% were settled in step 0 without calling Jev. Together, Jev token use is about 39% of what it was. When Jev is called the hook adds about 400–500 ms, and about twice the Jev time in the rare borderline cases.

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
| `USE_RIGHT_TOOL_MODEL` | `jev-1.14.0` | The threshold and criteria were tuned on this version. On the same cases 1.14 kept a wider margin than 1.13 (minimum 0.25 vs 0.13), and with the shorter criteria 1.13 misjudged `nohup ... &`. Rerun `node test/cases.mjs` before switching. |
| `USE_RIGHT_TOOL_LOG` | (unset) | When set, verdicts, input tokens used (`inputTokens`), tool rules (`rule`), skipped Jev calls (`skipped`), and bypasses are appended to this file as JSONL (with secrets redacted) |
| `USE_RIGHT_TOOL_PREFILTER` | (unset) | Set to `1` to call Jev only when the command or the code it runs contains a hint such as `while`, `sleep`, `setTimeout`, `tail -f`, `-Wait`, or `--watch`. Cheaper and faster, but obfuscated workarounds can slip through. |
| `USE_RIGHT_TOOL_ENDPOINT` | TypeSafe API | Override the API URL (used by the offline tests) |

## Bypass

If a command is blocked by mistake, re-run it with a trailing comment that gives a reason:

```
for i in 1 2 3; do curl -sf https://example.com && break; sleep 5; done # use-right-tool:allow: three fixed retries
```

The marker counts only as a real shell comment (not inside quotes, arguments, or URLs) and only with a reason after the colon. It works for the tool rules too (for example when a binary file has to be patched). Every bypass is logged when `USE_RIGHT_TOOL_LOG` is set. A Jev block message mentions the bypass only when the verdict is uncertain (p < 0.9); a tool-rule block message always mentions it.

## Testing

```
node --test test/unit.test.mjs   # offline, 87 tests: tokenizer, source collection, tool rules, Jev skipping, redaction, policy, hook I/O (stub server, no API key)
node test/cases.mjs              # live: 73 commands (38 blocked by Jev, 6 by tool rules, 29 allowed) and the tokens used
```

The live cases include the red-team findings: loops hidden in scripts with neutral names, npm scripts, make targets, imports, long files, bounded loops that act as schedulers, small retry loops, attached services, and commands that only format or write loop code. Fixtures live in `test/fixtures/`.

## Limitations

- The hook does not follow imports more than one level deep, code loaded at run time (`exec(open(...).read())`, `curl ... | sh`), or task runners other than npm/pnpm/yarn/bun/make/just.
- The tokenizer is an approximation, not a full shell parser. Scripts inside function definitions (`f() { python x.py; }`), scriptblocks assigned to a variable (`$s = { python x.py }`), or branches that cannot run (`false && python x.py`) are treated as if they run, so their code is read and sent.
- The 12-second deadline cannot interrupt synchronous file reads. Network paths are skipped and reads are bounded, so this should only matter on an unusually slow local disk.
- Some waits are a judgment call and are blocked in the foreground, for example `kubectl wait`, `kubectl rollout status`, and `sleep 2 && curl ...`. Use `run_in_background: true` or the bypass comment.
- The tool rules are approximate too. One write inside a chain blocks the whole chain, and writes through computed paths or `eval` are missed. The search rule applies only when the whole command is viewing or searching files (plus neutral commands such as `cd`, `ls`, and `echo`); mixed with other work, as in `npm test && grep -rn x src`, it is allowed.
- The plugin is a workflow guide for Claude, not a security boundary. It fails open, and the bypass is available to Claude.
