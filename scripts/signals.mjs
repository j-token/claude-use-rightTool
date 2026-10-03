// 루프·대기·감시의 단서가 되는 패턴.
// 사전 필터(선택 사항)와, 잘린 긴 코드에서 루프 관련 줄을 뽑을 때 함께 쓴다.

const SIGNALS = [
  /\bwhile\b/i,
  /\buntil\b/i,
  /\bdo\s*\{/i,
  /\bloop\b/i,
  /\bfor\s*\(\s*;\s*;/,
  /\bsleep\b/i,
  /Start-Sleep/i,
  /\bwaitfor\b/i,
  /\bchoice\b[^\n|;&]*\/t\b/i,
  /\btimeout(\.exe)?\s+\/t\b/i,
  /\bWait-(Process|Job|Event)\b/i,
  /\bwait\s+(%|\$|\d)/,
  /\bwatch\b/i,
  /--watch\b/i,
  /--follow\b/i,
  /\btail\b[^\n|;&]*\s-[a-zA-Z]*[fF]/,
  /Get-Content\b[^\n|;]*-Wait\b/i,
  /\b(journalctl|docker|kubectl|podman)\b[^\n|;&]*\s-[a-zA-Z]*[fw]\b/,
  /\bping\b[^\n|;&]*\s[-/][tn]\b/i,
  /\binotifywait\b[^\n|;&]*\s-m\b/,
  /\bRegister-ObjectEvent\b|FileSystemWatcher/i,
  /setInterval\s*\(/,
  /setTimeout\s*\(/,
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|watch)\b/,
  /\bhttp\.server\b/,
];

// 일부 패턴은 긴 줄에서 시간이 제곱으로 늘 수 있으므로, 긴 줄은 겹치는 조각으로 나눠 검사한다.
// 전체에서 검사하는 글자 수에 상한을 둔다(이를 넘는 입력은 앞부분 MAX_SCAN 자만 본다).
const CHUNK = 2000;
const OVERLAP = 200;
const MAX_SCAN = 4_000_000;

// 줄마다 한 번에 검사하도록 하나로 합친다(대소문자 구분 없이 조금 넓게 잡아도 단서로는 충분하다).
const ANY_SIGNAL = new RegExp(SIGNALS.map((re) => `(?:${re.source})`).join("|"), "i");

function firstMatch(line, limit) {
  const end = Math.min(line.length, limit);
  for (let start = 0; ; start += CHUNK - OVERLAP) {
    const m = ANY_SIGNAL.exec(line.slice(start, Math.min(start + CHUNK, end)));
    if (m) return start + m.index;
    if (start + CHUNK >= end) return -1;
  }
}

// 단서가 있는 줄을 [줄 번호, 줄, 위치] 로 차례로 내놓는다.
function* matches(text) {
  let budget = MAX_SCAN;
  let pos = 0;
  for (let n = 1; pos <= text.length && budget > 0; n++) {
    const nl = text.indexOf("\n", pos);
    const line = text.slice(pos, nl < 0 ? text.length : nl);
    const idx = firstMatch(line, budget);
    if (idx >= 0) yield [n, line, idx];
    budget -= line.length + 1;
    if (nl < 0) return;
    pos = nl + 1;
  }
}

export function looksLoopish(text) {
  return !matches(text).next().done;
}

// 단서가 있는 줄을 "L<번호>: <내용>" 형태로 최대 `limit`개 돌려준다.
export function loopRelatedLines(text, limit = 30) {
  const out = [];
  for (const [n, line, idx] of matches(text)) {
    const snippet = line.length > 240 ? line.slice(Math.max(0, idx - 80), idx + 160) : line;
    out.push(`L${n}: ${snippet.trim()}`);
    if (out.length >= limit) break;
  }
  return out;
}
