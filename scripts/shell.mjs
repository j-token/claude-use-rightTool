// 셸 명령을 세그먼트(단순 명령)와 단어로 나눈다.
// 실행 위치를 찾기 위한 근사 파서이며 완전한 bash/PowerShell 파서가 아니다.
// 입력을 한 번만 훑으므로 길이에 비례한 시간에 끝난다.

const SEPARATORS = new Set([";", "(", ")", "{", "}"]);

// `open` 위치의 괄호와 짝이 맞는 닫는 괄호 위치를 찾는다. 따옴표 안의 괄호는 무시한다.
function matchBalanced(text, open, ps) {
  const openCh = text[open];
  const closeCh = openCh === "(" ? ")" : "}";
  const escape = ps ? "`" : "\\";
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === escape && quote !== "'") {
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === openCh) depth++;
    else if (c === closeCh && --depth === 0) return i;
  }
  return text.length - 1;
}

/**
 * @param {string} command
 * @param {"bash" | "powershell"} shell
 * 각 세그먼트에는 첫 단어가 따옴표로 시작했는지(`firstQuoted`), 괄호 깊이(`depth`),
 * 백그라운드로 실행되는지(`background`)를 붙인다.
 * PowerShell 에서 따옴표로 시작한 첫 단어는 실행이 아니라 문자열 값이고,
 * bash 의 ( ... ) 서브셸 안에서 cd 해도 바깥 디렉터리는 바뀌지 않기 때문이다.
 * `substitutions` 는 $(...) 와 bash `...` 안의 명령이다. 그 안에서도 코드가 실행된다.
 * @returns {{ segments: string[][], comments: string[], substitutions: string[] }}
 */
