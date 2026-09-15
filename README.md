# YTCreator

YouTube 비디오 분석 및 콘텐츠 생성을 위한 프로젝트입니다.

## 개발 환경 설정 (`uv`)

### 1. 가상환경 및 의존성 동기화
```bash
uv sync
```

### 2. 환경변수 설정
`.env.example` 파일을 복사하여 `.env` 파일을 생성하고, `GEMINI_API_KEY`를 설정합니다.
```bash
cp .env.example .env
```

### 3. 실행
```bash
# sample.py 실행
uv run python sample.py

# main.py 실행
uv run python main.py
```

## YouTube API 샘플 (`yt/`)

| 모듈 | API | 용도 |
| --- | --- | --- |
| `yt/data_api.py` | Data API v3 | 채널·영상 메타데이터, 통계, 검색 (실시간 조회) |
| `yt/analytics_api.py` | Analytics API v2 | 기간/차원별 지표 쿼리 (조회수, 시청시간, 트래픽 소스) |
| `yt/reporting_api.py` | Reporting API v1 | 매일 자동 생성되는 벌크 CSV 리포트 |
| `yt/auth.py` | 공통 | OAuth 2.0 인증 및 `token.json` 캐시 |

### 1. GCP 설정 (프로젝트: `card-379407`)

```bash
gcloud services enable \
  youtube.googleapis.com \
  youtubeanalytics.googleapis.com \
  youtubereporting.googleapis.com \
  --project=card-379407
```

OAuth 동의 화면에서 아래 스코프를 추가하고, 앱이 "테스트" 상태라면 본인
계정을 테스트 사용자로 등록해야 합니다.

- `.../auth/youtube.readonly`
- `.../auth/yt-analytics.readonly`
- `.../auth/yt-analytics-monetary.readonly`

`client_secret.json`은 **데스크톱 앱(installed)** 유형 OAuth 클라이언트여야
합니다. 경로를 바꾸려면 `YT_CLIENT_SECRETS` 환경변수를 사용하세요.

### 2. 최초 인증

첫 실행 시 콘솔에 URL이 출력됩니다. 로컬 브라우저에서 열어 동의한 뒤
리디렉션된 `http://localhost:<PORT>/?code=...` 주소를 그대로 사용하면
`token.json`이 생성되고 이후에는 재인증이 필요 없습니다.

> Cloudtop처럼 브라우저가 없는 환경에서는 `open_browser=False`가 기본이라
> 콘솔 URL을 수동으로 복사해야 합니다. 리디렉션이 로컬 머신으로 가야 하므로
> 해당 포트를 SSH 포트포워딩하거나, 로컬에서 실행하는 편이 간단합니다.

### 3. 실행

```bash
# Data API: 내 채널 요약 + 최근 영상 10개 통계
uv run python -m yt.data_api

# Analytics API: 최근 28일 일자별/영상별/트래픽 소스별 리포트
uv run python -m yt.analytics_api

# Reporting API: 벌크 리포트 작업 관리
uv run python -m yt.reporting_api list-types
uv run python -m yt.reporting_api create-job channel_basic_a2
uv run python -m yt.reporting_api list-jobs
uv run python -m yt.reporting_api download <JOB_ID> -o report.csv
```

### 알아둘 점

- Analytics 데이터는 2~3일 지연되므로 샘플은 종료일을 3일 전으로 잡습니다.
- Reporting API는 작업 등록 후 첫 CSV까지 최대 48시간이 걸리고, 과거 30일치가
  소급 생성됩니다. 리포트는 60일간 보관됩니다.
- Data API 기본 할당량은 하루 10,000 units이며 `search.list`는 1회에 100 units를
  소모합니다.
