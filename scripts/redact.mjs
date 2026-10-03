// 외부 API로 보내거나 로그에 남기기 전에 흔한 형태의 비밀값을 가린다.
// 완벽한 탐지가 아니라 실수로 새는 것을 줄이는 안전망이다.

const KEY_NAME = String.raw`(?:api[_-]?key|secret|token|passw(?:or)?d|pwd|credential|private[_-]?key|access[_-]?key|client[_-]?secret|auth)[\w-]{0,40}`;
const ASSIGN = String.raw`(${KEY_NAME}["']?[ \t]{0,5}[:=][ \t]{0,5})`;

// 넓은 할당 패턴이 값의 일부만 가리지 않도록 구체적인 형태를 먼저 처리한다.
const PATTERNS = [
  // Authorization 헤더
  [/(Authorization:\s*(?:Bearer|Basic|token)\s+)[^\s"']+/gi, "$1<redacted>"],
  // URL 안의 사용자:비밀번호
  [/(:\/\/[^\s:/@]+:)[^\s@/]+@/g, "$1<redacted>@"],
  // KEY="value with spaces", KEY='a#b' 처럼 따옴표로 감싼 값
  [new RegExp(`${ASSIGN}"[^"\\n]{1,2048}"`, "gi"), '$1"<redacted>"'],
  [new RegExp(`${ASSIGN}'[^'\\n]{1,2048}'`, "gi"), "$1'<redacted>'"],
  // KEY=value, token: value 같은 따옴표 없는 할당. 값은 토큰처럼 생긴 문자만 허용하고 바로 뒤가 구분자여야 한다.
  // 그래서 `tokenizer = while(true){...}`, `token=$(sleep 60)` 같은 코드는 건드리지 않는다.
  // (?=(...))\2 는 되돌아가지 않는 매치를 흉내 내서, 긴 값에서도 한 번만 훑는다. 긴 값은 통째로 가린다.
  [new RegExp(`${ASSIGN}(?=([A-Za-z0-9_\\-./+:@~%]+=*))\\2(?=[\\s"',;)\\]}]|$)`, "gi"), "$1<redacted>"],
  // 접두사로 알아볼 수 있는 토큰
  [/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,})\b/g, "<redacted>"],
  // JWT
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "<redacted>"],
];

// PEM 개인 키 블록. BEGIN 마다 끝까지 다시 훑지 않도록 위치를 앞으로만 옮기며 찾는다.
// 끝 표시가 없으면 첫 BEGIN 부터 끝까지 가린다.
function redactPrivateKeys(text) {
  const BEGIN = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/g;
  const END = /-----END [A-Z ]{0,40}PRIVATE KEY-----/g;
  let out = "";
  let pos = 0;
  for (let m = BEGIN.exec(text); m; m = BEGIN.exec(text)) {
    END.lastIndex = m.index + m[0].length;
    const close = END.exec(text);
    out += text.slice(pos, m.index) + "<redacted private key>";
    if (!close) return out;
    pos = close.index + close[0].length;
    BEGIN.lastIndex = pos;
  }
  return out + text.slice(pos);
}

export function redact(text) {
  let out = redactPrivateKeys(text);
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}
