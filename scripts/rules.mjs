// Jev 없이 명령의 모양만 보고 정하는 규칙.
// 1) 파일 쓰기·수정·검색을 쉘로 하면 막고 Write/Edit/Grep/Glob 도구를 안내한다(파일 보기는 허용).
// 2) 루프나 대기를 만들 수 없는 단순 명령은 Jev 에 묻지 않고 통과시킨다(토큰 절약).
// 둘 다 근사 판단이다. 잘못 막히면 우회 주석으로 다시 실행할 수 있다.

import { tokenize } from "./shell.mjs";
import { commandName, stripPrefix } from "./sources.mjs";

const NULL_TARGET = /^(\/dev\/(null|stdout|stderr|tty)|\$null|nul|con)$/i;
const realOutputs = (seg) => (seg.outputs ?? []).filter((t) => !NULL_TARGET.test(t));
const operands = (args) => args.filter((a) => !a.startsWith("-"));
const hasFlag = (args, re) => args.some((a) => re.test(a));

const PYTHON = /^(python[\d.]*|py|pythonw|pypy[\d.]*)$/;
const INLINE_FLAGS = {
  python: ["-c"],
  node: ["-e", "--eval", "-p", "--print"],
  bun: ["-e", "--eval", "-p", "--print"],
  deno: ["eval"],
  ruby: ["-e"],
  perl: ["-e", "-E"],
  php: ["-r"],
};
// 파일에 쓰는 API. 인라인 스크립트가 이를 쓰면 Edit/Write 도구로 할 일을 하는 것으로 본다.
const WRITE_API =
  /\bopen\s*\([^)]*?,\s*(?:mode\s*=\s*)?["'][rbt]*[wax+]|\.write_(?:text|bytes)\s*\(|\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|writeTextFile|writeTextFileSync)\s*\(|\bBun\.write\s*\(|\bFile\.(?:write|open\s*\([^)]*["'][wa])|\bfile_put_contents\s*\(|\b(?:Set|Add)-Content\b|\bOut-File\b|::(?:Write|Append)All(?:Text|Lines|Bytes)\b/i;
const PS_FILE_API = /^\[(?:System\.)?IO\.File\]::(?:Write|Append)All/i;

function interpreterKind(name) {
  if (PYTHON.test(name)) return "python";
  if (name === "nodejs") return "node";
  return name in INLINE_FLAGS ? name : null;
}

// 세그먼트가 문자열 그대로를 내보내는지(echo "..", cat <<EOF, PowerShell 문자열 값).
function literalText(seg, shell) {
  const words = stripPrefix(seg, shell);
  const name = commandName(words[0] ?? "");
  if (shell === "powershell" && seg.firstQuoted) return seg.join(" ");
  if (name === "echo" || name === "printf" || name === "write-output") return words.slice(1).join(" ");
  if (name === "cat" && (seg.heredocs || seg.herestring !== undefined)) return [...(seg.heredocs ?? []), seg.herestring ?? ""].join("\n");
  return null;
}

// 인터프리터가 명령 안에서 바로 받는 코드(-c, heredoc, 파이프로 받은 문자열).
function inlineCode(seg, words, kind, prev, shell) {
  const args = words.slice(1);
  const flags = INLINE_FLAGS[kind];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (flags.includes(a)) return args[i + 1] ?? "";
    if (a === "-") break;
    if (!a.startsWith("-")) return null; // 스크립트 파일을 실행한다(sources 가 맡는다)
  }
  const stdin = [...(seg.heredocs ?? []), seg.herestring ?? ""];
  if (seg.piped && prev) stdin.push(literalText(prev, shell) ?? "");
  return stdin.join("\n");
}

