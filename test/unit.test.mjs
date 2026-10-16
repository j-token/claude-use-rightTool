// 오프라인 단위 테스트: 토크나이저, 실행 코드 수집, 정책, 훅 입출력.
// Jev 대신 로컬 스텁 서버를 쓰므로 API 키나 네트워크가 필요 없다.
// 실행: node --test test/unit.test.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { averageAnswers, buildRequest, decide, denyReason, findBypass, parseThreshold } from "../scripts/classify.mjs";
import { redact } from "../scripts/redact.mjs";
import { obviouslyFinite, toolMisuse } from "../scripts/rules.mjs";
import { tokenize } from "../scripts/shell.mjs";
import { gatherSources } from "../scripts/sources.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixtures = join(root, "test", "fixtures");
const guard = join(root, "scripts", "guard.mjs");

const collect = (command, toolName = "Bash", cwd = fixtures) => gatherSources({ toolName, command, cwd, roots: [fixtures] }).sources;
const paths = (command, toolName) => collect(command, toolName).map((s) => s.path);

// 세그먼트에 붙은 firstQuoted/depth 속성을 빼고 단어만 비교한다.
const words = (command, shell) => tokenize(command, shell).segments.map((s) => [...s]);

describe("tokenize", () => {
  it("splits on control operators and drops redirect targets", () => {
    assert.deepEqual(words("a 1 && b 2>&1 > out.txt; c | d || e &", "bash"), [["a", "1"], ["b"], ["c"], ["d"], ["e"]]);
  });

  it("keeps quoted text as one word and records only real comments", () => {
    const command = `echo "a # b" 'c d' # real comment`;
    assert.deepEqual(words(command, "bash"), [["echo", "a # b", "c d"]]);
    assert.deepEqual(tokenize(command, "bash").comments, ["# real comment"]);
  });

  it("does not parse heredoc bodies as commands", () => {
    assert.deepEqual(words("cat > m.sh <<'EOF'\nwhile true; do python x.py; done\nEOF\nchmod +x m.sh", "bash"), [["cat"], ["chmod", "+x", "m.sh"]]);
  });

  it("handles PowerShell here-strings, call operator and backslash paths", () => {
    assert.deepEqual(words("$s = @'\nwhile ($true) {}\n'@\n& .\\x.ps1 -Name a", "powershell"), [
      ["$s", "=", "\nwhile ($true) {}"],
      ["&", ".\\x.ps1", "-Name", "a"],
    ]);
  });

  it("records command substitutions and subshell depth", () => {
    const t = tokenize("echo $(python a.py) \"$(node b.js)\" `php c.php`; (cd sub); x", "bash");
    assert.deepEqual(t.substitutions, ["python a.py", "node b.js", "php c.php"]);
    assert.deepEqual(t.segments.map((s) => s.depth), [0, 1, 0]);
  });

  it("stays linear on huge single tokens", () => {
    const start = Date.now();
    tokenize(`python ${"a/".repeat(100000)}x.py`, "bash");
    assert.ok(Date.now() - start < 500);
  });
});

