# 에이전틱 숏폼 점프컷 스튜디오 (Agentic Shortform Jumpcut Studio)

정보성 롱폼 영상(강의, 인터뷰, 토크)을 9:16 세로 숏폼 여러 개로 만드는 스튜디오입니다.
원본 음성만 쓰고(TTS 없음), 자막, 원본 오디오, 영상 3개 트랙으로 편집합니다.

- 영상 이해: Gemini `MediaProcessing.AGENTIC`이 YouTube URL을 직접 보고, 인덱스가
  붙은 Transcript Word 목록과 Editorial Prompt를 받아 Scenario와 Clip 경계를 정합니다.
- 편집: Clip 범위 드래그, 미세 조정, 단어 클릭으로 시작/끝 지정, 추가/삭제/분할/순서
  변경, 자막 단어 수정, 헤드라인과 영상 박스 영역(확대, 위치) 수정. 결과는 브라우저에서
  바로 다시 계산됩니다.
- 화면: 모든 숏폼이 하나의 템플릿을 씁니다. 검은 배경 가운데 둥근 영상 박스, 그 위에
  Gemini가 제안한 두 줄 헤드라인(초록/흰색), 박스 안 아래쪽에 노란 자막 한 줄.
- 렌더: 사용자가 올린 MP4를 원본으로 ffmpeg가 9:16 MP4를 만듭니다(YouTube 다운로드는
  쓰지 않음). 헤드라인, 자막, 둥근 모서리는 ASS 파일 하나로 입힙니다.
- Gemini 호출이 실패하면 가짜 결과를 만들지 않고 UI에 오류를 보여줍니다.

용어는 [CONTEXT.md](CONTEXT.md), 설계 결정은 [docs/adr](docs/adr)에 있습니다.

## 구조

### 백엔드 (`yt/`)

| 경로 | 역할 |
| --- | --- |
| `yt/server.py` | FastAPI 라우팅만 담당 |
| `yt/studio/config.py` | 환경 변수, 편집 기본값, 렌더 프로필, 기본 Look Style |
| `yt/studio/fonts.py` | 저장소 글꼴 목록, 글꼴 파일에서 읽는 줄 높이 비율 |
| `yt/studio/models.py` | 요청/응답 pydantic 모델 (camelCase 직렬화) |
| `yt/studio/ingestion.py` | yt-dlp 메타데이터, YouTube 자막을 Transcript Word로 변환, ffprobe/silencedetect |
| `yt/studio/prompts.py` | 기본 Editorial Prompt, Gemini 응답 스키마 |
| `yt/studio/director.py` | Gemini AGENTIC 호출, 모델 폴백, 재시도, 응답 검증 |
| `yt/studio/composer.py` | 클라이언트가 보낸 Subcut을 프레임 단위로 맞춘 타임라인, J/L컷, ffmpeg 필터 그래프, ASS/SRT 생성 |
| `yt/studio/storage.py` | 업로드 원본과 렌더 결과 보관, 오래된 파일 정리 |

### API

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/api/health` | 상태, API 키 유무 |
| GET | `/api/shortform/config` | 기본 Editorial Prompt, 편집 기본값, 숏폼 템플릿, 기본 Look Style, 글꼴 목록, 모델 체인, 글꼴 경고 |
| GET | `/api/shortform/fonts/{font_id}` | 미리보기가 쓰는 글꼴 파일 |
| POST | `/api/shortform/analyze` | 분석. NDJSON 스트림(진행 상황, 하트비트, 결과 또는 오류) |
| POST | `/api/shortform/upload-source` | 원본 MP4 업로드, 길이와 무음 구간 측정 |
| POST | `/api/shortform/render` | 미리보기(540x960) 또는 최종(1080x1920) 렌더 |
| GET | `/api/shortform/renders/{render_id}` | 렌더된 MP4 |
| POST | `/api/shortform/export` | ffmpeg 명령, ASS, 단어 단위 SRT |

### 프론트엔드 (`frontend/src/`)

| 경로 | 역할 |
| --- | --- |
| `components/` | 화면 구성 요소 (프롬프트, 시나리오 탭, Clip 편집기, 자막 패널, 내보내기 등) |
| `components/preview/` | 9:16 미리보기 (업로드 전 YouTube, 업로드 후 canvas) |
| `hooks/` | 분석 스트림, 업로드, 점프컷 재생 |
| `lib/` | API 클라이언트, 타임라인 계산, 프레이밍, 편집 리듀서 |
| `types.ts` | 백엔드 모델과 맞춘 타입 |

## 실행

필요한 것: Python 3.14 + uv, Node 22, ffmpeg/ffprobe, Gemini 호출 수단(아래 둘 중 하나).

```bash
cp .env.example .env   # Gemini 연결 방식 설정
uv sync
npm --prefix frontend install
npm --prefix frontend run dev
```

`npm run dev`가 Vite(:3000)와 백엔드(:5000)를 함께 띄웁니다. 백엔드는 자동 재시작이
없으므로 Python 코드나 `.env`를 고치면 dev 서버를 다시 시작하세요.

백엔드만 띄우려면 `uv run python -m yt.server`를 쓰면 됩니다. `frontend/dist`가 있으면
빌드된 UI도 같이 서빙합니다.

### Gemini 연결

`.env`에서 둘 중 하나를 고릅니다. 화면 오른쪽 위 배지에 지금 쓰는 방식과 모델이
표시되고, 설정이 빠졌으면 무엇을 넣어야 하는지 알려줍니다.

| 방식 | 설정 | 인증 |
| --- | --- | --- |
| Gemini API | `GEMINI_API_KEY` | AI Studio API 키 |
| Vertex AI | `GOOGLE_GENAI_USE_VERTEXAI=true`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`(기본 `global`) | ADC. 로컬은 `gcloud auth application-default login`, Cloud Run은 서비스 계정 |

