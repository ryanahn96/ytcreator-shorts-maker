# Agentic Shorts 생성 스튜디오

유튜브 크리에이터가 Google / YouTube 계정으로 로그인해 강의, 인터뷰, 토크 같은 정보성 롱폼
영상 파일을 올리면 Gemini가 영상을 보고 9:16 Shorts 여러 개를 제안합니다. 내 채널에 이미
올라간 영상과 연결하면 YouTube Analytics 시청자 유지율(Audience Retention) 피크 구간과
공식 자막을 함께 반영하고, 브라우저에서 다듬은 뒤 1080×1920 MP4로 내려받거나 내 YouTube
채널에 바로 업로드합니다. 원본 음성만 쓰고 TTS는 없습니다.

- 로그인 (Google / YouTube OAuth 2.0): Cloud Run IAP 대신 앱 자체 OAuth 2.0 로그인을
  씁니다. 어떤 Google / YouTube 계정이든 본인 채널 권한으로 로그인할 수 있고, 헤더에
  채널 프로필이 표시됩니다.
- 내 채널 영상 연결 (선택): 시작 화면에서 내 채널의 업로드 영상을 고르거나 영상 URL/ID를
  넣으면 YouTube Analytics API v2로 시청자 유지율 곡선(`audienceWatchRatio`,
  `relativeRetentionPerformance`)과 피크 구간을 뽑고, YouTube Data API v3로 공식 자막을
  가져옵니다. Gemini가 시청자가 집중·반복 재생한 구간을 우선 선별합니다.
- 분석: 올린 영상을 360p 분석용 사본으로 줄여 Gemini `MediaProcessing.AGENTIC`에
  보냅니다. 첫 분석에서 공식 자막이 없으면 Gemini가 영상 전체를 받아쓰고(서버가 보관),
  Shorts 생성 프롬프트에 맞춰 Shorts와 클립 경계, 헤드라인, 화면 구성을 정합니다. 사본은 Gemini
  Context Cache에 1시간 올려 둡니다.
- 다시 분석: 기본은 보관한 전체 자막과 시청 유지율 피크만으로 구간을 다시 고르는
  "빠른 재분석 (자막)"으로 몇 초면 끝납니다. 슬라이드·판서처럼 화면을 봐야 하면
  "화면 재탐색 (비디오 캐시)"이 영상을 다시 보고, 캐시가 살아 있으면 그것을 재사용합니다.
- 편집: 클립 구간 드래그(시청 유지율 곡선 오버레이 포함)와 미세 조정, 단어 클릭 편집(시작점,
  끝점, 나누기, 단어 삭제, 자막 수정), 클립 추가·나누기·순서·삭제, 클립별 스타일, 줄 수
  제한 없는 헤드라인, 글자·이미지 드래그, 글꼴 10종, 배경음악. 미리보기에서
  헤드라인·자막·이미지를 누르면 오른쪽 패널이 그 항목으로 바로 옮겨 갑니다.
- 말로 편집: 편집 화면 오른쪽 아래에 떠 있는 창에 "헤드라인을 노란색으로 크게", "2번 클립을
  3초 줄여 줘"처럼 입력하거나 마이크로 말하면, Gemini(생각 수준 LOW)가 보고 있는 Shorts의 편집
  동작으로 바꾸고 브라우저가 한 번에 적용합니다(영상은 다시 보내지 않음). 답과 참고 사항은 줄임
  없이 글로 다 보이고, "되돌리기"로 바로 취소할 수 있습니다. 창은 작은 버튼으로 접어 둘 수
  있습니다. 마이크는 브라우저의 Web Speech API(ko-KR)를 쓰며, 지원하지 않는 브라우저에서는
  보이지 않습니다. 헤더의 실행 취소·다시 실행(Ctrl/⌘+Z, Ctrl/⌘+Shift+Z)은 손 편집과 말로 편집을
  함께 100단계까지 기억합니다.
- 렌더 및 YouTube 업로드: 올린 원본으로 ffmpeg가 1080×1920 MP4를 만듭니다. 내보내기
  창에서 MP4 파일을 내려받거나 제목·설명·공개 상태(비공개/일부 공개/공개)를 정해 내
  YouTube 채널에 Shorts로 바로 올릴 수 있습니다.
- 비용: 분석 한 번에 쓴 토큰을 공개 정가로 계산해 편집 화면 위에
  "약 $0.21 · 3분 12초"처럼 보여 줍니다.
- Gemini 호출이 실패하면 가짜 결과를 만들지 않고 오류를 보여 줍니다.

