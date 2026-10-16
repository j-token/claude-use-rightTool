// 실제 Jev를 호출해 대표 명령들의 판별 결과와 차단 여부를 확인한다.
// 훅과 같은 흐름(도구 규칙 → 단순 명령 건너뛰기 → 실행 코드 수집 → 판별 → 경계 구간 재질의)을 그대로 쓴다.
// 실행: node test/cases.mjs   (TYPESAFE_API_KEY 필요, Jev 호출당 약 $0.00005)
// USE_RIGHT_TOOL_MODEL 로 다른 버전을 비교할 수 있다.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRequest, judge, parseThreshold } from "../scripts/classify.mjs";
import { obviouslyFinite, toolMisuse } from "../scripts/rules.mjs";
import { gatherSources } from "../scripts/sources.mjs";

const threshold = parseThreshold(process.env.USE_RIGHT_TOOL_THRESHOLD).value;
const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const LONG_PAD = `echo ${"x".repeat(9000)}\n`;

// [toolName, command, runInBackground, expected, description?]
// expected: "loop" = Jev 가 막음, "tool" = 도구 규칙이 막음(Jev 호출 없음), "allow" = 통과
export const CASES = [
  // 막아야 하는 것
  ["Bash", "while true; do curl -s localhost:8080/status; sleep 30; done", false, "loop"],
  ["Bash", "until curl -sf localhost:3000/health; do sleep 1; done", false, "loop", "Wait for server to be ready"],
  ["Bash", "sleep 90 && cat build.log", false, "loop", "Wait for build then check log"],
  ["Bash", "tail -f logs/app.log", false, "loop"],
  ["Bash", "tail -f logs/app.log | grep --line-buffered ERROR", true, "loop"],
  ["Bash", "for i in $(seq 1 60); do gh run view 123 --json status -q .status | grep -q completed && break; sleep 10; done", false, "loop"],
  ["Bash", "watch -n 5 kubectl get pods", false, "loop"],
  ["Bash", "while true; do git fetch; git status -sb; sleep 300; done", true, "loop", "Check for upstream changes every 5 minutes"],
  ["PowerShell", "while ($true) { Get-Process node; Start-Sleep -Seconds 10 }", false, "loop"],
  ["PowerShell", "Get-Content .\\server.log -Wait -Tail 20", false, "loop"],
  ["PowerShell", "do { Start-Sleep 2 } until (Test-Path .\\dist\\index.js)", false, "loop"],
  ["PowerShell", "Start-Sleep -Seconds 60; Get-Content .\\out.log", false, "loop", "빌드 끝날 때까지 기다렸다가 로그 확인"],
  ["Bash", "npx tsc --watch", false, "loop"],
  ["Bash", "python -c \"import time; time.sleep(60)\" && cat build.log", false, "loop", "Wait for build"],
  ["Bash", "node -e \"setTimeout(()=>{},60000)\" && cat build.log", false, "loop", "Wait for build"],
  ["PowerShell", "ping -n 61 127.0.0.1 > $null; Get-Content out.log", false, "loop", "Wait a minute then check output"],
  // 스크립트 안에 숨은 루프 (파일 이름은 중립적)
  ["Bash", "python check.py", false, "loop"],
  ["Bash", "node sync.mjs", false, "loop"],
  ["Bash", "php task.php", false, "loop"],
  ["Bash", "./runner", false, "loop"],
  ["Bash", "python app.py", false, "loop"],
  ["Bash", "python long.py", false, "loop"],
  ["Bash", "cd sub && python job.py", false, "loop"],
  ["Bash", "python \"dir with space/job.py\"", false, "loop"],
  ["Bash", "npm run db:prep", false, "loop"],
  ["Bash", "npm run prepare-env", false, "loop"],
  ["Bash", "make prep", false, "loop"],
  // 횟수는 정해졌지만 사실상 스케줄러인 루프
  ["Bash", "for i in $(seq 1 100); do git pull; sleep 300; done", false, "loop"],
  ["Bash", "for i in {1..1440}; do curl -s localhost/status >> status.log; sleep 60; done", true, "loop"],
  ["PowerShell", "1..288 | ForEach-Object { Invoke-RestMethod http://localhost/status; Start-Sleep 300 }", false, "loop"],
  // 아주 긴 명령의 끝에 숨은 대기
  ["Bash", `${LONG_PAD}sleep 120 && cat build.log`, false, "loop"],
  // 붙어서 돌아가는 서비스와 대기 명령
  ["Bash", "npm run dev", false, "loop"],
  ["Bash", "docker compose up", false, "loop", "Start services"],
  ["Bash", "python -m http.server 8000", false, "loop"],
  ["Bash", "gh run watch 123", false, "loop"],
  ["Bash", "ssh deploy@host 'tail -f /var/log/syslog'", false, "loop"],
  ["PowerShell", "Wait-Process -Name msbuild; Get-Content .\\build.log -Tail 30", false, "loop"],
  ["Bash", "while ! nc -z localhost 5432; do sleep 1; done && npm run migrate", false, "loop"],

  // 전용 도구로 해야 하는 것 (Jev 호출 없음)
  ["Bash", "grep -rn 'sleep(' src/ | head -20", false, "tool"],
  ["PowerShell", "Select-String -Path *.ps1 -Pattern 'Start-Sleep'", false, "tool"],
  ["PowerShell", "Get-ChildItem -Recurse -Filter *.cs | Select-String 'Thread.Sleep'", false, "tool"],
  ["Bash", "cat > scripts/monitor.sh <<'EOF'\n#!/usr/bin/env bash\nwhile true; do curl -s localhost/status; sleep 30; done\nEOF\nchmod +x scripts/monitor.sh", false, "tool", "Write a monitor script"],
  ["PowerShell", "Set-Content -Path watch.ps1 -Value 'while ($true) { Get-Process node; Start-Sleep 5 }'", false, "tool", "Write a watch script"],
  ["Bash", "S=/tmp/s; python - \"$S/obf.py\" <<'EOF'\nimport sys\np=sys.argv[1]; s=open(p,encoding='utf-8').read()\nopen(p,'w',encoding='utf-8').write(s.replace('a','b'))\nEOF", false, "tool"],

  // 통과해야 하는 것
  ["Bash", "until grep -q 'Ready in' dev.log; do sleep 0.5; done", true, "allow", "Notify when dev server is ready"],
  ["Bash", "for f in src/*.ts; do wc -l \"$f\"; done", false, "allow"],
  ["Bash", "while read -r line; do echo \"$line\" | cut -d, -f1; done < data.csv", false, "allow"],
  ["Bash", "npm install watchpack", false, "allow"],
  ["Bash", "for i in 1 2 3; do npm ci && break; sleep 2; done", false, "allow", "Retry flaky install"],
  ["Bash", "for i in 1 2 3; do curl -sf https://registry.npmjs.org/ && break; sleep 5; done", false, "allow", "Retry flaky network check"],
  ["PowerShell", "foreach ($i in 1..3) { try { Invoke-WebRequest https://registry.npmjs.org/ -UseBasicParsing; break } catch { Start-Sleep 5 } }", false, "allow"],
  ["PowerShell", "Get-ChildItem *.log | ForEach-Object { Remove-Item $_ }", false, "allow"],
  ["Bash", "npm run dev", true, "allow"],
  ["Bash", "git log --oneline -5", false, "allow"],
  ["Bash", "docker compose up -d", false, "allow", "Start services"],
  ["Bash", "npm test", false, "allow", "Run tests"],
  ["Bash", "python manage.py migrate", false, "allow", "Apply migrations"],
  ["Bash", "python report.py sales.csv", false, "allow"],
  ["PowerShell", ".\\build.ps1", false, "allow"],
  ["Bash", "curl -s https://api.github.com/repos/foo/bar", false, "allow", "Fetch repo info"],
  ["Bash", "git pull && npm ci && npm run build", false, "allow"],
  ["Bash", "for i in 1 2 3 4 5; do pytest -x tests/test_flaky.py && break; done", false, "allow", "Retry flaky test"],
  ["Bash", "cargo build --release 2>&1 | tail -20", false, "allow"],
  ["Bash", "timeout 300 pytest -q", false, "allow", "Run tests with a time limit"],
  ["Bash", "nohup python -m http.server 8000 > server.log 2>&1 &", false, "allow", "Start server detached"],
  ["Bash", "git commit -m \"$(cat <<'EOF'\nfeat: add polling loop for deploy status\nEOF\n)\"", false, "allow"],
  // 루프가 든 파일을 보거나 다듬거나 검사만 하는 명령
  ["Bash", "cat check.py", false, "allow"],
  ["Bash", "code sync.mjs", false, "allow"],
  ["Bash", "black check.py", false, "allow"],
  ["Bash", "npx prettier --write sync.mjs", false, "allow"],
  ["Bash", "python -m py_compile check.py", false, "allow"],
  ["Bash", "npm run build", false, "allow"],
  ["Bash", "make test", false, "allow"],
];