describe("gatherSources: only executed code", () => {
  for (const command of [
    "cat settings.py",
    "cat check.py",
    'git commit -m "check.py"',
    "code check.py",
    "black check.py",
    "head -20 check.py",
    "cp check.py check.py.bak",
    "python -m py_compile check.py",
    "bash -n runner",
    "curl https://example.com/a.js?file=check.py",
    "cat > m.sh <<'EOF'\npython check.py\nEOF",
  ]) {
    it(`reads nothing for: ${command.split("\n")[0]}`, () => assert.deepEqual(collect(command), []));
  }

  it("reads scripts given to interpreters, in any path form", () => {
    assert.deepEqual(paths("python check.py"), ["check.py"]);
    assert.deepEqual(paths('python "dir with space/job.py"'), ["dir with space/job.py"]);
    assert.deepEqual(paths("python check.py>out.txt 2>&1"), ["check.py"]);
    assert.deepEqual(paths("python $PWD/check.py"), ["$PWD/check.py"]);
    assert.deepEqual(paths("uv run python check.py"), ["check.py"]);
    assert.deepEqual(paths("timeout 60 python check.py"), ["check.py"]);
    assert.deepEqual(paths("php task.php"), ["task.php"]);
    assert.deepEqual(paths("./runner"), ["./runner"]);
    assert.deepEqual(paths("pwsh -NoProfile -File build.ps1", "PowerShell"), ["build.ps1"]);
    assert.deepEqual(paths("& .\\build.ps1", "PowerShell"), [".\\build.ps1"]);
    assert.deepEqual(paths("node -r ./sync.mjs report.js"), ["./sync.mjs"]);
  });

  it("converts Git Bash drive paths on Windows", { skip: process.platform !== "win32" }, () => {
    const posix = "/" + fixtures[0].toLowerCase() + fixtures.slice(2).replace(/\\/g, "/");
    assert.equal(collect(`python ${posix}/check.py`).length, 1);
  });

  it("follows cd, and stops resolving after an unknown cd", () => {
    assert.deepEqual(paths("cd sub && python job.py"), ["job.py"]);
    assert.deepEqual(paths("cd $SOMEWHERE && python job.py"), []);
  });

  it("only skips the scripts it cannot reach, not later ones", () => {
    assert.deepEqual(paths("python -m py_compile a.py b.py c.py d.py && python check.py"), ["check.py"]);
  });

  it("expands npm scripts and the scripts they run", () => {
    const sources = collect("npm run prepare-env");
    assert.deepEqual(
      sources.map((s) => s.role),
      ['npm script "prepare-env" in package.json', "executed by node"],
    );
    assert.match(collect("npm run db:prep")[0].code, /until pg_isready/);
  });

  it("expands make targets with their prerequisites", () => {
    assert.match(collect("make prep")[0].code, /until curl/);
    assert.match(collect("make all")[0].code, /until curl[\s\S]*console\.log/);
  });

  it("follows one level of local imports", () => {
    assert.deepEqual(paths("python app.py"), ["app.py", "lib/helpers.py"]);
  });

  it("sends head, tail and loop lines for long files", () => {
    const [src] = collect("python long.py");
    assert.equal(src.code, undefined);
    assert.doesNotMatch(src.code_head + src.code_tail, /while True/);
    assert.ok(src.loop_related_lines.some((l) => l.includes("while True")));
  });

  it("does not read binary files or files outside the project", () => {
    assert.deepEqual(collect("python blob.py")[0].note, "not read: binary file");
    const outside = gatherSources({ toolName: "Bash", command: `python ${join(fixtures, "check.py").replace(/\\/g, "/")}`, cwd: fixtures, roots: [join(fixtures, "sub")] });
    assert.equal(outside.sources[0].note, "not read: outside the project");
  });

  it("ignores network paths and unresolvable variables", () => {
    assert.deepEqual(collect("python \\\\10.255.255.1\\share\\x.py", "PowerShell"), []);
    assert.deepEqual(collect('python "$f"'), []);
  });

  it("redacts secrets in executed code", () => {
    const [src] = collect("python settings.py");
    assert.doesNotMatch(src.code, /FAKE/);
    assert.match(src.code, /SECRET_KEY = "<redacted>"/);
  });
});

describe("redact", () => {
  it("hides common secret shapes", () => {
    const text = redact(
      'export API_KEY=abcd1234 && curl -H "Authorization: Bearer xyz.abc.def" https://user:pw123@host/ ghp_' + "a".repeat(30),
    );
    assert.doesNotMatch(text, /abcd1234|xyz\.abc|pw123|ghp_a/);
  });
});