export function tokenize(command, shell) {
  const ps = shell === "powershell";
  const n = command.length;
  const segments = [];
  const comments = [];
  const substitutions = [];
  const pendingHeredocs = [];
  let seg = [];
  let word = null;
  let wordQuoted = false;
  let dropNextWord = false;
  let parenDepth = 0;
  let i = 0;

  const endWord = () => {
    if (word === null) return;
    if (dropNextWord) dropNextWord = false;
    else {
      if (!seg.length) {
        seg.firstQuoted = wordQuoted;
        seg.depth = parenDepth;
      }
      seg.push(word);
    }
    word = null;
    wordQuoted = false;
  };
  const endSeg = () => {
    endWord();
    if (seg.length) segments.push(seg);
    seg = [];
  };
  const append = (text, quoted = false) => {
    if (word === null) wordQuoted = quoted;
    word = (word ?? "") + text;
  };
  // `open` 위치의 ( 부터 짝이 맞는 ) 까지를 명령 치환으로 기록하고 끝 위치를 돌려준다.
  const substitution = (open) => {
    const end = matchBalanced(command, open, ps);
    substitutions.push(command.slice(open + 1, end));
    return end;
  };

  // heredoc 본문은 데이터이므로 단어로 나누지 않고 건너뛴다.
  const skipHeredocs = (start) => {
    let pos = start;
    for (const { delim, strip } of pendingHeredocs) {
      while (pos < n) {
        const nl = command.indexOf("\n", pos);
        const end = nl < 0 ? n : nl;
        let line = command.slice(pos, end).replace(/\r$/, "");
        if (strip) line = line.replace(/^\t+/, "");
        pos = end + 1;
        if (line === delim) break;
      }
    }
    pendingHeredocs.length = 0;
    return Math.min(pos, n);
  };

  while (i < n) {
    const c = command[i];
    const next = command[i + 1];

    if (c === "\n") {
      endSeg();
      i++;
      if (pendingHeredocs.length) i = skipHeredocs(i);
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      endWord();
      i++;
      continue;
    }
    if (ps && c === "<" && next === "#") {
      const end = command.indexOf("#>", i + 2);
      comments.push(command.slice(i, end < 0 ? n : end + 2));
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === "#" && word === null) {
      const nl = command.indexOf("\n", i);
      const end = nl < 0 ? n : nl;
      comments.push(command.slice(i, end).replace(/\r$/, ""));
      i = end;
      continue;
    }
    if (ps && c === "@" && word === null && (next === "'" || next === '"')) {
      const close = command.indexOf(`\n${next}@`, i + 2);
      const end = close < 0 ? n : close;
      append(command.slice(i + 2, end), true);
      i = close < 0 ? n : close + 3;
      continue;
    }
    if (!ps && c === "$" && next === "'") {
      // ANSI-C 문자열 $'...': 백슬래시가 작은따옴표도 이스케이프한다.
      let j = i + 2;
      let buf = "";
      while (j < n && command[j] !== "'") {
        if (command[j] === "\\" && j + 1 < n) {
          buf += command[j + 1];
          j += 2;
        } else buf += command[j++];
      }
      append(buf, true);
      i = j + 1;
      continue;
    }
    if (c === "'") {
      const close = command.indexOf("'", i + 1);
      const end = close < 0 ? n : close;
      append(command.slice(i + 1, end), true);
      i = end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let buf = "";
      while (j < n && command[j] !== '"') {
        const d = command[j];
        if (d === "$" && command[j + 1] === "(") {
          // 큰따옴표 안의 $(...) 도 명령 치환이다.
          const end = substitution(j + 1);
          buf += command.slice(j, end + 1);
          j = end + 1;
        } else if (!ps && d === "`") {
          const close = command.indexOf("`", j + 1);
          const end = close < 0 ? n : close;
          substitutions.push(command.slice(j + 1, end));
          buf += command.slice(j, end + 1);
          j = end + 1;
        } else if (!ps && d === "\\" && j + 1 < n && '$`"\\\n'.includes(command[j + 1])) {
          buf += command[j + 1];
          j += 2;
        } else if (ps && d === "`" && j + 1 < n) {
          buf += command[j + 1];
          j += 2;
        } else {
          buf += d;
          j++;
        }
      }
      append(buf, true);
      i = j + 1;
      continue;
    }
    if (c === "$" && (next === "(" || next === "{")) {
      const end = next === "(" ? substitution(i + 1) : matchBalanced(command, i + 1, ps);
      append(command.slice(i, end + 1));
      i = end + 1;
      continue;
    }
    if (c === "`") {
      if (ps) {
        if (i + 1 < n) append(command[i + 1]);
        i += 2;
      } else {
        const close = command.indexOf("`", i + 1);
        const end = close < 0 ? n : close;
        substitutions.push(command.slice(i + 1, end));
        append(command.slice(i, end + 1));
        i = end + 1;
      }
      continue;
    }
    if (!ps && c === "\\") {
      if (i + 1 < n && command[i + 1] !== "\n") append(command[i + 1]);
      i += 2;
      continue;
    }
    if (c === "|") {
      endSeg();
      i += next === "|" ? 2 : 1;
      continue;
    }
    if (c === "&") {
      if (next === "&") {
        endSeg();
        i += 2;
      } else if (!ps && next === ">") {
        endWord();
        i += command[i + 2] === ">" ? 3 : 2;
        dropNextWord = true;
      } else if (ps && word === null && !seg.length) {
        // PowerShell 호출 연산자 & 는 세그먼트 맨 앞에만 온다.
        seg.push("&");
        seg.firstQuoted = false;
        seg.depth = parenDepth;
        i++;
      } else {
        // 명령 뒤의 & 는 백그라운드 실행이다. 그 안의 cd 는 현재 셸에 영향을 주지 않는다.
        seg.background = true;
        endSeg();
        i++;
      }
      continue;
    }
    if (SEPARATORS.has(c)) {
      endSeg();
      if (c === "(") parenDepth++;
      else if (c === ")") parenDepth = Math.max(0, parenDepth - 1);
      i++;
      continue;
    }
    if (c === "<" && next === "<" && !ps) {
      endWord();
      if (command[i + 2] === "<") {
        i += 3;
        dropNextWord = true;
        continue;
      }
      let j = i + 2;
      const strip = command[j] === "-";
      if (strip) j++;
      while (command[j] === " " || command[j] === "\t") j++;
      let delim = "";
      while (j < n && !/[\s;|&<>()]/.test(command[j])) {
        if (!`'"\\`.includes(command[j])) delim += command[j];
        j++;
      }
      pendingHeredocs.push({ delim, strip });
      i = j;
      continue;
    }
    if (c === ">" || (c === "<" && !ps)) {
      if (word !== null && /^\d+$|^\*$/.test(word)) word = null;
      else endWord();
      i++;
      if (command[i] === ">" || command[i] === "|") i++;
      if (command[i] === "&") {
        i++;
        while (i < n && /[\d-]/.test(command[i])) i++;
        continue;
      }
      dropNextWord = true;
      continue;
    }
    append(c);
    i++;
  }
  endSeg();
  return { segments, comments, substitutions };
}
