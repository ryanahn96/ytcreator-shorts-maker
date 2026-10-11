# ytcreator 에이전트 안내

Agentic Shorts 생성 스튜디오. 크리에이터가 올린 롱폼 영상을 Gemini가 분석해 점프컷 Shorts를 여러 개 제안하고, 크리에이터는 그것을 편집해 MP4로 받거나 자기 YouTube 채널에 올린다. 백엔드는 `src/`의 FastAPI(Python 3.14, uv), 프런트엔드는 `frontend/`의 React 19, Vite, Tailwind 4, 배포는 Cloud Run과 `terraform/`이다.

## 먼저 읽을 문서

- [CONTEXT.md](../CONTEXT.md)는 용어집이다. 식별자, API 필드, UI 문구, 문서에 이름을 붙이기 전에 읽는다. 개념은 굵은 글씨의 정식 이름으로, 화면 글자는 `_화면 표기_`대로 쓴다. 새 개념이 생기면 같은 변경에서 항목을 더한다.
- [DESIGN.md](../DESIGN.md)는 스튜디오 작업 화면의 디자인 시스템이다. Shorts 결과물 캔버스는 CONTEXT.md의 Short Template과 Look이 정한다. 그래서 작업 화면 카드는 둥글고 Shorts 영상 박스는 늘 각지다.
- `src/` 파이썬을 고치기 전에는 [rules/backend.md](rules/backend.md)를, `frontend/` 화면이나 스타일을 고치기 전에는 [rules/frontend.md](rules/frontend.md)를 읽는다.
- [README.md](../README.md)의 "개발자 안내"에 실행법, 환경 변수, 코드 구조, API 목록이 있다.
- [docs/adr/](../docs/adr/)는 설계 결정 기록이다. 이미 정한 문제를 다시 정하기 전에 관련 ADR을 읽는다.

## 작업 원칙

- 요청을 끝내는 가장 작은 변경을 고른다. 표준 라이브러리와 이미 있는 코드를 먼저 쓴다. 기준은 ponytail 스킬이다.
- 구간 고르기, 분류, 말투 같은 의미 판단은 Gemini structured output이 한다. 클립의 시작과 끝도 Gemini가 정한다. 정규식, 키워드 사전, 파이썬 쪽 구간 자르기로 대신하지 않는다. 이유는 ADR 0001과 0002에 있다.
- 분석 결과는 언제나 실제 Gemini 응답에서 나온다. 호출이 실패하면 화면에 오류를 보여 준다. 가짜 결과나 고정 프리셋으로 메우지 않는다.
- Gemini와 Speech-to-Text 호출은 돈이 든다. 영상이나 음성을 보내는 호출은 먼저 사용자에게 묻는다. 시험 영상은 10-20분 길이를 쓴다.
- 서버로 시험 업로드를 하면 `STUDIO_RETENTION_HOURS`(기본 24시간)보다 오래된 로컬 소스와 렌더가 지워진다. 올리기 전에 사용자에게 알린다.
- 저장소에는 테스트가 없고, 테스트 코드는 느려서 돌리지 않는다. 확인은 아래 검사와 대화 scratch 폴더의 일회용 스크립트로 한다.

## 함께 고칠 문서

- UI 문구를 바꾸면 README 사용자 안내에서 따옴표로 인용한 라벨과 CONTEXT.md의 화면 표기를 같이 고친다.
- API 경로나 환경 변수가 바뀌면 README "개발자 안내"의 표를 고친다.
- `src/core/models.py`의 pydantic 모델을 바꾸면 `frontend/src/types.ts`도 맞춘다. JSON 필드 이름은 camelCase다.
- `frontend/src/index.css`의 토큰이나 `ui.tsx` 공통 컴포넌트의 모양을 바꾸면 DESIGN.md도 맞춘다.
- 되돌리기 어려운 결정은 `docs/adr/`에 다음 번호로 ADR을 남긴다. 제목은 결정을 한 문장으로 쓴 한국어이고, 본문 뒤에 `## Considered Options`를 둔다.

## 검사

`python3 .agents/scripts/check.py`는 HEAD와 달라진 파일을, `--all`을 붙이면 저장소 전체를 검사한다.

- 파이썬: ruff F, E9 규칙과 바뀐 줄의 80자 제한. 한글도 한 글자로 센다.
- TypeScript: `npm --prefix frontend run lint`(tsc).
- README: 링크, 앵커, 환경 변수 표, API 표, 프런트엔드에서 사라진 인용 라벨.

턴을 끝낼 때 Stop 훅이 이번 턴에 고친 파일로 같은 검사를 돌리고, 실패하면 이어서 고치라고 돌려보낸다. 이번 작업과 무관한 실패면 사용자에게 알리고 끝낸다.

## git

- 여러 Jetski 세션이 이 작업 트리를 함께 쓴다. 시작할 때 `git status`로 남이 고친 파일을 확인하고, 그 변경은 건드리지 않는다.
- 커밋할 때는 자기가 고친 경로만 `git add <경로>`로 올린다. push는 사용자가 시킬 때만 한다.
- push, stash, reset --hard, checkout, switch, restore, clean, branch -D는 PreToolUse 훅이 매번 사용자에게 확인을 받는다.