용어는 [CONTEXT.md](CONTEXT.md), 설계 결정은 [docs/adr](docs/adr)에 있습니다.

## 화면

| 화면 | 내용 |
| --- | --- |
| 로그인 | Google / YouTube 계정 OAuth 2.0 로그인 |
| 시작 | 영상 파일을 끌어다 놓거나 선택합니다. 내 채널 영상을 연결해 시청자 유지율 피크와 공식 자막을 미리 볼 수 있습니다. 올리기가 끝나면 "Shorts 만들기" |
| 분석 중 | 진행 상태 한 줄, 경과 시간, Gemini 생각 요약 한 줄, 중단 |
| 편집 | 헤더에 Shorts 탭, 비용과 시간, 실행 취소·다시 실행, 다시 분석, 새 영상, 채널 프로필·로그아웃, 내보내기(MP4 다운로드 + YouTube Shorts 업로드). 왼쪽 클립(시청 유지율 배지·곡선), 가운데 고정 미리보기, 오른쪽 자막·스타일·소리 탭, 오른쪽 아래에 떠 있는 말로 편집 창 |

테마는 처음에 기기 설정을 따릅니다. 헤더 메뉴에서 시스템, 라이트, 다크를 고르면 브라우저에
저장됩니다.

## 구조

### 백엔드 (`yt/`)

| 경로 | 역할 |
| --- | --- |
| `yt/server.py` | FastAPI 라우팅과 OAuth 세션 쿠키 확인 |
| `yt/studio/config.py` | 환경 변수, 편집 기본값, 렌더 프로필(1080×1920), 기본 Look Style |
| `yt/studio/fonts.py` | 저장소 글꼴 목록, 글꼴 파일에서 읽는 줄 높이 비율 |
| `yt/studio/models.py` | 요청/응답 pydantic 모델 (camelCase 직렬화) |
| `yt/studio/youtube.py` | Google OAuth 2.0, YouTube Data API v3(채널·영상 목록·자막·Shorts 업로드), YouTube Analytics API v2(시청자 유지율 곡선·피크 추출) |
| `yt/studio/ingestion.py` | ffprobe, silencedetect, 분석용 사본, Gemini 받아쓰기를 Transcript Word로 변환 |
| `yt/studio/prompts.py` | 기본 Shorts 생성 프롬프트, 첫 분석·빠른 재분석·화면 재탐색 요청문(시청자 유지율 피크 포함), Gemini 응답 스키마 |
| `yt/studio/gemini.py` | API 키 또는 Vertex AI 클라이언트, ADC 토큰 확인 |
| `yt/studio/director.py` | Gemini AGENTIC 호출, Context Cache 생성·재사용, 전체 자막 및 YouTube 컨텍스트 보관, 모델 대체 순서, 재시도, 응답 검증, 토큰 집계 |
| `yt/studio/edit_agent.py` | 말로 편집: 편집 요청과 보고 있는 Shorts, 보관한 전체 자막·시청 유지율로 Gemini(텍스트만, 생각 수준 LOW)에 편집 동작을 묻고, 동작을 검사해 범위 밖 값은 맞추거나 건너뛴 뒤 답 한 줄과 함께 돌려줌 |
| `yt/studio/pricing.py` | 모델별 정가표(확인 날짜와 출처 포함), 호출 비용과 캐시 쓰기 비용 계산 |
| `yt/studio/layout.py` | 템플릿 기하(영상 박스, 크롭, 글자 기본 위치: 헤드라인은 박스 위, 자막은 박스 아래) |
| `yt/studio/composer.py` | 클라이언트가 보낸 Subcut을 프레임 단위로 맞춘 타임라인(하드 컷), ffmpeg 필터 그래프, ASS 생성 |
| `yt/studio/storage.py` | 업로드 원본, 분석용 사본, 전체 자막, YouTube 컨텍스트, 캐시 정보, OAuth 세션, 이미지와 음악, 렌더 결과 보관. `STUDIO_GCS_BUCKET`이 있으면 GCS에 두고 로컬 디스크는 캐시로 씀 |

