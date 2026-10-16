# use-right-tool

[English](README.md) | **한국어**

Claude가 Bash/PowerShell 로 `while true; sleep`, `tail -f`, `sleep 60 && cat log` 같은 루프·폴링·모니터링을 직접 돌리려 하면
PreToolUse 훅에서 막고, Claude Code 전용 기능을 쓰라고 안내하는 플러그인입니다. 판별은 TypeSafe **Jev** 로 합니다.
파일 쓰기·수정·검색을 셸로 하는 명령(`cat > x.py <<EOF`, `sed -i`, `python - <<EOF` 로 파일 고치기, `grep -rn`)도
Jev 호출 없이 막고 `Write` / `Edit` / `Grep` / `Glob` 도구를 쓰라고 안내합니다. 파일 보기(`cat`, `head`, `sed -n`)는 허용합니다.

| 도구 규칙 (Jev 호출 없음) | 예 | 안내하는 도구 |
| --- | --- | --- |
| `write` | `cat > f <<EOF`, `echo ... > f`, `printf > f`, `tee f <<EOF`, `Set-Content`, `"text" > f`, `[IO.File]::WriteAllText` | `Write`, `Edit` |
| `edit` | `sed -i`, `perl -pi`, 파일에 쓰는 인라인 스크립트(`python - <<EOF ... open(p,'w')`, `node -e "fs.writeFileSync(...)"`) | `Edit`, `Write` |
| `search` | 명령 전체가 검색뿐일 때: `grep -rn x src`, `rg x`, `find . -name`, `Select-String`, `ls -R`, `Get-ChildItem -Recurse` | `Grep`, `Glob` |

다른 명령의 출력을 거르거나 저장하는 것(`git log \| head`, `npm test > out.log`, `git commit -m "$(cat <<'EOF' ...)"`)은 막지 않습니다.

| Jev 판별 | 포그라운드 | `run_in_background: true` | 안내하는 도구 |
| --- | --- | --- | --- |
| `poll_until_condition` (외부 상태를 기다렸다가 끝나는 폴링) | 차단 | 허용 (공식 권장 패턴) | `run_in_background` + `until`, `Monitor` |
| `wait_for_completion` (sleep 후 결과 확인) | 차단 | 허용 | `run_in_background` 알림 |
| `stream_follow` (tail -f, Get-Content -Wait, watch) | 차단 | 차단 | `Monitor` |
| `repeat_forever` (오래 도는 주기 루프, 횟수 제한 여부와 무관) | 차단 | 차단 | `Monitor`, `/loop`, `CronCreate` |
| `watch_mode_process` (터미널에 붙어 도는 dev 서버, --watch) | 차단 | 허용 | `run_in_background` + `Monitor` |
| `finite_iteration`, `single_action` | 허용 | 허용 | - |

## 동작 방식

0. 먼저 명령의 모양만 보고 정합니다(Jev 호출 없음, API 키 없이도 동작).
   - 위 도구 규칙에 걸리면 바로 막습니다.
   - 루프나 대기를 만들 수 없는 명령만으로 이루어졌으면(입력을 기다리거나 다른 명령을 실행하지 않는 `git` 하위 명령, `ls`, `mkdir`, `cp`, `rm`, `wc`, `Get-ChildItem` 등. `tail -f`·`find -exec`·`timeout`·`nohup`·PowerShell 루프 같은 예외 제외) Jev 에 묻지 않고 통과시킵니다. 스크립트를 실행하는 명령은 언제나 Jev 로 갑니다.
1. 나머지 Bash/PowerShell 명령은 **모두** Jev 로 검사합니다. 키워드 필터로는 `node -e "setTimeout(...)"`, `ping -n 61 127.0.0.1`(Windows sleep 꼼수), 스크립트 파일 안에 숨은 `sleep` 같은 우회를 놓치기 때문입니다.
2. 명령이 **실제로 실행할** 코드를 모아서 Jev 가 이름이 아니라 코드를 보고 판단하게 합니다.
   - 인터프리터에 넘긴 스크립트(`python`, `node`, `tsx`, `deno`, `bun`, `bash`, `pwsh -File`, `php`, `ruby`, `perl`, `lua`, `go run`, `cmd /c` 등), 직접 실행(`./runner`, `.\build.ps1`), `source` / `.`
   - `package.json` 의 `npm` / `pnpm` / `yarn` / `bun` 스크립트, `make` / `just` 레시피(선행 타깃 한 단계 포함)
   - 그 스크립트가 불러오는 로컬 모듈 한 단계(`from lib.helpers import ...`, `require("./util")`)

   작은 셸 토크나이저가 따옴표(bash `$'...'` 포함), 공백 있는 경로, 리다이렉트, heredoc, 명령 치환(`$(...)`, 백틱), `cd dir &&`(서브셸·백그라운드 안의 `cd` 나 없는 디렉터리로의 `cd` 는 반영하지 않음), `~`, `$PWD`, Git Bash 드라이브 경로(`/c/...`)를 처리합니다. 파일을 보기·쓰기·포맷·린트·복사·커밋만 하는 명령(`cat x.py`, `code x.py`, `black x.py`, `cat > x.sh <<EOF`, `git commit -m "x.py"`)의 파일은 **읽지 않고**, 실행하지 않는 옵션(`python -c`, `node --check`, `php -l`, `--help`, `make -n`) 뒤의 파일도 읽지 않습니다.
