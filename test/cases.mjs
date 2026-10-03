// 실제 Jev를 호출해 대표 명령들의 판별 결과와 차단 여부를 확인한다.
// 훅과 같은 흐름(실행 코드 수집 → 판별 → 경계 구간 재질의)을 그대로 쓴다.
// 실행: node test/cases.mjs   (TYPESAFE_API_KEY 필요, 호출당 약 $0.00005)

import { fileURLToPath } from "node:url";
import { buildRequest, judge, parseThreshold } from "../scripts/classify.mjs";
import { gatherSources } from "../scripts/sources.mjs";

const threshold = parseThreshold(process.env.USE_RIGHT_TOOL_THRESHOLD).value;
const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const LONG_PAD = `echo ${"x".repeat(9000)}\n`;

// [toolName, command, runInBackground, expectDeny, description?]
const CASES = [
  // 막아야 하는 것
  ["Bash", "while true; do curl -s localhost:8080/status; sleep 30; done", false, true],
  ["Bash", "until curl -sf localhost:3000/health; do sleep 1; done", false, true, "Wait for server to be ready"],
  ["Bash", "sleep 90 && cat build.log", false, true, "Wait for build then check log"],
  ["Bash", "tail -f logs/app.log", false, true],
  ["Bash", "tail -f logs/app.log | grep --line-buffered ERROR", true, true],
  ["Bash", "for i in $(seq 1 60); do gh run view 123 --json status -q .status | grep -q completed && break; sleep 10; done", false, true],
  ["Bash", "watch -n 5 kubectl get pods", false, true],
  ["Bash", "while true; do git fetch; git status -sb; sleep 300; done", true, true, "Check for upstream changes every 5 minutes"],
  ["PowerShell", "while ($true) { Get-Process node; Start-Sleep -Seconds 10 }", false, true],
  ["PowerShell", "Get-Content .\\server.log -Wait -Tail 20", false, true],
  ["PowerShell", "do { Start-Sleep 2 } until (Test-Path .\\dist\\index.js)", false, true],
  ["PowerShell", "Start-Sleep -Seconds 60; Get-Content .\\out.log", false, true, "빌드 끝날 때까지 기다렸다가 로그 확인"],
  ["Bash", "npx tsc --watch", false, true],
  ["Bash", "python -c \"import time; time.sleep(60)\" && cat build.log", false, true, "Wait for build"],
  ["Bash", "node -e \"setTimeout(()=>{},60000)\" && cat build.log", false, true, "Wait for build"],
  ["PowerShell", "ping -n 61 127.0.0.1 > $null; Get-Content out.log", false, true, "Wait a minute then check output"],
  // 스크립트 안에 숨은 루프 (파일 이름은 중립적)
  ["Bash", "python check.py", false, true],
  ["Bash", "node sync.mjs", false, true],
  ["Bash", "php task.php", false, true],
  ["Bash", "./runner", false, true],
  ["Bash", "python app.py", false, true],
  ["Bash", "python long.py", false, true],
  ["Bash", "cd sub && python job.py", false, true],
  ["Bash", "python \"dir with space/job.py\"", false, true],
  ["Bash", "npm run db:prep", false, true],
  ["Bash", "npm run prepare-env", false, true],
  ["Bash", "make prep", false, true],
  // 횟수는 정해졌지만 사실상 스케줄러인 루프
  ["Bash", "for i in $(seq 1 100); do git pull; sleep 300; done", false, true],
  ["Bash", "for i in {1..1440}; do curl -s localhost/status >> status.log; sleep 60; done", true, true],
  ["PowerShell", "1..288 | ForEach-Object { Invoke-RestMethod http://localhost/status; Start-Sleep 300 }", false, true],
  // 아주 긴 명령의 끝에 숨은 대기
  ["Bash", `${LONG_PAD}sleep 120 && cat build.log`, false, true],

  // 통과해야 하는 것
  ["Bash", "until grep -q 'Ready in' dev.log; do sleep 0.5; done", true, false, "Notify when dev server is ready"],
  ["Bash", "for f in src/*.ts; do wc -l \"$f\"; done", false, false],
  ["Bash", "while read -r line; do echo \"$line\" | cut -d, -f1; done < data.csv", false, false],
  ["Bash", "grep -rn 'sleep(' src/ | head -20", false, false],
  ["Bash", "npm install watchpack", false, false],
  ["Bash", "for i in 1 2 3; do npm ci && break; sleep 2; done", false, false, "Retry flaky install"],
  ["Bash", "for i in 1 2 3; do curl -sf https://registry.npmjs.org/ && break; sleep 5; done", false, false, "Retry flaky network check"],
  ["PowerShell", "foreach ($i in 1..3) { try { Invoke-WebRequest https://registry.npmjs.org/ -UseBasicParsing; break } catch { Start-Sleep 5 } }", false, false],
  ["PowerShell", "Get-ChildItem *.log | ForEach-Object { Remove-Item $_ }", false, false],
  ["PowerShell", "Select-String -Path *.ps1 -Pattern 'Start-Sleep'", false, false],
  ["Bash", "npm run dev", true, false],
  ["Bash", "git log --oneline -5", false, false],
  ["Bash", "docker compose up -d", false, false, "Start services"],
  ["Bash", "npm test", false, false, "Run tests"],
  ["Bash", "python manage.py migrate", false, false, "Apply migrations"],
  ["Bash", "python report.py sales.csv", false, false],
  ["PowerShell", ".\\build.ps1", false, false],
  ["Bash", "curl -s https://api.github.com/repos/foo/bar", false, false, "Fetch repo info"],
  // 루프가 든 파일을 보거나, 쓰거나, 다듬기만 하는 명령
  ["Bash", "cat check.py", false, false],
  ["Bash", "code sync.mjs", false, false],
  ["Bash", "black check.py", false, false],
  ["Bash", "python -m py_compile check.py", false, false],
  ["Bash", "cat > scripts/monitor.sh <<'EOF'\n#!/usr/bin/env bash\nwhile true; do curl -s localhost/status; sleep 30; done\nEOF\nchmod +x scripts/monitor.sh", false, false, "Write a monitor script"],
  ["PowerShell", "Set-Content -Path watch.ps1 -Value 'while ($true) { Get-Process node; Start-Sleep 5 }'", false, false, "Write a watch script"],
  ["Bash", "git commit -m \"Add polling loop for deploy status\"", false, false],
  ["Bash", "npm run build", false, false],
  ["Bash", "make test", false, false],
];