// "write"(새 내용 쓰기), "edit"(제자리 수정), 또는 null.
function writeKind(seg, prev, shell) {
  const words = stripPrefix(seg, shell);
  if (!words.length) return null;
  // sudo tee /etc/hosts 처럼 권한이 필요한 쓰기는 Write 도구로 할 수 없다.
  if (/^(sudo|doas)$/.test(commandName(seg[0]))) return null;
  const name = commandName(words[0]);
  const args = words.slice(1);
  const outputs = realOutputs(seg);

  if (shell === "powershell") {
    if (seg.firstQuoted && outputs.length) return "write";
    if (/^(set-content|sc|add-content|ac)$/.test(name)) return "write";
    if (name === "out-file" && seg.piped && prev && literalText(prev, shell) !== null) return "write";
    if ((name === "new-item" || name === "ni") && hasFlag(args, /^-value$/i)) return "write";
    if (PS_FILE_API.test(words[0])) return "write";
  }
  // `echo $! > pid` 처럼 변수 값만 저장하는 것은 파일 작성이 아니다.
  if ((name === "echo" || name === "printf" || name === "write-output") && outputs.length && !args.every((a) => a.startsWith("$"))) return "write";
  if (name === "cat" && outputs.length && (seg.heredocs || seg.herestring !== undefined)) return "write";
  if (name === "tee" && operands(args).some((a) => !NULL_TARGET.test(a))) {
    if (seg.heredocs || seg.herestring !== undefined || (seg.piped && prev && literalText(prev, shell) !== null)) return "write";
  }
  if (name === "sed" && hasFlag(args, /^(-[a-zA-Z]*i|--in-place)/)) return "edit";
  // -i 앞에 올 수 있는 스위치만 허용한다(-Mstrict, -Ilib 의 i 는 제자리 수정이 아니다).
  if (name === "perl" && hasFlag(args, /^-[lnpaesw0-9]*i/)) return "edit";
  const kind = interpreterKind(name);
  if (kind) {
    const code = inlineCode(seg, words, kind, prev, shell);
    if (code && WRITE_API.test(code)) return "edit";
  }
  if ((name === "pwsh" || name === "powershell") && WRITE_API.test(args.join(" "))) return "edit";
  if ((name === "bash" || name === "sh" || name === "zsh") && args[0] === "-c" && args[1]) {
    // 안쪽의 보기·검색은 바깥 명령의 다른 작업과 섞여 있을 수 있으므로 쓰기·수정만 본다.
    const inner = toolMisuse(args[1], "bash")?.kind;
    return inner === "write" || inner === "edit" ? inner : null;
  }
  return null;
}

const VIEW_FILTERS = new Set(["head", "tail", "grep", "egrep", "fgrep", "rg", "sort", "uniq", "cut", "wc", "findstr", "select-object", "select", "select-string", "sls", "measure-object", "measure"]);
const NEUTRAL = new Set(["cd", "pushd", "popd", "set-location", "sl", "ls", "dir", "pwd", "get-location", "echo", "printf", "write-output", "write-host"]);

// tail -f, -fn 50, -100f, -F, --follow=name / PowerShell -Wait, -Wai, -Wait:$true
const follows = (args) => hasFlag(args, /^(-[a-zA-Z0-9]*[fF][a-zA-Z0-9]*|--follow(=.*)?|-wa(i(t)?)?(:.*)?)$/i);

// 세그먼트가 파일을 보기만(view) 하는지, 검색(search)하는지, 앞 출력을 거르는지(filter).
function readKind(seg, shell) {
  const words = stripPrefix(seg, shell);
  if (!words.length) return "other";
  const name = commandName(words[0]);
  const args = words.slice(1);
  if (NEUTRAL.has(name) && !realOutputs(seg).length) {
    const recursive = shell === "powershell" ? /^-(recurse|r)$/i : /^-[a-zA-Z]*R[a-zA-Z]*$/;
    if ((name === "ls" || name === "dir") && hasFlag(args, recursive)) return "search";
    return "neutral";
  }
  if (realOutputs(seg).length || seg.heredocs || seg.herestring !== undefined) return "other";
  const files = operands(args);
  const ps = shell === "powershell";

  if (seg.piped) {
    if (!VIEW_FILTERS.has(name) || follows(args)) return "other";
    return /^(grep|egrep|fgrep|rg|findstr|select-string|sls)$/.test(name) ? "search" : "filter";
  }
  if ((name === "cat" || name === "nl" || name === "tac" || name === "bat" || name === "less" || name === "more") && files.length) return "view";
  if ((name === "head" || name === "tail") && files.length && !follows(args)) return "view";
  if (name === "sed" && hasFlag(args, /^-[a-zA-Z]*n/) && !hasFlag(args, /^(-[a-zA-Z]*i|--in-place)/) && files.length >= 2) return "view";
  if (ps && /^(get-content|gc|type)$/.test(name) && files.length && !follows(args)) return "view";
  if (/^(grep|egrep|fgrep|rg|ag|ack|findstr)$/.test(name) && files.length) return "search";
  if (name === "find" && !hasFlag(args, /^-(exec|execdir|ok|okdir|delete|fprint)/)) return "search";
  if ((name === "fd" || name === "fdfind") && !hasFlag(args, /^(-x|-X|--exec|--exec-batch)$/)) return "search";
  if (ps && /^(select-string|sls)$/.test(name) && files.length) return "search";
  if (ps && /^(get-childitem|gci)$/.test(name)) return hasFlag(args, /^-(recurse|r|filter|include)$/i) ? "search" : "neutral";
  return "other";
}