3. 짧은 코드는 통째로 보냅니다. 긴 코드와 아주 긴 명령은 앞부분, 뒷부분, 루프로 보이는 줄을 따로 뽑아 보내므로 파일 중간의 루프도 보입니다.
4. Choice 질문 하나로 의도를 판별합니다. 차단 대상 범주의 확률 합이 임계값(기본 0.6) 이상이면 `permissionDecision: "deny"` 와 대신 쓸 기능을 알려 주는 영어 안내 문구를 돌려줍니다. 같은 입력도 확률이 ±0.05~0.1 흔들리므로, 임계값 ±0.15 안이면 한 번 더 물어 평균을 냅니다.
5. API 키가 없거나 Jev 호출이 실패하거나 훅이 12초 마감을 넘기면 작업을 막지 않고 통과시킵니다(fail-open).

비용: Jev 로 가는 일반 명령은 입력 약 1,150 토큰, 긴 소스가 붙으면 최대 약 2,700 토큰이라 Jev 1.14 가격($0.042/백만 토큰) 기준 $0.00005~0.00011 입니다. 판별 기준 문구를 줄여 0.2.0 대비 명령당 약 35% 줄였고(테스트 케이스 평균 1,877 → 1,222 토큰), 실제 Claude Code 기록의 명령 약 8,000개로 재 보니 약 40% 는 0단계에서 끝나 Jev 를 부르지 않았습니다. 둘을 합치면 Jev 토큰은 이전의 약 39% 입니다. 훅 전체 지연은 Jev 를 부를 때 약 400~500ms 이고, 드문 경계 구간에서는 Jev 시간이 두 배가 됩니다.

## TypeSafe 로 보내는 것

- 명령, Claude 가 적은 `description`, 그 명령이 실행하는 코드(위 설명).
- 세션 작업 폴더나 `CLAUDE_PROJECT_DIR` 안의 파일만 읽습니다. 프로젝트 밖 파일, 네트워크 경로(`\\server\share`), 바이너리는 이름과 "읽지 않음" 표시만 보냅니다.
- 읽는 양에 상한이 있습니다: 소스 최대 5개, 큰 파일은 앞뒤 64KB, 명령당 파일 확인 최대 40회.
- 보내거나 로그에 남기는 모든 내용(소스 경로, 우회 이유, API 오류 메시지 포함)에서 흔한 비밀값 형태를 `<redacted>` 로 가립니다. 대상은 키·토큰·비밀번호의 `KEY=value` 식 할당(따옴표 유무 무관), `Authorization` 헤더, URL 안의 계정 정보, 개인 키 블록, 잘 알려진 접두사의 토큰(`sk-`, `ghp_`, `AKIA`, `xox*-`, JWT)입니다. 코드처럼 생긴 값(`token = getToken()`)은 루프가 가려지지 않도록 그대로 둡니다. 완벽한 보장이 아니라 안전망입니다.
- API 응답이 이상하면(모르는 범주, 0~1 밖의 확률, 합이 1과 크게 다름) 오류로 보고 명령을 통과시킵니다.

## 설치

```
/plugin marketplace add j-token/claude-use-rightTool
/plugin install use-right-tool@use-right-tool
```

Node.js 18 이상과 환경 변수 `TYPESAFE_API_KEY` 가 필요합니다.

