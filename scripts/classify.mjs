// Jev(TypeSafe System One)로 쉘 명령이 루프·폴링·모니터링을 흉내 내는지 판별한다.
// 판단(이 명령이 무엇을 하려는가)은 Jev가, 정책(막을지 말지)은 코드가 맡는다.

import { redact } from "./redact.mjs";
import { loopRelatedLines } from "./signals.mjs";

export const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
// 임계값을 이 버전에 맞춰 조정했다. 올릴 때는 test/cases.mjs 를 다시 돌린다.
export const DEFAULT_MODEL = "jev-1.13.0";
export const DEFAULT_THRESHOLD = 0.6;
// 임계값 ±이 범위면 한 번 더 물어 평균을 낸다(같은 입력도 ±0.05~0.1 흔들린다).
export const BORDERLINE = 0.15;
// 이보다 확실하면 차단 메시지에 우회 방법을 적지 않는다.
const CONFIDENT = 0.9;

const MAX_COMMAND_CHARS = 8000;
const COMMAND_HEAD_CHARS = 5000;
const COMMAND_TAIL_CHARS = 2500;

const BYPASS = /^#\s*use-right-tool:allow:\s*(\S.*)$/;
const BYPASS_EXAMPLE = "# use-right-tool:allow: <why this is not a loop or a wait>";

// 우회는 따옴표 밖의 진짜 주석이면서 이유가 적혀 있을 때만 인정한다.
export function findBypass(comments) {
  for (const comment of comments) {
    const m = BYPASS.exec(comment.trim());
    if (m) return m[1].trim();
  }
  return null;
}

export function parseThreshold(raw) {
  if (raw === undefined || raw.trim() === "") return { value: DEFAULT_THRESHOLD };
  const value = Number(raw);
  if (Number.isFinite(value) && value > 0 && value <= 1) return { value };
  return {
    value: DEFAULT_THRESHOLD,
    warning: `USE_RIGHT_TOOL_THRESHOLD=${JSON.stringify(raw)} is not a number in (0, 1]; using ${DEFAULT_THRESHOLD}.`,
  };
}

const CATEGORIES = {
  poll_until_condition: {
    instructions:
      "Waits for some external state to change: repeatedly re-checks a status (HTTP endpoint, port, file existence, process, CI or deploy status, query result) with waits between checks, and exits once the condition is met or an attempt cap is reached. The repetition may come from while/until/for loops or from tools that repeat a command, such as seq | xargs, find -exec, or recursion.",
    examples: [
      "until curl -sf localhost:3000/health; do sleep 1; done",
      "while (-not (Test-Path out.json)) { Start-Sleep 2 }",
      "for i in $(seq 1 60); do gh run view 123 --json status | grep -q completed && break; sleep 10; done",
      "seq 30 | xargs -I{} sh -c 'test -f out.json && exit 255; sleep 2'",
    ],
    not_this: "Retrying the same action a few times because it failed transiently (a flaky install or network request) is finite_iteration.",
  },
  wait_for_completion: {
    instructions:
      "Sleeps a fixed amount of time or blocks in order to wait for some other job, build, download, or process to finish before looking at its result.",
    examples: ["sleep 120 && cat build.log", "Start-Sleep -Seconds 30; Get-Content out.log", "wait $PID", "Wait-Process -Id 4242"],
  },
  stream_follow: {
    instructions: "Continuously follows a file or output stream and prints new content as it appears, never finishing on its own.",
    examples: [
      "tail -f app.log",
      "Get-Content server.log -Wait -Tail 20",
      "journalctl -fu nginx",
      "docker logs -f api",
      "kubectl get pods -w",
      "watch -n 5 kubectl get pods",
      "ping -t 8.8.8.8",
    ],
  },
  repeat_forever: {
    instructions:
      "Keeps re-running a check or a job at an interval for a long time, acting as a scheduler, cron, or ongoing monitor. This includes loops with no end condition and loops with a numeric bound whose total running time (iterations times interval) spans many minutes or hours.",
    examples: [
      "while true; do curl -s api/status; sleep 30; done",
      "while ($true) { git pull; Start-Sleep 300 }",
      "for i in $(seq 1 100); do git pull; sleep 300; done",
      "for i in {1..1440}; do curl -s api/status >> status.log; sleep 60; done",
      "1..288 | ForEach-Object { Invoke-RestMethod $url; Start-Sleep 300 }",
    ],
  },
  watch_mode_process: {
    instructions:
      "Starts a dev server, a watch-mode compiler or test runner, or another service process that stays attached to the terminal and keeps running to react to changes.",
    examples: ["npm run dev", "tsc --watch", "vitest --watch", "nodemon server.js", "python -m http.server"],
    not_this:
      "Starting a service detached so that the command itself returns right away (docker compose up -d, nohup ... &, Start-Process, pm2 start) is single_action.",
  },
  finite_iteration: {
    instructions:
      "A loop over a finite, already-known set of items (files, lines, list entries, a short numeric range), or a small fixed number (up to about five) of retries of the same action after a transient failure. It finishes quickly on its own and does not wait for anything external to change.",
    examples: [
      "for f in *.png; do convert \"$f\" \"${f%.png}.jpg\"; done",
      "Get-ChildItem *.log | ForEach-Object { Remove-Item $_ }",
      "while read -r line; do echo \"$line\"; done < list.txt",
      "for i in 1 2 3; do npm ci && break; sleep 2; done",
      "for i in 1 2 3; do curl -sf https://registry.npmjs.org/ && break; sleep 5; done",
      "foreach ($i in 1..3) { try { Invoke-WebRequest $url; break } catch { Start-Sleep 5 } }",
    ],
    not_this: "A loop that runs a job at intervals for many minutes or hours is repeat_forever even when its count is bounded.",
  },
  single_action: {
    instructions:
      "An ordinary command that does its work once and exits. It does not loop, poll, wait for something else, or watch for changes. Loop code that the command only displays, creates, writes into a file, formats, lints, copies, or commits is not executed, so such commands are single_action. Words like sleep or watch may also appear only as names, arguments, or text.",
    examples: [
      "git status",
      "npm test",
      "grep -rn \"sleep\" src/",
      "npm install watch",
      "docker compose up -d",
      "cat poll.sh",
      "cat > monitor.sh <<'EOF'\nwhile true; do check; sleep 5; done\nEOF",
      "Set-Content watch.ps1 -Value 'while ($true) { Start-Sleep 5 }'",
      "git commit -m \"add polling loop\"",
    ],
  },
};