`GOOGLE_GENAI_USE_VERTEXAI=true`이면 `GEMINI_API_KEY`가 있어도 Vertex AI를 씁니다.
Vertex AI 프로젝트에서 Vertex AI API가 켜져 있어야 하고, 호출 계정에
`roles/aiplatform.user` 권한이 필요합니다.

Vertex AI를 쓰면 페이지를 열 때 ADC로 토큰 발급을 한 번 시도합니다. 다시 로그인해야
하면 배지가 `Vertex AI 설정 필요`로 바뀌고 분석 버튼이 잠깁니다.
`gcloud auth application-default login`을 실행한 뒤 페이지를 새로고침하면 되고, 서버는
다시 시작하지 않아도 됩니다.

## Cloud Run 배포

`deploy.sh`가 API 활성화, 서비스 계정, Cloud Build 빌드, Cloud Run 배포까지
한 번에 처리합니다. 기본값은 프로젝트 `sample-505914`, 리전 `asia-northeast3`, 서비스
`ytcreator`이고, 스크립트 맨 위의 변수를 환경 변수로 넘겨 바꿀 수 있습니다.

```bash
./deploy.sh
```

- Gemini: Vertex AI + ADC입니다. Cloud Run에서 ADC는 서비스에 붙은 서비스 계정
  `ytcreator-run@<프로젝트>.iam.gserviceaccount.com`(`roles/aiplatform.user`)이므로 API
  키를 배포하지 않습니다. `.env`는 업로드되지 않고, 환경 변수는 배포할 때마다 스크립트가
  통째로 다시 씁니다.
- 접근: IAP 없이 URL로 바로 접근할 수 있습니다(`--allow-unauthenticated`).
- 업로드: Cloud Run은 HTTP/1 요청 본문을 32 MiB로 제한합니다. 그래서 컨테이너는 uvicorn
  대신 h2c를 받는 Hypercorn으로 뜨고, 서비스는 HTTP/2 end-to-end(`--use-http2`)로 둡니다.
- 저장: 업로드와 렌더 파일은 인스턴스 메모리(`/tmp`)에 있어 인스턴스는 최대 1개이고,
  메모리(기본 8Gi)가 원본 크기의 상한입니다. 요청이 없어 인스턴스가 내려가면 파일이
  사라지므로 다시 업로드하세요. `MIN_INSTANCES=1`이면 유휴 비용을 내고 인스턴스를 유지합니다.
- 의존성: `uv.lock`에는 사내 PyPI 미러(Airlock) 주소가 들어 있어 Cloud Build에서 받을 수
  없습니다. 이미지는 lock과 같은 버전을 PyPI에서 설치합니다.

## 참고

- 글꼴: Headline·자막 글꼴은 저장소의 무료 한글 글꼴 10종(`yt/studio/fonts`, OFL)
  중에서 고릅니다. 렌더와 미리보기가 같은 파일을 쓰므로 시스템 글꼴을 설치할 필요가
  없습니다. 파일이 빠지면 `/config`의 `fontWarning`이 UI에 표시됩니다.
- YouTube 자막을 가져오지 못하면(예: HTTP 429) Gemini가 직접 받아쓰고, 분석 결과에
  경고로 표시합니다.
- 업로드 전 미리보기는 YouTube 플레이어로 재생하므로 키프레임 단위로 이동하고 무음 구간은
  단어 간격으로 추정합니다. 정확한 결과는 MP4 업로드 후 미리보기 렌더로 확인하세요.
- 자동화 테스트는 두지 않습니다.