## 설정 (환경 변수)

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | (필수) | TypeSafe API 키 |
| `USE_RIGHT_TOOL_THRESHOLD` | `0.6` | 차단 확률 임계값 (0, 1]. 잘못된 값이면 경고 후 0.6 사용 |
| `USE_RIGHT_TOOL_MODEL` | `jev-1.14.0` | 임계값과 판별 기준을 이 버전에 맞췄습니다. 같은 케이스에서 1.14 는 1.13 보다 경계 마진이 넓었고(최소 0.25 대 0.13), 줄인 판별 기준에서 1.13 은 `nohup ... &` 를 오판했습니다. 바꾸기 전에 `node test/cases.mjs` 를 다시 돌리세요 |
| `USE_RIGHT_TOOL_LOG` | (없음) | 지정하면 판별 결과, 사용한 입력 토큰(`inputTokens`), 도구 규칙(`rule`), Jev 생략(`skipped`), 우회 기록을 JSONL 로 남김(비밀값은 가림) |
| `USE_RIGHT_TOOL_PREFILTER` | (없음) | `1` 이면 명령이나 실행 코드에 `while`, `sleep`, `setTimeout`, `tail -f`, `-Wait`, `--watch` 같은 단서가 있을 때만 Jev 를 호출. 더 싸고 빠르지만 변형된 우회는 놓칠 수 있음 |
| `USE_RIGHT_TOOL_ENDPOINT` | TypeSafe API | API 주소 변경(오프라인 테스트용) |

## 우회

오판으로 막히면, 이유를 적은 끝 주석을 붙여 다시 실행합니다.

```
for i in 1 2 3; do curl -sf https://example.com && break; sleep 5; done # use-right-tool:allow: 정해진 3번 재시도
```

따옴표·인자·URL 안이 아닌 진짜 셸 주석이고, 콜론 뒤에 이유가 있을 때만 인정합니다. 도구 규칙에도 똑같이 쓸 수 있습니다(예: 바이너리 파일을 고쳐야 할 때). `USE_RIGHT_TOOL_LOG` 를 켜면 모든 우회가 기록됩니다. Jev 차단 메시지는 판별이 불확실할 때(p < 0.9)만 우회 방법을 알려 주고, 도구 규칙 차단 메시지는 늘 알려 줍니다.

## 테스트

```
node --test test/unit.test.mjs   # 오프라인 87개: 토크나이저, 실행 코드 수집, 도구 규칙, Jev 생략, 비밀값 가리기, 정책, 훅 입출력 (스텁 서버, API 키 불필요)
node test/cases.mjs              # 실제 Jev: 명령 73개(Jev 차단 38, 도구 규칙 차단 6, 허용 29)와 사용한 토큰
```

실제 Jev 테스트에는 레드팀 지적 사항이 들어 있습니다: 중립적인 이름의 스크립트에 숨은 루프, npm 스크립트, make 타깃, import, 긴 파일, 스케줄러처럼 도는 횟수 제한 루프, 짧은 재시도 루프, 붙어서 도는 서비스, 루프 코드를 다듬거나 쓰기만 하는 명령. 예제 파일은 `test/fixtures/` 에 있습니다.

## 한계

- import 는 한 단계까지만 따라가고, 실행 중에 불러오는 코드(`exec(open(...).read())`, `curl ... | sh`)나 npm/pnpm/yarn/bun/make/just 외의 태스크 러너는 보지 않습니다.
- 토크나이저는 근사치이지 완전한 셸 파서가 아닙니다. 함수 정의 안(`f() { python x.py; }`), 변수에 담기만 한 스크립트 블록(`$s = { python x.py }`), 실행될 수 없는 분기(`false && python x.py`)의 스크립트도 실행되는 것으로 보고 읽어서 보냅니다.
- 12초 마감은 동기 파일 읽기를 중간에 끊지 못합니다. 네트워크 경로는 건너뛰고 읽는 양도 제한하므로, 로컬 디스크가 아주 느릴 때만 문제가 됩니다.
- 판단이 갈리는 대기 일부는 포그라운드에서 막힙니다. 예: `kubectl wait`, `kubectl rollout status`, `sleep 2 && curl ...`. `run_in_background: true` 나 우회 주석을 쓰세요.
- 도구 규칙도 근사치입니다. 명령 하나에 쓰기가 섞여 있으면 체인 전체가 막히고, 변수로 만든 경로나 `eval` 로 감싼 쓰기는 놓칩니다. 검색 규칙은 명령 전체가 파일 보기·검색(과 `cd`, `ls`, `echo` 같은 중립 명령)일 때만 걸리고, `npm test && grep -rn x src` 처럼 다른 작업과 섞이면 통과합니다.
- 이 플러그인은 Claude 의 작업 방식을 안내하는 도구이지 보안 경계가 아닙니다. 실패 시 통과시키고, 우회도 Claude 가 쓸 수 있습니다.
