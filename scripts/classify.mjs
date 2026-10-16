// Jev(TypeSafe System One)로 쉘 명령이 루프·폴링·모니터링을 흉내 내는지 판별한다.
// 판단(이 명령이 무엇을 하려는가)은 Jev가, 정책(막을지 말지)은 코드가 맡는다.

import { redact } from "./redact.mjs";
import { loopRelatedLines } from "./signals.mjs";

export const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
// 임계값과 프롬프트를 이 버전에 맞춰 조정했다. 바꿀 때는 test/cases.mjs 를 다시 돌린다.
// 같은 케이스에서 1.14 가 1.13 보다 경계 마진이 넓었다(최소 0.25 대 0.13).
export const DEFAULT_MODEL = "jev-1.14.0";
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

// 요청마다 그대로 나가는 고정 비용이라 짧게 유지한다(입력 토큰만 과금된다).
// 예시를 줄일 때는 test/cases.mjs 로 마진을 확인한다. 재시도 예시를 빼면 재시도 루프의 마진이 크게 줄었다.
// 루프 코드를 파일에 쓰기만 하는 명령은 rules.mjs 가 Jev 전에 처리하므로 여기서 예시로 들지 않는다.
const CATEGORIES = {
  poll_until_condition: {
    instructions:
      "Re-checks external state (HTTP endpoint, port, file, process, CI/deploy status) with waits between checks, and exits once the condition holds or an attempt cap is hit. The expected wait is short, seconds to a few minutes.",
    examples: ["until curl -sf localhost:3000/health; do sleep 1; done", "while (-not (Test-Path out.json)) { Start-Sleep 2 }"],
    not_this:
      "Watching a long-running job (training, deployment, large build) that may take tens of minutes or hours, or a watchdog checking progress, failure, or stall, is repeat_forever even with an end condition.",
  },
  wait_for_completion: {
    instructions: "Sleeps or blocks to wait for another job, build, or process to finish before looking at its result.",
    examples: ["sleep 120 && cat build.log", "Wait-Process -Id 4242"],
  },
  stream_follow: {
    instructions: "Continuously follows a file or output stream, never finishing on its own.",
    examples: ["tail -f app.log", "Get-Content server.log -Wait", "kubectl get pods -w", "watch -n 5 kubectl get pods"],
  },
  repeat_forever: {
    instructions:
      "Re-runs a check or job at an interval for a long time, like a scheduler or monitor: unbounded loops, bounded loops whose iterations times interval span many minutes or more, and until/while loops watching a long-running job for a state change, failure, or stall over tens of minutes or hours.",
    examples: [
      "while true; do curl -s api/status; sleep 30; done",
      "for i in $(seq 1 100); do git pull; sleep 300; done",
      "until [ \"$(jq -r .status run/status.json)\" != running ] || [ $(( $(date +%s) - $(stat -c %Y run/train.log) )) -gt 600 ]; do sleep 60; done",
    ],
  },
  watch_mode_process: {
    instructions: "Starts a dev server, watch-mode compiler/test runner, or service that stays attached to the terminal.",
    examples: ["npm run dev", "tsc --watch", "python -m http.server"],
    not_this: "Starting a service detached (docker compose up -d, nohup ... &) is single_action.",
  },
  finite_iteration: {
    instructions:
      "Loops over a known finite set of items, or retries a failed action a few times (up to about five); finishes quickly without waiting for external change.",
    examples: [
      "for f in *.png; do convert \"$f\" \"${f%.png}.jpg\"; done",
      "for i in 1 2 3; do npm ci && break; sleep 2; done",
      "for i in 1 2 3; do curl -sf https://registry.npmjs.org/ && break; sleep 5; done",
      "foreach ($i in 1..3) { try { Invoke-WebRequest $url; break } catch { Start-Sleep 5 } }",
    ],
  },
  single_action: {
    instructions:
      "Does its work once and exits without looping or waiting. Loop code that is only displayed, written to a file, formatted, or committed is not executed; sleep or watch may appear only as names or text.",
    examples: ["git status", "grep -rn \"sleep\" src/", "docker compose up -d", "git commit -m \"add polling loop\""],
  },
};

const CONTEXT =
  "An AI coding agent will run `command` in a `shell` terminal; `agent_description` is its own note. `sources` is code the command actually executes (scripts, package.json scripts, make recipes, imported modules); long code is cut to `code_head`, `code_tail` and `loop_related_lines`. Judge by what the executed code does, not by names.";

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
// `inputTokens` 는 이 판단에 쓴 입력 토큰의 합이다(재질의 포함, 로그용).
export async function judge(request, { apiKey, runInBackground, threshold }) {
  const first = await askJev(request, { apiKey });
  let answer = first.answers.intent;
  let inputTokens = first.usage?.input_tokens ?? 0;
  let requeried = false;
  if (isBorderline(decide(answer, { runInBackground, threshold }).blockedProb, threshold)) {
    const second = await askJev(request, { apiKey });
    answer = averageAnswers([answer, second.answers.intent]);
    inputTokens += second.usage?.input_tokens ?? 0;
    requeried = true;
  }
  return { model: first.model, answer, requeried, inputTokens, verdict: decide(answer, { runInBackground, threshold }) };
}

const GUIDANCE = {
  poll_until_condition: [
    "This command polls a status in a shell loop.",
    "- For a short wait (a few minutes at most) where you only need one notification when the condition becomes true: run the same `until` loop with `run_in_background: true`. The harness notifies you when it exits, so you do not have to wait on it yourself.",
    "- To watch a long-running job (training, deployment, a large build) or to get an event for each change, progress step, or failure: use the `Monitor` tool (each stdout line becomes one notification). Do not move such a watch into a background `until` loop.",
  ],
  wait_for_completion: [
    "This command sleeps or blocks to wait for another job to finish.",
    "- If you started that job with `run_in_background: true`, you are notified automatically when it finishes. Do not wait with a fixed sleep.",
    "- To wait briefly (a few minutes at most) for a specific condition (a log line, a file appearing, a port opening): run `until <condition>; do sleep 1; done` with `run_in_background: true`.",
    "- To watch a long-running job or several events: use the `Monitor` tool.",
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
