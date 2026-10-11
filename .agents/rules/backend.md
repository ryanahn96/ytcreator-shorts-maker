---
trigger: model_decision
description: src/ 아래 파이썬 백엔드 코드를 고치거나 새로 쓰기 전에 읽는다. 들여쓰기, import, 모듈 경계, ffmpeg 호출, 서버 재시작처럼 이 저장소에서만 통하는 규칙과 함정.
---

# 백엔드 규칙

- 들여쓰기는 2칸, 문자열은 작은따옴표, 한 줄은 80자다. 80자는 한글도 한 글자로 센다. 고친 줄만 정리한다. `uvx pyink --pyink-indentation 2 --line-length 80 --pyink-use-majority-quotes --line-ranges=<시작>-<끝> <파일>`. 파일 전체에 돌리면 상관없는 줄이 10-20개씩 바뀐다.
- import는 Google 방식대로 모듈 경로 순으로 정렬한다. `from collections.abc import X`가 `import json`보다 앞에 온다. `uvx ruff check src`가 내는 I001과 ISC004는 원래 있던 경고라서 `--fix`로 고치지 않는다.
- 이름이 흔한 모듈은 지역 변수와 겹치지 않게 별칭으로 들여온다. `from src.gemini import client as gemini_client`, `from src.youtube import common as youtube_common`, `from src.prompts import analysis as analysis_prompt`, `from src.prompts import edit_agent as edit_agent_prompt`.
- `src/core/models.py`는 `src/core/config.py`를 import하지 않는다. config가 models를 import한다.
- `src/main.py`의 SPA catch-all 라우트는 모든 `include_router` 뒤에 둔다.
- 로그인 확인은 핸들러 안에서 `deps.require_session(request)`를 직접 부른다. FastAPI `Depends`로 옮기면 본문 검증보다 먼저 돌아서 잘못된 본문에 422 대신 401을 준다.
- 패키지 `__init__.py`에는 한 줄 docstring만 둔다.
- `subprocess.run`에는 `stdin=subprocess.DEVNULL`을 넘기고 ffmpeg에는 `-nostdin`을 붙인다. 빠뜨리면 ffmpeg가 터미널을 읽다가 SIGTTIN을 받고 멈춘다.
- Gemini 프롬프트는 `src/prompts/`의 문자열 상수다. 응답 스키마 예시에는 구체적인 숫자를 넣지 않는다. Gemini가 그 숫자를 그대로 베낀다.
- 백엔드는 자동 재시작이 없다. 고친 코드를 브라우저에서 보려면 `fuser -k 3000/tcp 5000/tcp` 뒤 `npm --prefix frontend run dev`를 다시 띄운다. Vite는 5000번이 비어 있으면 백엔드를 같이 띄운다.
- 일회용 파이썬 스크립트는 저장소 루트에서 `PYTHONPATH=. .venv/bin/python <파일>`로 돌린다.