// 훅과 같은 순서로 판단한다. Jev 를 부르지 않은 경우 inputTokens 는 0 이다.
export async function evaluate([toolName, command, runInBackground, , description], { apiKey }) {
  const shell = toolName === "PowerShell" ? "powershell" : "bash";
  const misuse = toolMisuse(command, shell);
  if (misuse) return { outcome: "tool", note: `rule: ${misuse.kind}`, inputTokens: 0, jev: false };
  const { sources } = gatherSources({ toolName, command, cwd: fixtures, roots: [fixtures] });
  if (obviouslyFinite(command, shell, sources)) return { outcome: "allow", note: "skipped: obviously finite", inputTokens: 0, jev: false };
  const request = buildRequest({ toolName, command, description, sources });
  const { answer, verdict, requeried, inputTokens } = await judge(request, { apiKey, runInBackground, threshold });
  const top = Object.entries(answer.probabilities)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([k, p]) => `${k}:${p.toFixed(2)}`)
    .join(" ");
  const note = `p=${verdict.blockedProb.toFixed(2)}${requeried ? "*" : " "} ${top}${sources.length ? ` +${sources.map((s) => s.path).join(",")}` : ""}`;
  return { outcome: verdict.deny ? "loop" : "allow", note, inputTokens, requeried, jev: true };
}