### API

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/api/health` | 상태, Gemini·OAuth 설정 여부, 저장 위치(로컬 또는 버킷) |
| GET | `/api/shortform/config` | 기본 Shorts 생성 프롬프트, 편집 기본값, 템플릿, 기본 Look Style, 글꼴 목록, 글꼴 경고, Gemini 설정 오류, OAuth 로그인 상태(`auth`) |
| GET | `/api/shortform/auth/login` | Google / YouTube OAuth 2.0 동의 화면으로 리다이렉트 |
| GET | `/api/shortform/auth/callback` | OAuth 코드 교환, 세션 저장 후 `/`로 리다이렉트 |
| POST | `/api/shortform/auth/logout` | 세션 삭제 및 로그아웃 |
| GET | `/api/shortform/youtube/videos` | 로그인한 크리에이터 채널의 최근 업로드 영상 목록 |
| GET | `/api/shortform/youtube/videos/{video_id}/context` | 선택한 채널 영상의 시청자 유지율 곡선·피크 구간 및 공식 자막 조회 |
| POST | `/api/shortform/youtube/upload` | 렌더된 1080×1920 MP4를 크리에이터 YouTube 채널에 Shorts로 업로드 |
| GET | `/api/shortform/fonts/{font_id}` | 미리보기가 쓰는 글꼴 파일 |
| POST | `/api/shortform/upload-source` | 원본 영상 업로드, 길이와 무음 구간 측정 |
| POST | `/api/shortform/upload-asset` | 이미지나 배경음악 업로드 |
| POST | `/api/shortform/analyze` | 분석. `mode`는 `fast`(보관한 자막만) 또는 `deep`(영상 다시 보기); 첫 분석은 항상 영상을 봅니다. NDJSON 스트림(진행 상황, 하트비트, 결과 또는 오류) |
| POST | `/api/shortform/edit` | 말로 편집. 편집 요청 하나와 보고 있는 Shorts 상태를 받아 검사한 편집 동작, 답 한 줄, 참고 사항을 돌려줌. 브라우저가 연결을 끊으면(중단) Gemini 호출도 취소 |
| POST | `/api/shortform/render` | 1080×1920 MP4 렌더 |
| GET | `/api/shortform/renders/{render_id}` | 렌더된 MP4 |

### 프런트엔드 (`frontend/src/`)

| 경로 | 역할 |
| --- | --- |
| `App.tsx`, `components/Studio.tsx` | 서버 설정 불러오기, OAuth 로그인 화면 → 시작 → 분석 중 → 편집 화면 전환 |
| `components/StartScreen.tsx`, `AnalyzingScreen.tsx`, `EditorScreen.tsx` | 화면 셋 (시작 화면의 내 채널 영상 연결 및 시청 유지율 미리보기 포함) |
| `components/ReanalyzeDialog.tsx`, `ExportDialog.tsx` | 다시 분석, 내보내기(MP4 다운로드 + YouTube Shorts 직접 업로드) 대화상자 |
| `components/` 나머지 | 클립 편집기(시청 유지율 피크 배지·곡선), 자막 패널, 스타일과 소리 설정, 크리에이터 배지, 테마 메뉴, 공통 UI(`ui.tsx`, `Icon.tsx`) |
| `components/preview/` | canvas 9:16 미리보기, 글자와 이미지 드래그 |
| `components/EditAgentBar.tsx`, `hooks/useSpeechInput.ts`, `lib/editAgent.ts` | 말로 편집: 오른쪽 아래에 떠 있는 창(접기·펼치기), 마이크(Web Speech, ko-KR), 답과 참고 사항 전체와 지난 대화, 편집 요청 만들기, 답의 편집 동작을 그 순간의 편집 상태에 적용 |
| `lib/history.ts` | 실행 취소·다시 실행 (손 편집과 말로 편집 공통, 100단계) |
| `hooks/` | 분석 스트림, 업로드, 점프컷 재생, 배경음악 동기화, 테마 |
| `lib/` | API 클라이언트, 타임라인 계산, 프레이밍, 편집 리듀서, 표시 형식 |
| `index.css` | Material 3 색 역할(라이트·다크), 편집 화면 배치 |
| `types.ts` | 백엔드 모델과 맞춘 타입 |

## 실행

필요한 것: Python 3.14 + uv, Node 22, ffmpeg/ffprobe, Google OAuth 2.0 클라이언트 ID/Secret, Gemini 호출 수단(아래 둘 중 하나).

```bash
cp .env.example .env   # Google OAuth 클라이언트 및 Gemini 연결 방식 설정
uv sync
npm --prefix frontend install
npm --prefix frontend run dev
```

`npm run dev`가 Vite(:3000)와 백엔드(:5000)를 함께 띄웁니다. 백엔드는 자동 재시작이
없으므로 Python 코드나 `.env`를 고치면 dev 서버를 다시 시작하세요.

### Google / YouTube OAuth 설정

Google Cloud Console → **APIs & Services → Credentials**에서 **OAuth 2.0 Client ID (Web application)**를 만들고 **승인된 리디렉션 URI (Authorized redirect URIs)**에 다음 주소를 등록합니다:

- 로컬 개발: `http://localhost:3000/api/shortform/auth/callback`
- Cloud Run 배포: `https://<서비스-URL>/api/shortform/auth/callback`