const apiKey = process.env.TYPESAFE_API_KEY;
let pass = 0;
let requeries = 0;

const results = await Promise.all(
  CASES.map(async ([toolName, command, runInBackground, expectDeny, description]) => {
    const { sources } = gatherSources({ toolName, command, cwd: fixtures, roots: [fixtures] });
    const request = buildRequest({ toolName, command, description, sources });
    const { answer, verdict, requeried } = await judge(request, { apiKey, runInBackground, threshold });
    if (requeried) requeries++;
    const top = Object.entries(answer.probabilities)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([k, p]) => `${k}:${p.toFixed(2)}`)
      .join(" ");
    const note = `p=${verdict.blockedProb.toFixed(2)}${requeried ? "*" : " "} ${top}${sources.length ? ` +${sources.map((s) => s.path).join(",")}` : ""}`;
    return { command, runInBackground, expectDeny, deny: verdict.deny, note };
  }),
);

for (const r of results) {
  const ok = r.deny === r.expectDeny;
  if (ok) pass++;
  const shown = r.command.replace(/\n/g, "\\n").replace(/x{20,}/, "x…x");
  console.log(`${ok ? "OK  " : "FAIL"} ${r.deny ? "DENY " : "allow"} ${r.runInBackground ? "[bg] " : "     "}${shown.slice(0, 62).padEnd(62)} ${r.note}`);
}
console.log(`\n${pass}/${results.length} passed (threshold ${threshold}; * = asked twice near the threshold, ${requeries} cases)`);
process.exitCode = pass === results.length ? 0 : 1;