// 다른 스크립트가 CASES 만 가져갈 때는 실행하지 않는다.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();

async function main() {
  const apiKey = process.env.TYPESAFE_API_KEY;
  const results = await Promise.all(CASES.map(async (c) => ({ c, ...(await evaluate(c, { apiKey })) })));

  let pass = 0;
  for (const { c, outcome, note } of results) {
    const [, command, runInBackground, expected] = c;
    const ok = outcome === expected;
    if (ok) pass++;
    const shown = command.replace(/\n/g, "\\n").replace(/x{20,}/, "x…x");
    console.log(`${ok ? "OK  " : "FAIL"} ${outcome.padEnd(5)} ${runInBackground ? "[bg] " : "     "}${shown.slice(0, 62).padEnd(62)} ${note}`);
  }
  const jev = results.filter((r) => r.jev);
  const tokens = jev.reduce((s, r) => s + r.inputTokens, 0);
  console.log(
    `\n${pass}/${results.length} passed (threshold ${threshold}; * = asked twice near the threshold, ${jev.filter((r) => r.requeried).length} cases)` +
      `\nJev called for ${jev.length}/${results.length} cases, ${tokens} input tokens (avg ${jev.length ? Math.round(tokens / jev.length) : 0} per judged case)`,
  );
  process.exitCode = pass === results.length ? 0 : 1;
}