/**
 * 전용 도구로 해야 할 일을 쉘로 하는지 본다.
 * @returns {{ kind: "write" | "edit" | "search" } | null}
 */
export function toolMisuse(command, shell) {
  const { segments, substitutions } = tokenize(command, shell);
  let prev = null;
  for (const seg of segments) {
    const kind = writeKind(seg, prev, shell);
    if (kind) return { kind };
    prev = seg;
  }
  // 명령 전체가 파일 보기·검색뿐일 때만 막는다. 다른 명령의 출력을 거르는 건 그대로 둔다.
  if (substitutions.length || !segments.length) return null;
  const kinds = [];
  for (const seg of segments) {
    let kind = readKind(seg, shell);
    // `echo $PATH | grep node`, `cat a.py | grep def` 처럼 검색이 아닌 출력을 거르는 것은 막지 않는다.
    if (seg.piped && (kind === "search" || kind === "filter") && !["search", "filter"].includes(kinds.at(-1))) kind = "other";
    kinds.push(kind);
  }
  // 파일 보기(cat, head, sed -n ...)는 허용한다. 검색만 Grep/Glob 으로 안내한다.
  if (kinds.includes("other")) return null;
  if (kinds.includes("search")) return { kind: "search" };
  return null;
}

// 루프·대기·임의 코드 실행이 불가능한 프로그램만 둔다. sed(e 명령), awk(system, -f), jq(repeat),
// free -s 처럼 스스로 반복하거나 코드를 실행할 수 있는 것은 넣지 않는다.
const SAFE = new Set([
  // bash / 공통
  "git", "ls", "dir", "pwd", "cd", "pushd", "popd", "echo", "printf", "mkdir", "rm", "rmdir", "cp", "mv", "touch", "ln",
  "chmod", "chown", "wc", "diff", "cmp", "which", "where", "whereis", "file", "stat", "du", "df", "sort", "uniq", "cut",
  "tr", "basename", "dirname", "realpath", "readlink", "true", "false", "date", "whoami", "hostname", "uname",
  "test", "[", "cat", "head", "tail", "grep", "egrep", "fgrep", "rg", "find", "fd", "column", "nl", "tac", "tree",
  "export", "unset", "ps", "tasklist", "printenv", "id", "nproc",
  // PowerShell
  "get-process", "gps", "get-service", "get-ciminstance", "get-itemproperty", "get-psdrive", "get-alias",
  "get-childitem", "gci", "get-location", "test-path", "get-item", "gi", "remove-item", "ri", "del", "new-item", "ni",
  "md", "copy-item", "copy", "move-item", "move", "rename-item", "ren", "write-output", "write-host", "measure-object",
  "measure", "sort-object", "select-object", "select", "format-table", "ft", "format-list", "fl", "out-string",
  "get-command", "gcm", "resolve-path", "split-path", "join-path", "get-date", "convertfrom-json", "convertto-json",
  "get-filehash", "compare-object", "get-content", "gc", "type", "select-string", "sls",
]);

// 에디터·입력 대기, 서버, 임의 명령 실행(bisect run, rebase -x, submodule foreach, alias)이 없는 git 하위 명령.
const GIT_SAFE = new Set([
  "status", "log", "diff", "show", "add", "rm", "mv", "branch", "checkout", "switch", "restore", "fetch", "pull", "push",
  "commit", "tag", "stash", "remote", "ls-files", "ls-tree", "rev-parse", "rev-list", "describe", "blame", "shortlog",
  "merge-base", "check-ignore", "grep", "reset", "cherry-pick", "init", "clone", "config", "worktree", "reflog", "count-objects",
]);
// 이 하위 명령에서 -i/-p 는 입력을 기다리는 대화형 모드다(git log -p 와는 다르다).
const GIT_PROMPTS = new Set(["add", "checkout", "reset", "restore", "stash", "commit", "clean"]);
const GIT_INTERACTIVE = /^(-[a-zA-Z]*[ip]|--interactive|--patch|-e|--edit)$/;

