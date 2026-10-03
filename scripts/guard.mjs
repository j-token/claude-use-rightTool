// PreToolUse 훅 (Bash | PowerShell)
// 루프·폴링·모니터링을 쉘로 흉내 내는 명령이면 막고 전용 도구를 안내한다.
// Jev 호출이 실패하거나 시간이 모자라면 작업을 멈추지 않도록 통과시킨다(fail-open).

import { appendFileSync } from "node:fs";
import { buildRequest, denyReason, findBypass, judge, parseThreshold } from "./classify.mjs";
import { redact } from "./redact.mjs";
import { looksLoopish } from "./signals.mjs";
import { gatherSources } from "./sources.mjs";

// hooks.json 의 timeout(15초)보다 먼저 스스로 끝내서, 늦어질 때도 통과로 처리한다.
const DEADLINE_MS = 12000;
setTimeout(() => {
  process.stderr.write("[use-right-tool] Deadline reached; allowing the command.\n");
  process.exit(0);
}, DEADLINE_MS).unref();

const usePrefilter = process.env.USE_RIGHT_TOOL_PREFILTER === "1";
const LOG_COMMAND_CHARS = 4000;

function log(entry) {
  const path = process.env.USE_RIGHT_TOOL_LOG;
  if (!path) return;
  try {
    appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch {}
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const input = JSON.parse(await readStdin());
  const toolName = input.tool_name;
  const { command, description, run_in_background: runInBackground } = input.tool_input ?? {};
  if (typeof command !== "string" || !command.trim()) return;

  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    process.stderr.write("[use-right-tool] TYPESAFE_API_KEY is not set; skipping the check.\n");
    return;
  }
  const threshold = parseThreshold(process.env.USE_RIGHT_TOOL_THRESHOLD);
  if (threshold.warning) process.stderr.write(`[use-right-tool] ${threshold.warning}\n`);

  const { comments, sources } = gatherSources({ toolName, command, cwd: input.cwd });
  const logBase = { toolName, command: redact(command.slice(0, LOG_COMMAND_CHARS)), runInBackground, sources: sources.map((s) => `${s.path} (${s.role})`) };

  const bypass = findBypass(comments);
  if (bypass) {
    log({ ...logBase, bypass: redact(bypass) });
    return;
  }

  if (usePrefilter) {
    const texts = [command, ...sources.flatMap((s) => [s.code, s.code_head, s.code_tail, ...(s.loop_related_lines ?? [])])];
    if (!texts.some((t) => t && looksLoopish(t))) return;
  }

  let result;
  try {
    result = await judge(buildRequest({ toolName, command, description, sources }), { apiKey, runInBackground, threshold: threshold.value });
  } catch (err) {
    const message = redact(String(err));
    log({ ...logBase, error: message });
    process.stderr.write(`[use-right-tool] Jev request failed; allowing the command: ${message}\n`);
    return;
  }

  const { model, answer, requeried, verdict } = result;
  log({ ...logBase, model, requeried, choice: answer.choice, probabilities: answer.probabilities, ...verdict });

  if (verdict.deny) deny(denyReason(verdict));
}

main().catch((err) => {
  process.stderr.write(`[use-right-tool] Hook error; allowing the command: ${redact(String(err))}\n`);
});