describe("policy", () => {
  it("validates the threshold", () => {
    assert.equal(parseThreshold(undefined).value, 0.6);
    assert.equal(parseThreshold("").value, 0.6);
    assert.equal(parseThreshold("0.8").value, 0.8);
    for (const bad of ["abc", "0", "-1", "2", "Infinity"]) {
      const t = parseThreshold(bad);
      assert.equal(t.value, 0.6);
      assert.ok(t.warning);
    }
  });

  it("accepts the bypass only as a real comment with a reason", () => {
    const bypass = (cmd, shell = "bash") => findBypass(tokenize(cmd, shell).comments);
    assert.equal(bypass("for i in 1 2; do x; done # use-right-tool:allow: two fixed items"), "two fixed items");
    assert.equal(bypass("tail -f a # use-right-tool:allow"), null);
    assert.equal(bypass("echo use-right-tool:allow: x; tail -f a"), null);
    assert.equal(bypass("X='# use-right-tool:allow: x' tail -f a"), null);
    assert.equal(bypass("curl http://h/#use-right-tool:allow:x"), null);
  });

  it("uses the background policy only for a boolean true", () => {
    const answer = { probabilities: { wait_for_completion: 1 } };
    assert.equal(decide(answer, { runInBackground: "false", threshold: 0.6 }).deny, true);
    assert.equal(decide(answer, { runInBackground: true, threshold: 0.6 }).deny, false);
  });

  it("averages two answers", () => {
    const avg = averageAnswers([{ probabilities: { a: 0.8, b: 0.2 } }, { probabilities: { a: 0.4, b: 0.6 } }]);
    assert.deepEqual(avg.probabilities, { a: 0.6000000000000001, b: 0.4 });
    assert.equal(avg.choice, "a");
  });

  it("mentions the bypass only for uncertain verdicts", () => {
    assert.match(denyReason({ category: "stream_follow", blockedProb: 0.7 }), /use-right-tool:allow/);
    assert.doesNotMatch(denyReason({ category: "stream_follow", blockedProb: 0.99 }), /use-right-tool:allow/);
  });

  it("sends head, tail and loop lines for very long commands", () => {
    const command = `echo ${"x".repeat(9000)}\nsleep 120 && cat build.log`;
    const { state } = buildRequest({ toolName: "Bash", command });
    assert.equal(state.command, undefined);
    assert.match(state.command_tail, /sleep 120/);
    assert.ok(state.command_loop_related_lines.some((l) => l.includes("sleep 120")));
  });
});