const CONTEXT = [
  "An AI coding agent is about to run `command` in a `shell` terminal.",
  "`agent_description`, when present, is the agent's own short note about what the command is for.",
  "A very long command is given as `command_head`, `command_tail` and `command_loop_related_lines` instead of `command`.",
  "`sources`, when present, lists code that the command will actually execute: script files it runs, package.json scripts or make/just recipes it invokes, and local modules those scripts import.",
  "Each source has a `role`. Long code is given as `code_head`, `code_tail` and `loop_related_lines`; a source with a `note` could not be read.",
  "Judge by what the executed code does, not by file, script, or target names.",
].join(" ");

export function buildRequest({ toolName, command, description, sources = [] }) {
  const state = { shell: toolName === "PowerShell" ? "powershell" : "bash" };
  // 아주 긴 명령은 보낼 부분만 잘라서 가린다(전체를 가리면 시간이 오래 걸린다).
  if (command.length <= MAX_COMMAND_CHARS) state.command = redact(command);
  else {
    state.command_head = redact(command.slice(0, COMMAND_HEAD_CHARS));
    state.command_tail = redact(command.slice(-COMMAND_TAIL_CHARS));
    state.command_loop_related_lines = loopRelatedLines(command).map(redact);
  }
  if (description) state.agent_description = redact(description);
  if (sources.length) state.sources = sources;

  return {
    state,
    model: process.env.USE_RIGHT_TOOL_MODEL || DEFAULT_MODEL,
    questions: {
      intent: {
        type: "choice",
        instructions: {
          context: CONTEXT,
          question: "Which option best describes what running the command will actually do over time?",
        },
        criteria: CATEGORIES,
      },
    },
  };
}