발급받은 값을 `.env` 또는 배포 환경 변수에 넣습니다:

```bash
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
```

요청하는 OAuth 범위(Scope):
- `openid`, `email`, `profile`
- `https://www.googleapis.com/auth/youtube.readonly` (채널 정보·업로드 영상 목록)
- `https://www.googleapis.com/auth/youtube.force-ssl` (공식 자막 트랙 조회·다운로드)
- `https://www.googleapis.com/auth/yt-analytics.readonly` (시청자 유지율 곡선 조회)
- `https://www.googleapis.com/auth/youtube.upload` (렌더된 Shorts MP4 업로드)

### Gemini 연결

`.env`에서 둘 중 하나를 고릅니다. 설정이 빠졌으면 시작 화면에 무엇을 넣어야 하는지
오류로 보여 주고 "Shorts 만들기" 버튼을 잠급니다.

| 방식 | 설정 | 인증 |
| --- | --- | --- |
| Gemini API | `GEMINI_API_KEY` | AI Studio API 키 |
| Vertex AI | `GOOGLE_GENAI_USE_VERTEXAI=true`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`(기본 `global`) | ADC. 로컬은 `gcloud auth application-default login`, Cloud Run은 서비스 계정 |

## Cloud Run 배포

인프라는 `terraform/`에 있고 `deploy.sh`가 Cloud Build 빌드와 `terraform apply`를
순서대로 실행합니다. 기본값은 `.env`의 `GOOGLE_CLOUD_PROJECT`(없으면 `ytcreator-508301`), 리전 `asia-northeast3`, 서비스
`ytcreator`이고, 스크립트 맨 위의 변수(`PROJECT_ID`, `REGION`, `SERVICE`, …)와
`TF_VAR_*` 환경 변수, `terraform/terraform.tfvars`로 바꿀 수 있습니다. 필요한 것:
`gcloud`(로그인 상태), `terraform` 1.5 이상.

```bash
GOOGLE_OAUTH_CLIENT_ID="your-client-id.apps.googleusercontent.com" \
GOOGLE_OAUTH_CLIENT_SECRET="your-client-secret" \
./deploy.sh
```

| 파일 | 만드는 것 |
| --- | --- |
| `terraform/apis.tf` | run, cloudbuild, artifactregistry, compute, aiplatform, storage, youtube, youtubereporting, youtubeanalytics API |
| `terraform/storage.tf` | Artifact Registry 저장소, 미디어 버킷 `<프로젝트>-ytcreator-media`(공개 차단, `retention_days` 뒤 자동 삭제) |
| `terraform/iam.tf` | 런타임 서비스 계정 `ytcreator-run@`(`roles/aiplatform.user`, 버킷 `objectAdmin`) |
| `terraform/service.tf` | Cloud Run v2 서비스(`invoker_iam_disabled = true`, h2c 8080, 4 CPU / 8Gi, 0~5 인스턴스, 3600초 타임아웃) |
| `terraform/outputs.tf` | `service_url`, `media_bucket`, `runtime_service_account`, `image_repository` |

- 접근: Cloud Run IAP는 쓰지 않고 `invoker_iam_disabled = true`로
  외부 유튜브 크리에이터가 진입 화면에 접속해 앱의 Google / YouTube OAuth 2.0으로
  로그인할 수 있게 합니다(`constraints/iam.allowedPolicyMemberDomains` 조직 정책이
  `allUsers` IAM 바인딩을 막는 프로젝트에서도 동작).
- Gemini: Vertex AI + ADC입니다. Cloud Run에서 ADC는 런타임 서비스 계정이므로 API 키를
  배포하지 않습니다.
- 업로드: Cloud Run은 HTTP/1 요청 본문을 32 MiB로 제한합니다. 그래서 컨테이너는 uvicorn
  대신 h2c를 받는 Hypercorn으로 뜨고, 서비스 포트 이름은 `h2c`입니다.
- 저장: `STUDIO_GCS_BUCKET`이 미디어 버킷을 가리켜 업로드 원본, 분석용 사본, 전체 자막,
  YouTube 컨텍스트, 캐시 정보, OAuth 세션, 렌더 결과가 GCS에 남습니다.
- 정리: `terraform -chdir=terraform destroy -var image_uri=unused`.