// guard.mjs 를 실제 자식 프로세스로 띄우고, Jev 대신 스텁 서버에 연결한다.
async function runGuard(payload, { answers = [], env = {}, errorBody = null } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      requests.push(JSON.parse(body));
      if (errorBody) {
        res.statusCode = 500;
        res.end(errorBody);
        return;
      }
      const probabilities = answers[Math.min(requests.length - 1, answers.length - 1)] ?? { single_action: 1 };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ model: "stub", answers: { intent: { type: "choice", choice: "x", probabilities } } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const child = spawn(process.execPath, [guard], {
    env: {
      ...process.env,
      TYPESAFE_API_KEY: "test",
      USE_RIGHT_TOOL_ENDPOINT: `http://127.0.0.1:${server.address().port}/`,
      USE_RIGHT_TOOL_THRESHOLD: "",
      USE_RIGHT_TOOL_PREFILTER: "",
      USE_RIGHT_TOOL_LOG: "",
      ...env,
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  child.stdin.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  const code = await new Promise((r) => child.on("close", r));
  server.close();
  return { code, stdout, stderr, requests, denied: stdout ? JSON.parse(stdout).hookSpecificOutput.permissionDecision === "deny" : false };
}

const bash = (command, extra = {}) => ({ tool_name: "Bash", cwd: fixtures, tool_input: { command, ...extra } });

describe("rules: dedicated tools instead of the shell", () => {
  const kind = (command, shell = "bash") => toolMisuse(command, shell)?.kind ?? null;

  it("blocks writing file contents from the shell", () => {
    assert.equal(kind("cat > a.py <<'EOF'\nprint(1)\nEOF"), "write");
    assert.equal(kind("cat <<EOF > notes.md\nhi\nEOF"), "write");
    assert.equal(kind("mkdir -p src && cat >> src/a.ts << 'X'\nexport {}\nX"), "write");
    assert.equal(kind("echo 'node_modules' >> .gitignore"), "write");
    assert.equal(kind("printf '%s\\n' a b > list.txt"), "write");
    assert.equal(kind("tee config.json <<EOF\n{}\nEOF"), "write");
    assert.equal(kind("echo '{}' | tee config.json"), "write");
    assert.equal(kind("cat <<< 'x' > f.txt"), "write");
    assert.equal(kind("Set-Content -Path a.ps1 -Value 'x'", "powershell"), "write");
    assert.equal(kind("'hello' > a.txt", "powershell"), "write");
    assert.equal(kind("@'\nline\n'@ | Out-File a.txt", "powershell"), "write");
    assert.equal(kind("[IO.File]::WriteAllText('a.txt', 'x')", "powershell"), "write");
    assert.equal(kind("New-Item a.txt -Value 'x'", "powershell"), "write");
  });

  it("blocks in-place edits and inline scripts that write files", () => {
    assert.equal(kind("sed -i 's/a/b/g' src/x.c"), "edit");
    assert.equal(kind("sed -i.bak -e 's/a/b/' x"), "edit");
    assert.equal(kind("perl -pi -e 's/a/b/' x"), "edit");
    // 예시 사진의 형태: heredoc 으로 넘긴 파이썬이 파일을 고쳐 쓴다
    const screenshot = `S=/tmp/s; python - "$S/obf.py" <<'EOF'\nimport sys\np=sys.argv[1]; s=open(p,encoding='utf-8').read()\ns=s.replace('a','b')\nopen(p,'w',encoding='utf-8').write(s)\nEOF\ngrep -n x $S/obf.py`;
    assert.equal(kind(screenshot), "edit");
    assert.equal(kind(`python -c "from pathlib import Path; Path('a').write_text('x')"`), "edit");
    assert.equal(kind(`node -e "require('fs').writeFileSync('a.json', '{}')"`), "edit");
    assert.equal(kind("cat <<'EOF' | python3\nopen('x','a').write('y')\nEOF"), "edit");
    assert.equal(kind(`bash -c "echo x > a.txt"`), "write");
  });

  it("allows viewing files", () => {
    for (const command of ["cat src/a.py", "head -50 README.md", "sed -n '130,150p' src/monmove.c", "cd src && cat a.py && echo --- && cat b.py", "cat a.py | grep def"]) {
      assert.equal(kind(command), null, command);
    }
    assert.equal(kind("Get-Content .\\a.txt -TotalCount 20", "powershell"), null);
  });

  it("blocks commands that only search files", () => {
    assert.equal(kind("grep -rn 'mapping =' src"), "search");
    assert.equal(kind("rg -c Elbereth src | head -3"), "search");
    assert.equal(kind("find . -name '*.py'"), "search");
    assert.equal(kind("cat a.py && grep -rn x src"), "search");
    assert.equal(kind("ls -R src"), "search");
    assert.equal(kind("Get-ChildItem -Recurse -Filter *.cs", "powershell"), "search");
    assert.equal(kind("Select-String -Path *.ps1 -Pattern Sleep", "powershell"), "search");
  });

  it("allows output redirects, filters of other commands, and runtime work", () => {
    for (const command of [
      "npm test > out.log 2>&1",
      "git diff > change.patch",
      "git log --oneline | head -20",
      "npm test 2>&1 | tail -30",
      "git commit -m \"$(cat <<'EOF'\nfix: x\nEOF\n)\"",
      "gh pr create --body-file - <<'EOF'\nbody\nEOF",
      "python - <<'EOF'\nprint(sum(range(10)))\nEOF",
      "python report.py > out.csv",
      "ls",
      "ls -r",
      "tail -f app.log",
      "cat a.txt > b.txt",
      "find . -name '*.tmp' -delete",
      "wc -l src/*.py",
      "echo done",
      "sleep 1 2>/dev/null",
      "ps aux | grep node",
      "perl -Mstrict -e 'print 1'",
      "perl -Ilib t/basic.t",
      "env | grep -i proxy",
      "echo $PATH | grep node",
      "ls node_modules/.bin | grep jest",
      "echo $! > /tmp/server.pid",
      "sudo tee /etc/hosts <<EOF\n127.0.0.1 x\nEOF",
      "npm run build; bash -c 'grep -r foo dist'",
    ]) {
      assert.equal(kind(command), null, command);
    }
    assert.equal(kind("npm test | Out-File log.txt", "powershell"), null);
    assert.equal(kind("Get-Content a.log -Wait", "powershell"), null);
  });
});

describe("rules: skipping Jev", () => {
  const finite = (command, shell = "bash", sources = []) => obviouslyFinite(command, shell, sources);

  it("skips commands that cannot loop or wait", () => {
    for (const command of ["git status", "git add -A && git commit -m \"$(cat <<'EOF'\nmsg\nEOF\n)\"", "ls -la && pwd", "mkdir -p a/b && cp x a/b", "FOO=1 git log | head", "grep -c x a | sort", "git log -p -3 | head -50", "git -C sub status", "git commit -am wip", "git grep -e foo"]) {
      assert.ok(finite(command), command);
    }
    assert.ok(finite("Get-ChildItem | Select-Object -First 5", "powershell"));
  });

  it("asks Jev about anything that can run code, loop, wait, or follow", () => {
    for (const command of [
      "sleep 60",
      "tail -f a.log",
      "tail -F a.log | grep x",
      "find . -exec sleep 1 \\;",
      "npm test",
      "python x.py",
      "timeout 60 git fetch",
      "while true; do git status; done",
      "for f in *; do ls $f; done",
      "git status && $(sleep 9)",
      "echo $(curl x)",
      "watch git status",
      "ping -n 61 127.0.0.1",
      "nohup git gc &",
      "awk 'BEGIN { while (1) {} }'",
      "awk -f prog.awk",
      "sed '1e sleep 1000' f.txt",
      "jq -n 'repeat(1)'",
      "free -s 1",
      "cat /dev/urandom",
      "rg --pre 'sleep 1000' foo .",
      "sort --compress-program='sleep 1000' big.txt",
      "fd -Hx sleep 1000",
      "fd --exec=sleep 1000",
      "git status; tail -fn 50 app.log",
      "git status && tail -100f app.log",
      "tail --follow=name app.log",
      "cat <(watch ls)",
      // git 이 임의 명령을 실행하거나 입력·에디터를 기다리는 경우
      "git -c alias.w=\"!while true; do sleep 5; done\" w",
      "git bisect run sh -c 'sleep 1000'",
      "git rebase -x 'sleep 1000' HEAD~3",
      "git submodule foreach 'while true; do sleep 5; done'",
      "git -c core.fsmonitor='sleep 1000' status",
      "git rebase -i HEAD~3",
      "git commit",
      "git commit --amend",
      "git add -p",
      "git daemon",
    ]) {
      assert.equal(finite(command), false, command);
    }
    // PowerShell 루프는 키워드만 남은 세그먼트가 생긴다
    for (const command of [
      "while (Test-Path build.lock) { git status }",
      "while (!(Test-Path out.json)) { }",
      "do { Get-Date } until (Test-Path done.txt)",
      "& { while (Test-Path .) { } }",
      "git status; Get-Content app.log -Wait:$true",
      "Get-Content app.log -Wai",
      "Get-Content CON",
    ]) {
      assert.equal(finite(command, "powershell"), false, command);
    }
    assert.equal(finite("Get-Content a.log -Wait", "powershell"), false);
    assert.equal(finite("Get-ChildItem | ForEach-Object { Start-Sleep 1 }", "powershell"), false);
    assert.equal(finite("git status", "bash", [{ path: "x" }]), false);
  });
});

describe("guard.mjs", () => {
  it("denies when Jev says it is a wait", async () => {
    const r = await runGuard(bash("sleep 60 && cat log"), { answers: [{ wait_for_completion: 1 }] });
    assert.equal(r.code, 0);
    assert.ok(r.denied);
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, /run_in_background/);
  });

  it("allows when Jev says it is a single action", async () => {
    const r = await runGuard(bash("npm install"));
    assert.equal(r.denied, false);
    assert.equal(r.requests.length, 1);
  });

  it("does not call Jev for an obviously finite command", async () => {
    const r = await runGuard(bash("git status && git diff --stat | tail -5"), { answers: [{ stream_follow: 1 }] });
    assert.equal(r.denied, false);
    assert.equal(r.requests.length, 0);
  });

  it("denies a heredoc file write without calling Jev or needing an API key", async () => {
    const r = await runGuard(bash("cat > a.py <<'EOF'\nprint(1)\nEOF"), { env: { TYPESAFE_API_KEY: "" } });
    assert.ok(r.denied);
    assert.equal(r.requests.length, 0);
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, /`Write` tool/);
  });

  it("lets the bypass comment through a tool rule", async () => {
    const r = await runGuard(bash("sed -i 's/a/b/' x.txt # use-right-tool:allow: binary-safe rewrite"));
    assert.equal(r.denied, false);
  });

  it("asks twice and averages near the threshold", async () => {
    const r = await runGuard(bash("for i in 1 2 3; do curl x && break; sleep 5; done"), {
      answers: [{ poll_until_condition: 0.66, finite_iteration: 0.34 }, { poll_until_condition: 0.5, finite_iteration: 0.5 }],
    });
    assert.equal(r.requests.length, 2);
    assert.equal(r.denied, false);
  });

  it("does not call Jev for a valid bypass comment", async () => {
    const r = await runGuard(bash("tail -f a.log # use-right-tool:allow: test fixture"), { answers: [{ stream_follow: 1 }] });
    assert.equal(r.requests.length, 0);
    assert.equal(r.denied, false);
  });

  it("never sends files that are only viewed", async () => {
    const r = await runGuard(bash("cat settings.py"));
    assert.doesNotMatch(JSON.stringify(r.requests), /FAKE|SECRET_KEY/);
  });

  it("sends executed code with secrets redacted", async () => {
    const r = await runGuard(bash("python settings.py"));
    const sent = JSON.stringify(r.requests[0].state);
    assert.match(sent, /SECRET_KEY/);
    assert.doesNotMatch(sent, /FAKE/);
  });

  it("ignores a bad threshold with a warning instead of disabling or blocking everything", async () => {
    const blank = await runGuard(bash("git status"), { env: { USE_RIGHT_TOOL_THRESHOLD: "" } });
    assert.equal(blank.denied, false);
    const bad = await runGuard(bash("sleep 60"), { answers: [{ wait_for_completion: 1 }], env: { USE_RIGHT_TOOL_THRESHOLD: "abc" } });
    assert.ok(bad.denied);
    assert.match(bad.stderr, /not a number/);
  });

  it("fails open on bad input or missing key", async () => {
    for (const payload of ["", "not json", JSON.stringify({ tool_name: "Bash", tool_input: { command: ["x"] } })]) {
      const r = await runGuard(payload);
      assert.equal(r.code, 0);
      assert.equal(r.denied, false);
    }
    const noKey = await runGuard(bash("tail -f a"), { answers: [{ stream_follow: 1 }], env: { TYPESAFE_API_KEY: "" } });
    assert.equal(noKey.requests.length, 0);
    assert.equal(noKey.denied, false);
  });

  it("skips Jev in prefilter mode when nothing looks like a loop", async () => {
    const r = await runGuard(bash("git status"), { env: { USE_RIGHT_TOOL_PREFILTER: "1" } });
    assert.equal(r.requests.length, 0);
    const viaScript = await runGuard(bash("python check.py"), { answers: [{ poll_until_condition: 1 }], env: { USE_RIGHT_TOOL_PREFILTER: "1" } });
    assert.ok(viaScript.denied);
  });

  it("finishes quickly on a huge command", async () => {
    const start = Date.now();
    const r = await runGuard(bash(`echo ${"QUJD".repeat(250000)} | base64 -d`));
    assert.equal(r.code, 0);
    assert.ok(Date.now() - start < 5000, `took ${Date.now() - start} ms`);
  });
});


// 두 번째 적대적 검증에서 나온 사례들
describe("second review", () => {
  it("does not take a comment out of a bash ANSI-C string", () => {
    const command = "echo $'hello\\'\n# use-right-tool:allow: forged\nworld'; sleep 60";
    assert.equal(findBypass(tokenize(command, "bash").comments), null);
  });

  it("does not take a comment out of a command substitution inside double quotes", () => {
    const command = 'echo "$(echo "x" # use-right-tool:allow: forged\n)"; sleep 60';
    assert.equal(findBypass(tokenize(command, "bash").comments), null);
  });

  for (const command of [
    "python -c\"print('OK')\" settings.py",
    "python -Bc 'print(1)' settings.py",
    "python --help settings.py",
    "python -V",
    'node --eval="console.log(1)" sync.mjs',
    "node -pe 1 sync.mjs",
    "node --check sync.mjs",
    "php -l task.php",
    "ruby -c check.py",
    "make -n prep",
    "make --dry-run all",
  ]) {
    it(`reads nothing for an option that does not run the file: ${command}`, () => assert.deepEqual(collect(command), []));
  }

  it("still reads scripts behind options that do run them", () => {
    assert.deepEqual(paths("python -v check.py"), ["check.py"]);
    assert.deepEqual(paths("python -W ignore check.py"), ["check.py"]);
    assert.deepEqual(paths("node -- sync.mjs"), ["sync.mjs"]);
    assert.deepEqual(paths("bash -x runner"), ["runner"]);
    assert.deepEqual(paths("make -j 4 prep").length, 1);
  });

  it("reads modules preloaded with node -r even with inline code", () => {
    const sources = collect('node -r ./sync.mjs -e "1"');
    assert.deepEqual(sources.map((s) => [s.path, s.role]), [["./sync.mjs", "preloaded by node"]]);
  });

  it("reads scripts run inside command substitutions", () => {
    assert.deepEqual(paths("echo $(python check.py)"), ["check.py"]);
    assert.deepEqual(paths('x="$(node sync.mjs)"'), ["sync.mjs"]);
    assert.deepEqual(paths("echo `php task.php`"), ["task.php"]);
    assert.deepEqual(paths('$x = "$(python check.py)"', "PowerShell"), ["check.py"]);
  });

  it("keeps the directory after a subshell cd or a failed cd", () => {
    assert.deepEqual(paths("(cd sub); python check.py"), ["check.py"]);
    assert.deepEqual(paths("(cd sub && python job.py); python check.py"), ["job.py", "check.py"]);
    assert.deepEqual(paths("cd nonexistent || python check.py"), ["check.py"]);
  });

  it("treats a quoted PowerShell path as a string unless it is invoked with &", () => {
    assert.deepEqual(paths('".\\build.ps1"', "PowerShell"), []);
    assert.deepEqual(paths('& ".\\build.ps1"', "PowerShell"), [".\\build.ps1"]);
  });

  it("ignores imports inside comments and docstrings", () => {
    assert.deepEqual(paths("python commented.py"), ["commented.py"]);
  });

  it("does not follow a package.json or makefile linked outside the project", (t) => {
    const base = mkdtempSync(join(tmpdir(), "urt-"));
    try {
      const project = join(base, "project");
      const outside = join(base, "outside");
      mkdirSync(project);
      mkdirSync(outside);
      writeFileSync(join(outside, "package.json"), JSON.stringify({ scripts: { test: "echo OUTSIDE_SECRET" } }));
      writeFileSync(join(outside, "Makefile"), "test:\n\techo OUTSIDE_SECRET\n");
      try {
        symlinkSync(outside, join(project, "pkg"), "junction");
      } catch {
        t.skip("cannot create a directory link here");
        return;
      }
      const run = (command) => gatherSources({ toolName: "Bash", command, cwd: join(project, "pkg"), roots: [project] }).sources;
      assert.deepEqual(run("npm test"), []);
      assert.deepEqual(run("make test"), []);
      const viaFlag = gatherSources({ toolName: "Bash", command: "make -f pkg/Makefile test", cwd: project, roots: [project] }).sources;
      assert.deepEqual(viaFlag, []);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("redacts quoted secrets with spaces or #", () => {
    const text = redact(`API_KEY="abcdef ghijkl"\nPASSWORD='abc#defgh'\ntoken: "x y z w"`);
    assert.doesNotMatch(text, /abcdef|defgh|x y z/);
  });

  it("redacts many PEM markers in linear time", () => {
    const text = "-----BEGIN RSA PRIVATE KEY-----\nabc\n".repeat(20000);
    const start = Date.now();
    assert.equal(redact(text), "<redacted private key>");
    assert.ok(Date.now() - start < 300, `took ${Date.now() - start} ms`);
  });

  it("finds a wait in the middle of a very long single line", () => {
    const command = `echo ${"A".repeat(12000)}; sleep 120; echo ${"B".repeat(12000)}`;
    const { state } = buildRequest({ toolName: "Bash", command });
    assert.ok(state.command_loop_related_lines.some((l) => l.includes("sleep 120")));
  });

  it("fails open on malformed probabilities from the API", async () => {
    for (const answers of [[{ single_action: 1, wait_for_completion: 2 }], [{ wait_for_completion: "0.7", single_action: 0.3 }], [{ made_up: 1 }]]) {
      const r = await runGuard(bash("sleep 60"), { answers });
      assert.equal(r.denied, false);
      assert.match(r.stderr, /no valid intent probabilities/);
    }
  });

  it("redacts the bypass reason in the log", async () => {
    const log = join(mkdtempSync(join(tmpdir(), "urt-log-")), "log.jsonl");
    await runGuard(bash("echo ok # use-right-tool:allow: API_KEY=abcdef123456"), { env: { USE_RIGHT_TOOL_LOG: log } });
    const written = readFileSync(log, "utf8");
    assert.match(written, /"bypass"/);
    assert.doesNotMatch(written, /abcdef123456/);
  });
  it("never touches network paths given to make -f or just --justfile", () => {
    const start = Date.now();
    assert.deepEqual(collect("make -f //10.255.255.1/share/Makefile prep"), []);
    assert.deepEqual(collect("just --justfile //10.255.255.1/share/justfile x"), []);
    assert.deepEqual(collect("make -f \\\\10.255.255.1\\share\\Makefile prep", "PowerShell"), []);
    assert.ok(Date.now() - start < 1000, `took ${Date.now() - start} ms`);
  });

  it("redacts secrets placed in a script path", () => {
    const [src] = collect('python "API_KEY=abcdef123456/../settings.py"');
    assert.ok(src, "settings.py should still be found");
    assert.doesNotMatch(JSON.stringify(src), /abcdef123456/);
  });

  it("finishes quickly on megabytes of PEM markers", async () => {
    const start = Date.now();
    // echo 는 이제 Jev 를 건너뛰므로 같은 길이의 다른 명령을 쓴다(잘리는 위치가 같아야 한다).
    const r = await runGuard(bash(`curl "${"-----BEGIN PRIVATE KEY-----".repeat(100000)}"`));
    assert.equal(r.code, 0);
    assert.ok(Date.now() - start < 5000, `took ${Date.now() - start} ms`);
    assert.equal(r.requests.length, 1);
    assert.doesNotMatch(JSON.stringify(r.requests[0]), /BEGIN PRIVATE KEY/);
  });

  it("redacts secrets in API error bodies", async () => {
    const log = join(mkdtempSync(join(tmpdir(), "urt-log-")), "log.jsonl");
    const r = await runGuard(bash("sleep 60"), { errorBody: "API_KEY=errorsecret123456", env: { USE_RIGHT_TOOL_LOG: log } });
    assert.equal(r.denied, false);
    assert.doesNotMatch(r.stderr + readFileSync(log, "utf8"), /errorsecret123456/);
  });
  it("treats a trailing & as background, not a call operator", () => {
    assert.deepEqual(paths("& .\\build.ps1 & python check.py", "PowerShell"), [".\\build.ps1", "check.py"]);
    assert.deepEqual(paths("cd sub & python check.py"), ["check.py"]);
  });

  it("keeps code visible after redaction and hides short or long values", () => {
    assert.equal(redact("tokenizer = while(true){sleep(60)}"), "tokenizer = while(true){sleep(60)}");
    assert.match(redact("token=$(sleep 60); echo done"), /sleep 60/);
    assert.equal(redact("API_KEY=abc"), "API_KEY=<redacted>");
    assert.equal(redact(`API_KEY=${"a".repeat(5000)} next`), "API_KEY=<redacted> next");
    assert.equal(redact(`TYPESAFE_API_KEY = "very secret value"`), `TYPESAFE_API_KEY = "<redacted>"`);
  });

  it("stays fast on repeated key names", () => {
    const start = Date.now();
    redact("token=".repeat(200000));
    assert.ok(Date.now() - start < 500, `took ${Date.now() - start} ms`);
  });

  it("finds a wait after many short lines", () => {
    const command = `${"echo padding\n".repeat(20000)}sleep 60\n${"echo end\n".repeat(400)}`;
    const start = Date.now();
    const { state } = buildRequest({ toolName: "Bash", command });
    assert.ok(state.command_loop_related_lines.some((l) => l.includes("sleep 60")));
    assert.ok(Date.now() - start < 1000, `took ${Date.now() - start} ms`);
  });
});