export async function askJev(request, { apiKey, timeoutMs = 8000 } = {}) {
  const res = await fetch(process.env.USE_RIGHT_TOOL_ENDPOINT || ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`TypeSafe ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const body = await res.json();
  if (!validProbabilities(body?.answers?.intent?.probabilities)) {
    throw new Error(`TypeSafe response has no valid intent probabilities: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body;
}

// 알려진 범주만, 0~1 사이 숫자로, 합이 1에 가까워야 한다. 아니면 오류로 보고 통과시킨다.
function validProbabilities(p) {
  if (!p || typeof p !== "object") return false;
  const entries = Object.entries(p);
  if (!entries.length || entries.some(([k, v]) => !(k in CATEGORIES) || typeof v !== "number" || !(v >= 0 && v <= 1))) return false;
  const sum = entries.reduce((s, [, v]) => s + v, 0);
  return Math.abs(sum - 1) < 0.02;
}

export function averageAnswers(answers) {
  const probabilities = {};
  for (const { probabilities: p } of answers) {
    for (const [k, v] of Object.entries(p)) probabilities[k] = (probabilities[k] ?? 0) + v / answers.length;
  }
  const choice = Object.keys(probabilities).reduce((a, b) => (probabilities[b] > probabilities[a] ? b : a));
  return { type: "choice", choice, probabilities };
}

// 포그라운드에서는 기다리거나 계속 도는 모든 형태를 막는다.
// 백그라운드에서는 "조건이 되면 끝나는" 대기 루프가 공식 권장 패턴이므로 허용하고,
// 끝나지 않는 감시·반복만 막는다(Monitor / loop 쪽이 맞다).
const BLOCKED = {
  foreground: ["poll_until_condition", "wait_for_completion", "stream_follow", "repeat_forever", "watch_mode_process"],
  background: ["stream_follow", "repeat_forever"],
};

export function decide(answer, { runInBackground, threshold }) {
  const probs = answer.probabilities;
  const blocked = BLOCKED[runInBackground === true ? "background" : "foreground"];
  const blockedProb = blocked.reduce((sum, c) => sum + (probs[c] ?? 0), 0);
  const top = blocked.reduce((best, c) => ((probs[c] ?? 0) > (probs[best] ?? 0) ? c : best), blocked[0]);
  return { deny: blockedProb >= threshold, category: top, blockedProb };
}

const isBorderline = (blockedProb, threshold) => Math.abs(blockedProb - threshold) < BORDERLINE;

// Jev에 묻고 정책을 적용한다. 임계값 근처면 한 번 더 물어 평균을 낸다.
export async function judge(request, { apiKey, runInBackground, threshold }) {
  const first = await askJev(request, { apiKey });
  let answer = first.answers.intent;
  let requeried = false;
  if (isBorderline(decide(answer, { runInBackground, threshold }).blockedProb, threshold)) {
    const second = await askJev(request, { apiKey });
    answer = averageAnswers([answer, second.answers.intent]);
    requeried = true;
  }
  return { model: first.model, answer, requeried, verdict: decide(answer, { runInBackground, threshold }) };
}

const GUIDANCE = {
  poll_until_condition: [
    "This command polls a status in a shell loop.",
    "- If you only need one notification when the condition becomes true: run the same `until` loop with `run_in_background: true`. The harness notifies you when it exits, so you do not have to wait on it yourself.",
    "- If you need an event for each change or progress step: use the `Monitor` tool (each stdout line becomes one notification).",
  ],
  wait_for_completion: [
    "This command sleeps or blocks to wait for another job to finish.",
    "- If you started that job with `run_in_background: true`, you are notified automatically when it finishes. Do not wait with a fixed sleep.",
    "- To wait for a specific condition (a log line, a file appearing, a port opening): run `until <condition>; do sleep 1; done` with `run_in_background: true`.",
  ],
  stream_follow: [
    "This command follows a log or output stream continuously (tail -f, Get-Content -Wait, watch, ...).",
    "- Use the `Monitor` tool. Filter with `grep --line-buffered` so that only the lines you would act on, both success and failure signals, become events.",
  ],
  repeat_forever: [
    "This command keeps re-running a check or a job at an interval for a long time.",
    "- To be notified as soon as something changes: use the `Monitor` tool (an unbounded loop is fine there; re-arm it when it expires).",
    "- To re-run a prompt or task every N minutes: use the `/loop` skill (ScheduleWakeup) or `CronCreate`.",
  ],
  watch_mode_process: [
    "This command starts a dev server or a watch-mode process in the foreground, so it would never return.",
    "- Run it with `run_in_background: true`, then use the `Monitor` tool on its output to catch readiness or errors.",
  ],
};

export function denyReason({ category, blockedProb }) {
  const lines = [`[use-right-tool] Blocked: this command was not run. (Jev verdict: ${category}, p=${blockedProb.toFixed(2)})`, ...GUIDANCE[category]];
  if (blockedProb < CONFIDENT) {
    lines.push(
      `This verdict is not certain. Only if the command really is a finite task that does not wait or loop, re-run it with a trailing comment: \`${BYPASS_EXAMPLE}\`.`,
    );
  }
  return lines.join("\n");
}
