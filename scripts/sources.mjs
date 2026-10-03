// 명령이 "실제로 실행할" 코드만 모은다.
// - 인터프리터에 넘긴 스크립트(python x.py, pwsh -File x.ps1 ...), 직접 실행(./x), source/.
// - npm/pnpm/yarn/bun 스크립트, make/just 타깃의 본문
// - 위 스크립트가 불러오는 로컬 모듈(한 단계)
// cat/code/black/git 처럼 파일을 보기만 하는 명령의 인자는 읽지 않는다.
// 프로젝트 밖, 네트워크 경로, 바이너리는 읽지 않고, 읽는 양과 시도 횟수에 상한을 둔다.

import { closeSync, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { redact } from "./redact.mjs";
import { tokenize } from "./shell.mjs";
import { loopRelatedLines } from "./signals.mjs";

const MAX_SOURCES = 5;
const MAX_STATS = 40;
const MAX_DEPTH = 2;
const MAX_NESTING = 3;
const WHOLE_FILE_BYTES = 256 * 1024;
const PART_BYTES = 64 * 1024;
const FULL_CODE_CHARS = 6000;
const HEAD_CHARS = 3500;
const TAIL_CHARS = 1500;

const PYTHON = /^(python[\d.]*|py|pythonw|pypy[\d.]*)$/;
const NODE_LIKE = new Set(["node", "nodejs", "nodemon", "tsx", "ts-node", "ts-node-esm", "esno", "vite-node", "deno", "bun"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish", "busybox"]);
const POWERSHELL = new Set(["pwsh", "powershell"]);
const OTHER_INTERPRETERS = new Set(["ruby", "perl", "php", "lua", "luajit", "rscript", "julia", "groovy", "elixir", "tclsh", "osascript"]);
const CD = new Set(["cd", "chdir", "pushd", "set-location", "sl", "push-location"]);
const KEYWORDS = new Set(["do", "then", "else", "elif", "if", "while", "until", "!", "time", "exec", "command", "builtin", "nohup", "sudo", "doas", "xvfb-run"]);
const NODE_INLINE = new Set(["-e", "--eval", "-p", "--print"]);
const NODE_VALUE_FLAGS = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader", "-C", "--conditions", "--title", "--inspect-port", "--env-file", "--input-type"]);
const PWSH_INLINE = new Set(["-command", "-c", "-encodedcommand", "-ec", "-e"]);
const PWSH_VALUE_FLAGS = new Set(["-executionpolicy", "-ep", "-windowstyle", "-w", "-workingdirectory", "-wd", "-outputformat", "-of", "-inputformat", "-if", "-configurationname", "-version", "-v", "-settingsfile"]);
const SCRIPT_EXT = /\.(py|pyw|js|mjs|cjs|ts|mts|cts|tsx|jsx|sh|bash|zsh|ps1|psm1|cmd|bat|rb|pl|php|lua|r|go)$/i;
const JS_EXT = /\.(js|mjs|cjs|ts|mts|cts|tsx|jsx)$/i;
const JS_RESOLVE = ["", ".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".tsx", ".jsx", "/index.js", "/index.ts", "/index.mjs"];

const commandName = (word) => basename(word.replace(/\\/g, "/")).toLowerCase().replace(/\.exe$/, "");

function isNetworkPath(p) {
  return /^(\\\\|\/\/)/.test(p);
}

function insideRoots(p, roots) {
  return roots.some((root) => {
    const rel = relative(root, p);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

/**
 * @param {{ toolName: string, command: string, cwd?: string, roots?: string[] }} input
 * @returns {{ shell: "bash" | "powershell", comments: string[], sources: object[] }}
 */
export function gatherSources({ toolName, command, cwd, roots }) {
  const shell = toolName === "PowerShell" ? "powershell" : "bash";
  const start = cwd ?? process.cwd();
  const ctx = {
    roots: (roots ?? [start, process.env.CLAUDE_PROJECT_DIR]).filter((r) => r && !isNetworkPath(r)).map(realRoot),
    stats: 0,
    sources: [],
    seen: new Set(),
  };
  const { comments } = tokenize(command, shell);
  if (!isNetworkPath(start)) analyze(ctx, command, shell, resolve(start), 0);

  // 실행되는 스크립트가 불러오는 로컬 모듈을 한 단계 따라간다.
  for (const src of [...ctx.sources]) {
    if (!src.file || src.role.startsWith("imported")) continue;
    for (const dep of localImports(ctx, src.file, src.text)) {
      addFile(ctx, dep, `imported by ${src.path}`);
    }
  }

  // 경로와 역할 문자열도 Jev 와 로그로 나가므로 가린다(경로에 비밀값을 넣는 경우).
  const sources = ctx.sources.map(({ file, text, path, role, ...rest }) => ({ path: redact(path), role: redact(role), ...rest }));
  return { shell, comments, sources };
}

function realRoot(root) {
  try {
    return realpathSync.native(resolve(root));
  } catch {
    return resolve(root);
  }
}

// npm 스크립트와 make 레시피 본문은 sh 문법으로 읽는다.
function analyze(ctx, command, shell, cwd, depth, nesting = 0) {
  const { segments, substitutions } = tokenize(command, shell);
  // bash 의 ( ... ) 서브셸 안에서 바꾼 디렉터리는 밖으로 새지 않는다.
  const heres = [cwd];
  let level = 0;
  for (const raw of segments) {
    const d = shell === "bash" ? raw.depth ?? 0 : 0;
    while (level < d) heres[++level] = heres[level - 1];
    level = d;
    const here = heres[level];

    // PowerShell 에서 따옴표로 시작하는 세그먼트는 실행이 아니라 문자열 값이다(& 로 호출할 때만 실행).
    if (shell === "powershell" && raw.firstQuoted) continue;
    const words = stripPrefix(raw, shell);
    if (!words.length) continue;
    const name = commandName(words[0]);
    if (CD.has(name)) {
      if (!raw.background) heres[level] = changeDir(ctx, shell, here, words.slice(1));
      continue;
    }
    for (const target of executedTargets(shell, words)) {
      if (ctx.sources.length >= MAX_SOURCES) return;
      if (target.kind === "file") {
        const file = expandPath(shell, target.value, here);
        if (file) addFile(ctx, file, target.role, target.value);
      } else if (target.kind === "pymodule") {
        const file = pythonModule(ctx, target.value, here);
        if (file) addFile(ctx, file, `run as python module ${target.value}`);
      } else if (target.kind === "npm") {
        addPackageScript(ctx, target, here, depth);
      } else if (target.kind === "make" || target.kind === "just") {
        addRecipe(ctx, target, shell, here, depth);
      }
    }
  }
  // $(...) 와 `...` 안의 명령도 실행된다. 깊게 중첩된 치환은 몇 단계까지만 본다.
  if (nesting >= MAX_NESTING) return;
  for (const inner of substitutions) {
    if (ctx.sources.length >= MAX_SOURCES) return;
    analyze(ctx, inner, shell, cwd, depth, nesting + 1);
  }
}

// 키워드, 환경 변수 할당, sudo/env/timeout/npx 같은 래퍼를 걷어 내고 실제 명령을 남긴다.
function stripPrefix(words, shell) {
  let k = 0;
  while (k < words.length) {
    const w = words[k];
    const lw = commandName(w);
    if (KEYWORDS.has(lw)) k++;
    else if (shell === "bash" && /^[A-Za-z_]\w*=/.test(w)) k++;
    else if (shell === "powershell" && w === "&") k++;
    else if (lw === "env") {
      k++;
      while (k < words.length && (words[k].includes("=") || words[k].startsWith("-"))) k++;
    } else if (lw === "nice") {
      k++;
      if (words[k] === "-n") k += 2;
      else if (/^-\d+$/.test(words[k] ?? "")) k++;
    } else if (lw === "timeout" && /^-|^\d/.test(words[k + 1] ?? "")) {
      k++;
      while (k < words.length && words[k].startsWith("-")) k += /^(-s|-k|--signal|--kill-after)$/.test(words[k]) ? 2 : 1;
      k++;
    } else if (lw === "stdbuf" || lw === "npx" || lw === "bunx" || lw === "pnpx") {
      k++;
      while (k < words.length && words[k].startsWith("-")) k++;
    } else if ((lw === "pnpm" || lw === "yarn") && (words[k + 1] === "exec" || words[k + 1] === "dlx")) {
      k += 2;
    } else if (/^(uv|poetry|pipenv|pdm|hatch|rye|conda)$/.test(lw) && words[k + 1] === "run") {
      k += 2;
      while (k < words.length && words[k].startsWith("-")) k += /^(-n|--name|-p|--prefix|--with)$/.test(words[k]) ? 2 : 1;
    } else break;
  }
  return words.slice(k);
}

// -h, -v, -V 는 인터프리터마다 뜻이 달라서(bash -v 는 자세히 출력하며 실행) 인터프리터별 noRun 에 둔다.
const HELP_FLAGS = new Set(["--help", "--version", "-?"]);

// 인터프리터 인자를 훑어 실행되는 스크립트를 찾는다.
// - noRun: 실행하지 않는 옵션(문법 검사, 린트, 도움말) → 아무것도 실행되지 않음
// - inline: 인라인 코드 옵션(-c, -e ...). 코드는 명령 안에 있으므로 파일은 없음. `-c"..."`, `--eval=...` 처럼 붙여 써도 인식
// - values: 값을 하나 받는 옵션. `preload` 에 든 옵션의 값은 먼저 실행되는 모듈이다(node -r).
// - `--` 뒤의 첫 인자는 옵션처럼 보여도 스크립트다.
function scanInterpreter(args, { noRun = new Set(), inline = new Set(), values = new Set(), preload = new Set(), clusters = false }) {
  const out = { preloads: [], script: null, inline: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      out.script = args[i + 1] ?? null;
      return out;
    }
    if (a === "-") return { ...out, inline: true };
    if (!a.startsWith("-")) {
      out.script = a;
      return out;
    }
    const [flag, attached] = a.startsWith("--") ? a.split(/=(.*)/s) : [a.slice(0, 2), a.length > 2 ? a.slice(2) : undefined];
    const full = a.startsWith("--") ? flag : a;
    if (noRun.has(full) || noRun.has(flag) || HELP_FLAGS.has(full)) return { preloads: [], script: null, inline: false, noRun: true };
    if (inline.has(full) || inline.has(flag)) return { ...out, inline: true };
    if (clusters && /^-[A-Za-z]{2,}$/.test(a)) {
      // python -Bc "code", -Wd 처럼 짧은 옵션이 붙어 있는 경우
      const letters = a.slice(1);
      if ([...letters].some((ch) => inline.has(`-${ch}`))) return { ...out, inline: true };
      if ([...letters].some((ch) => noRun.has(`-${ch}`))) return { preloads: [], script: null, inline: false, noRun: true };
      continue;
    }
    if (values.has(full) || values.has(flag)) {
      const value = attached ?? args[++i];
      if ((preload.has(full) || preload.has(flag)) && value) out.preloads.push(value);
    }
  }
  return out;
}

// 첫 번째 옵션이 아닌 인자. 패키지 매니저와 go run 처럼 단순한 경우에 쓴다.
function firstOperand(args) {
  return args.find((a) => !a.startsWith("-")) ?? null;
}

function executedTargets(shell, words) {
  const name = commandName(words[0]);
  const args = words.slice(1);
  const via = (role, value) => (value ? [{ kind: "file", value, role }] : []);
  const role = `executed by ${name}`;

  if (PYTHON.test(name)) {
    const scan = scanInterpreter(args, { noRun: new Set(["-h", "-V"]), inline: new Set(["-c"]), values: new Set(["-W", "-X", "-Q"]), clusters: true });
    // -m 은 값이 아니라 "이후 인자는 모듈 이름과 그 인자"라는 뜻이다.
    const m = args.findIndex((a) => a === "-m" || /^-m\w/.test(a));
    if (m >= 0 && (!scan.script || args.indexOf(scan.script) > m)) {
      const mod = args[m] === "-m" ? args[m + 1] : args[m].slice(2);
      return mod && !scan.inline ? [{ kind: "pymodule", value: mod }] : [];
    }
    return scan.inline ? [] : via(role, scan.script);
  }
  if (NODE_LIKE.has(name)) {
    let rest = args;
    if (name !== "node" && (rest[0] === "run" || rest[0] === "watch")) rest = rest.slice(1);
    if (name === "deno" && /^(eval|repl|task|test|fmt|lint|check|info|doc|compile|bench)$/.test(rest[0] ?? "")) return [];
    const scan = scanInterpreter(rest, {
      noRun: new Set(["-c", "--check", "-h", "-v"]),
      inline: NODE_INLINE,
      values: NODE_VALUE_FLAGS,
      preload: new Set(["-r", "--require", "--import", "--loader", "--experimental-loader"]),
    });
    const preloads = scan.preloads.filter((p) => /^\.{0,2}[\\/]|^[A-Za-z]:[\\/]/.test(p)).map((p) => ({ kind: "file", value: p, role: `preloaded by ${name}` }));
    if (scan.inline || !scan.script) return preloads;
    // `bun dev`, `bun run dev` 처럼 파일이 아니면 package.json 스크립트로 본다.
    if (name === "bun" && !SCRIPT_EXT.test(scan.script) && !/[\\/]/.test(scan.script)) return [...preloads, { kind: "npm", value: scan.script, runner: "bun" }];
    return [...preloads, ...via(role, scan.script)];
  }
  if (SHELLS.has(name)) {
    const scan = scanInterpreter(args, { noRun: new Set(["-n"]), inline: new Set(["-c"]), values: new Set(["-o", "+o", "-O", "+O"]), clusters: true });
    return scan.inline ? [] : via(role, scan.script);
  }
  if (POWERSHELL.has(name)) {
    for (let i = 0; i < args.length; i++) {
      const a = args[i].toLowerCase();
      if (a === "-file" || a === "-f") return via(role, args[i + 1]);
      if (PWSH_INLINE.has(a) || /^-(help|\?)$/.test(a) || a === "-version" || a === "-v") return [];
      if (PWSH_VALUE_FLAGS.has(a)) i++;
      else if (!a.startsWith("-")) return via(role, args[i]);
    }
    return [];
  }
  if (OTHER_INTERPRETERS.has(name)) {
    const options = {
      php: { noRun: new Set(["-l", "-s", "-i", "-m", "-h", "-v", "--syntax-check"]), inline: new Set(["-r"]), values: new Set(["-d", "-c"]) },
      ruby: { noRun: new Set(["-c", "-y", "-h"]), inline: new Set(["-e"]), values: new Set(["-I", "-r", "-C"]) },
      perl: { noRun: new Set(["-c", "-v", "-h"]), inline: new Set(["-e", "-E"]), values: new Set(["-I", "-M", "-m"]) },
    }[name] ?? { inline: new Set(["-e", "-E"]), values: new Set(["-I", "-d", "-x"]) };
    const scan = scanInterpreter(args, options);
    if (name === "php" && !scan.script) {
      const f = args.indexOf("-f");
      if (f >= 0) return via(role, args[f + 1]);
    }
    return scan.inline ? [] : via(role, scan.script);
  }
  if (name === "go" && args[0] === "run") {
    const target = firstOperand(args.slice(1));
    if (!target) return [];
    return via("executed by go run", target.endsWith(".go") ? target : join(target, "main.go"));
  }
  if (name === "cmd") {
    const i = args.findIndex((a) => /^\/[ck]$/i.test(a));
    if (i < 0 || !args[i + 1]) return [];
    const rest = stripPrefix(args.slice(i + 1), shell);
    return rest.length ? executedTargets(shell, rest) : [];
  }
  if (name === "call") return via("executed by call", args[0]);
  if (name === "source" || name === ".") return via("sourced", args[0]);
  if (name === "npm") {
    const sub = args[0] ?? "";
    if (/^(run|run-script|rum|urn)$/.test(sub)) {
      const script = firstOperand(args.slice(1));
      return script ? [{ kind: "npm", value: script, runner: "npm" }] : [];
    }
    if (/^(start|restart)$/.test(sub)) return [{ kind: "npm", value: "start", runner: "npm" }];
    if (/^(test|t|tst)$/.test(sub)) return [{ kind: "npm", value: "test", runner: "npm" }];
    return [];
  }
  if (name === "pnpm" || name === "yarn") {
    const script = firstOperand(args[0] === "run" ? args.slice(1) : args);
    return script ? [{ kind: "npm", value: script, runner: name }] : [];
  }
  if (name === "make" || name === "gmake" || name === "just") {
    // 실행하지 않고 출력·목록만 보여 주는 옵션
    const dry =
      name === "just"
        ? /^(-n|--dry-run|-l|--list|-s|--show|--summary|--evaluate|--dump|--variables|--choose|--edit|--init|--fmt|-h|--help|-V|--version)$/
        : /^(-[a-zA-Z]*[nq][a-zA-Z]*|--dry-run|--just-print|--recon|--question|-h|--help|-v|--version)$/;
    if (args.some((a) => dry.test(a) && a !== "-C")) return [];
    let dir = null;
    let file = null;
    let target = null;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-C" || a === "--directory" || (a === "-d" && name === "just")) dir = args[++i];
      else if (a.startsWith("--directory=")) dir = a.slice("--directory=".length);
      else if (a === "-f" || a === "--file" || a === "--justfile") file = args[++i];
      else if (a.startsWith("--file=")) file = a.slice("--file=".length);
      else if ((a === "-j" || a === "-l") && /^\d+$/.test(args[i + 1] ?? "")) i++;
      else if (!a.startsWith("-") && !a.includes("=") && !target) target = a;
    }
    return [{ kind: name === "just" ? "just" : "make", value: target, dir, file }];
  }
  // ./x, .\x.ps1, scripts/x.sh, C:/x.py 처럼 경로로 직접 실행하는 경우
  if (/[\\/]/.test(words[0]) || SCRIPT_EXT.test(words[0])) return via("run directly", words[0]);
  return [];
}

function expandPath(shell, raw, here) {
  let p = raw;
  if (p === "~" || /^~[\\/]/.test(p)) p = homedir() + p.slice(1);
  if (here) p = p.replace(/^\$(\{PWD\}|PWD)(?=[\\/]|$)/, here);
  p = p.replace(/^\$(\{HOME\}|HOME)(?=[\\/]|$)/, homedir());
  p = p.replace(/^\$env:(USERPROFILE|HOME)(?=[\\/]|$)/i, homedir());
  if (/[$`*?]/.test(p)) return null; // 해석할 수 없는 변수나 와일드카드
  if (shell === "bash" && process.platform === "win32") {
    const m = /^\/([a-zA-Z])(\/.*|$)/.exec(p);
    if (m) p = `${m[1].toUpperCase()}:${m[2] || "/"}`;
  }
  if (isNetworkPath(p)) return null;
  if (isAbsolute(p)) return resolve(p);
  return here ? resolve(here, p) : null;
}

// cd 대상이 해석되지 않으면 null 을 돌려주고, 이후 상대 경로는 읽지 않는다.
// 없는 디렉터리로 cd 하면 실패하므로 현재 디렉터리가 그대로 유지된다.
function changeDir(ctx, shell, here, args) {
  const target = args.find((a) => !/^(-|\/d$)/i.test(a));
  if (target === undefined) return homedir();
  const dir = expandPath(shell, target, here);
  if (!dir || ctx.stats >= MAX_STATS) return null;
  ctx.stats++;
  try {
    return statSync(dir).isDirectory() ? dir : here;
  } catch {
    return here;
  }
}

// 일반 파일이면서 프로젝트 안에 있는지 확인한다. 아니면 null.
function checkFile(ctx, file) {
  if (!file || isNetworkPath(file) || ctx.stats >= MAX_STATS) return null;
  ctx.stats++;
  try {
    if (!statSync(file).isFile()) return null;
    const real = realpathSync.native(file);
    return { real, inside: insideRoots(real, ctx.roots) };
  } catch {
    return null;
  }
}

function readBounded(file) {
  let fd;
  try {
    fd = openSync(file, "r");
    // 확인한 뒤 다른 종류의 파일로 바뀌었을 수 있으므로 연 핸들을 다시 확인한다.
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    const size = st.size;
    const read = (position, length) => {
      const buf = Buffer.alloc(length);
      const n = readSync(fd, buf, 0, length, position);
      return buf.subarray(0, n);
    };
    if (size <= WHOLE_FILE_BYTES) {
      const buf = read(0, size);
      return { buf, text: buf.toString("utf8"), partial: false };
    }
    const head = read(0, PART_BYTES);
    const tail = read(size - PART_BYTES, PART_BYTES);
    return { buf: head, text: `${head.toString("utf8")}\n…\n${tail.toString("utf8")}`, partial: true };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Jev에 보낼 코드 표현. 짧으면 전체, 길면 앞·뒤와 루프 관련 줄.
export function codeView(text, partial = false) {
  const clean = redact(text);
  if (!partial && clean.length <= FULL_CODE_CHARS) return { code: clean };
  return {
    code_head: clean.slice(0, HEAD_CHARS),
    code_tail: clean.slice(-TAIL_CHARS),
    loop_related_lines: loopRelatedLines(clean),
  };
}

function addSource(ctx, key, source) {
  if (ctx.seen.has(key) || ctx.sources.length >= MAX_SOURCES) return false;
  ctx.seen.add(key);
  ctx.sources.push(source);
  return true;
}

function addFile(ctx, file, role, shown) {
  const checked = checkFile(ctx, file);
  if (!checked) return;
  const path = shown ?? displayPath(ctx, checked.real);
  if (!checked.inside) {
    // 프로젝트 밖의 실행 파일(/usr/bin/git 등)은 스크립트가 아니면 언급하지 않는다.
    if (role === "run directly" && !SCRIPT_EXT.test(file)) return;
    addSource(ctx, checked.real, { path, role, note: "not read: outside the project" });
    return;
  }
  const read = readBounded(checked.real);
  if (!read) return;
  if (read.buf.subarray(0, 8000).includes(0)) {
    addSource(ctx, checked.real, { path, role, note: "not read: binary file" });
    return;
  }
  addSource(ctx, checked.real, { path, role, ...codeView(read.text, read.partial), file: checked.real, text: read.text });
}

function displayPath(ctx, file) {
  for (const root of ctx.roots) {
    const rel = relative(root, file);
    if (!rel.startsWith("..") && !isAbsolute(rel)) return rel.replace(/\\/g, "/");
  }
  return file;
}

function pythonModule(ctx, mod, here) {
  if (!here || !/^[\w.]+$/.test(mod)) return null;
  const parts = mod.split(".");
  for (const candidate of [join(here, ...parts) + ".py", join(here, ...parts, "__main__.py")]) {
    if (checkFile(ctx, candidate)) return candidate;
  }
  return null;
}

// 프로젝트 안에서 위로 올라가며 이름이 맞는 첫 파일을 찾는다.
// 찾은 파일이 심볼릭 링크로 프로젝트 밖을 가리키면 쓰지 않는다.
function findUp(ctx, start, names) {
  let dir = start;
  for (let level = 0; level < 8 && dir; level++) {
    if (!insideRoots(dir, ctx.roots)) return null;
    for (const name of names) {
      const checked = checkFile(ctx, join(dir, name));
      if (checked) return checked.inside ? checked.real : null;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function addPackageScript(ctx, { value, runner }, here, depth) {
  if (!here) return;
  const pkgFile = findUp(ctx, here, ["package.json"]);
  if (!pkgFile) return;
  const read = readBounded(pkgFile);
  let body;
  try {
    body = JSON.parse(read?.text ?? "").scripts?.[value];
  } catch {
    return;
  }
  if (typeof body !== "string") return;
  const role = `${runner} script "${value}" in ${displayPath(ctx, pkgFile)}`;
  if (!addSource(ctx, `${pkgFile}#${value}`, { path: displayPath(ctx, pkgFile), role, code: redact(body) })) return;
  if (depth < MAX_DEPTH) analyze(ctx, body, "bash", dirname(pkgFile), depth + 1);
}

function addRecipe(ctx, { kind, value, dir, file }, shell, here, depth) {
  const base = dir ? expandPath(shell, dir, here) : here;
  if (!base) return;
  const names = file ? [file] : kind === "make" ? ["GNUmakefile", "makefile", "Makefile"] : ["justfile", "Justfile", ".justfile"];
  let recipeFile;
  if (file) {
    // expandPath 가 네트워크 경로와 해석할 수 없는 변수를 걸러 낸다.
    const checked = checkFile(ctx, expandPath(shell, file, base));
    recipeFile = checked?.inside ? checked.real : null;
  } else recipeFile = findUp(ctx, base, names);
  if (!recipeFile) return;
  const read = readBounded(recipeFile);
  if (!read) return;
  const recipe = kind === "make" ? makeRecipe(read.text, value) : justRecipe(read.text, value);
  if (!recipe) return;
  const role = `${kind} target "${recipe.target}" in ${displayPath(ctx, recipeFile)}`;
  if (!addSource(ctx, `${recipeFile}#${recipe.target}`, { path: displayPath(ctx, recipeFile), role, code: redact(recipe.body) })) return;
  if (depth < MAX_DEPTH) analyze(ctx, recipe.body, "bash", dirname(recipeFile), depth + 1);
}

// Makefile에서 타깃의 레시피를 꺼낸다. 같은 파일 안의 선행 타깃 레시피도 한 단계 포함한다.
function makeRecipe(text, wanted) {
  const rules = new Map();
  let current = null;
  let first = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("\t")) {
      if (current) current.lines.push(line.slice(1).replace(/^[@+-]+/, ""));
      continue;
    }
    const m = /^([^\s:#=][^:=]*?)\s*::?(?!=)\s*([^;#]*)/.exec(line);
    if (m) {
      const rule = { prereqs: m[2].trim().split(/\s+/).filter(Boolean), lines: [] };
      for (const t of m[1].trim().split(/\s+/)) {
        rules.set(t, rule);
        if (!first && !t.startsWith(".")) first = t;
      }
      current = rule;
    } else if (line.trim()) current = null;
  }
  const target = wanted ?? first;
  const rule = rules.get(target);
  if (!rule) return null;
  const body = [...rule.prereqs.flatMap((p) => rules.get(p)?.lines ?? []), ...rule.lines].join("\n");
  return body.trim() ? { target, body } : null;
}

function justRecipe(text, wanted) {
  const lines = text.split(/\r?\n/);
  let target = wanted;
  for (let i = 0; i < lines.length; i++) {
    const m = /^@?([A-Za-z_][\w-]*)[^:=]*:(?!=)/.exec(lines[i]);
    if (!m) continue;
    target ??= m[1];
    if (m[1] !== target) continue;
    const body = [];
    for (let j = i + 1; j < lines.length && /^\s+\S|^\s*$/.test(lines[j]); j++) body.push(lines[j].trim().replace(/^[@-]+/, ""));
    const joined = body.join("\n").trim();
    return joined ? { target, body: joined } : null;
  }
  return null;
}

function localImports(ctx, file, text) {
  const dir = dirname(file);
  const found = [];
  const ext = extname(file).toLowerCase();
  // 주석과 문서 문자열 안의 import 는 실행되지 않으므로 지우고 찾는다.
  if (ext === ".py") {
    const code = text.replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, "").replace(/#[^\n]*/g, "");
    for (const m of code.matchAll(/^[ \t]*(?:from[ \t]+(\.*[\w.]*)[ \t]+import|import[ \t]+([\w.]+))/gm)) {
      const mod = m[1] ?? m[2];
      const dots = /^\.*/.exec(mod)[0].length;
      const parts = mod.slice(dots).split(".").filter(Boolean);
      let base = dir;
      for (let d = 1; d < dots; d++) base = dirname(base);
      if (!parts.length) continue;
      found.push([join(base, ...parts) + ".py", join(base, ...parts, "__init__.py")]);
    }
  } else if (JS_EXT.test(ext)) {
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    for (const m of code.matchAll(/(?:require|import)\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)|from\s+["'](\.{1,2}\/[^"']+)["']|import\s+["'](\.{1,2}\/[^"']+)["']/g)) {
      const spec = m[1] ?? m[2] ?? m[3];
      found.push(JS_RESOLVE.map((suffix) => resolve(dir, spec + suffix)));
    }
  }
  // 모듈 하나에 후보 경로가 여럿이므로, 모듈마다 처음 찾은 파일 하나만 쓴다.
  const out = [];
  for (const candidates of found.slice(0, 10)) {
    if (out.length >= 3) break;
    for (const candidate of candidates) {
      const checked = checkFile(ctx, candidate);
      if (!checked) continue;
      if (checked.inside && !out.includes(candidate)) out.push(candidate);
      break;
    }
  }
  return out;
}