function safeGit(args) {
  let i = 0;
  // 전역 옵션은 -C <dir>, --no-pager 만 허용한다(-c 로 alias, fsmonitor, pager 등을 바꿀 수 있다).
  while (i < args.length && args[i].startsWith("-")) {
    if (args[i] === "-C") i += 2;
    else if (args[i] === "--no-pager" || args[i] === "--no-optional-locks") i++;
    else return false;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (!GIT_SAFE.has(sub)) return false;
  if (GIT_PROMPTS.has(sub) && hasFlag(rest, GIT_INTERACTIVE)) return false;
  // 메시지 없이 commit 하거나 tag -a 하면 에디터를 연다.
  if (sub === "commit" && !hasFlag(rest, /^(-[a-zA-Z]*[mFC]|--message|--file|--no-edit|--reuse-message|--fixup)/)) return false;
  if (sub === "tag" && hasFlag(rest, /^-[a-zA-Z]*[as]$/) && !hasFlag(rest, /^(-[a-zA-Z]*m|-F|--message|--file)/)) return false;
  return true;
}

function safeSegment(seg, shell) {
  const words = stripPrefix(seg, shell);
  // while/until/do/& 만 남은 세그먼트(PowerShell 의 `while (...) { }` 등)는 루프나 스크립트 블록이다.
  if (!words.length) return false;
  // stripPrefix 가 걷어 낸 timeout/nohup 같은 래퍼는 대기와 관련될 수 있으므로 Jev 에 맡긴다.
  if (!seg.slice(0, seg.length - words.length).every((w) => /^[A-Za-z_]\w*=/.test(w))) return false;
  const name = commandName(words[0]);
  const args = words.slice(1);
  if (!SAFE.has(name)) return false;
  if (name === "git") return safeGit(args);
  if ((name === "tail" || name === "get-content" || name === "gc" || name === "type" || name === "cat") && follows(args)) return false;
  // 끝나지 않는 장치와 콘솔 입력
  if (args.some((a) => /^\/dev\/(u?random|zero|tty|stdin)$|^con:?$/i.test(a))) return false;
  if (name === "find" && hasFlag(args, /^-(exec|execdir|ok|okdir)/)) return false;
  if (name === "fd" && hasFlag(args, /^(-[a-zA-Z]*[xX]|--exec)/)) return false;
  if (name === "rg" && hasFlag(args, /^--pre/)) return false;
  if (name === "sort" && hasFlag(args, /^--compress-program/)) return false;
  return true;
}

/**
 * 루프·대기를 만들 수 없는 명령만으로 이루어졌는지 본다. 그렇다면 Jev 에 묻지 않는다.
 * 실행되는 스크립트가 있으면 언제나 false.
 */
export function obviouslyFinite(command, shell, sources = [], nesting = 0) {
  if (sources.length || nesting > 3) return false;
  // 프로세스 치환 <(...) >(...) 안의 명령은 토크나이저가 따로 모으지 않는다.
  if (shell === "bash" && /[<>]\(/.test(command)) return false;
  const { segments, substitutions } = tokenize(command, shell);
  if (!segments.length) return false;
  if (!segments.every((seg) => safeSegment(seg, shell))) return false;
  return substitutions.every((inner) => obviouslyFinite(inner, shell, [], nesting + 1));
}

const TOOL_GUIDANCE = {
  write: [
    "This command writes file contents from the shell (heredoc, echo/printf redirect, tee, Set-Content, ...).",
    "- Use the `Write` tool to create or overwrite a file, and the `Edit` tool to change an existing one.",
    "- For a throwaway script, `Write` it to a file (in the scratchpad if it is temporary), then run that file.",
  ],
  edit: [
    "This command edits files from the shell (sed -i, perl -i, or an inline script that writes files).",
    "- Use the `Edit` tool for each change (`replace_all` for repeated text), or `Write` to replace a whole file.",
    "- For a large mechanical change across many files, `Write` the script to a file first, then run it.",
  ],
  search: [
    "This command only searches files (grep, rg, find, Select-String, recursive listing, ...).",
    "- Use the `Grep` tool for content search (`output_mode`, `-n`, `-C`, `glob`, `head_limit`) and the `Glob` tool to find files by name.",
  ],
};

export function toolReason({ kind }) {
  return [
    `[use-right-tool] Blocked: this command was not run. (rule: shell ${kind})`,
    ...TOOL_GUIDANCE[kind],
    "Use Bash or PowerShell only for what these tools cannot do. If the shell really is required here, re-run it with a trailing comment: `# use-right-tool:allow: <reason>`.",
  ].join("\n");
}
