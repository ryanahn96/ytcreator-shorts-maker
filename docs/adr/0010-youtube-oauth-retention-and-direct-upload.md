# IAP를 제거하고 YouTube 크리에이터 OAuth 2.0·시청자 유지율·Shorts 직접 업로드를 도입한다

[ADR 0009](0009-cloud-run-iap-gcs-and-context-cache.md)에서는 Cloud Run 자체 IAP(`iap_enabled = true`)로 접근을 제어했다. 하지만 이 스튜디오의 대상 사용자는 조직 내부 직원이 아니라 외부 유튜브 크리에이터다. IAP는 조직 정책(`constraints/iam.allowedPolicyMemberDomains`) 때문에 외부 Google 계정을 가로막을 뿐 아니라, 설령 통과하더라도 IAP가 발급하는 ID 토큰으로는 크리에이터 본인 채널의 YouTube Data API v3나 YouTube Analytics API v2를 호출할 수 없다.

그래서 IAP를 완전히 걷어내고 앱 자체의 **Google / YouTube OAuth 2.0 Authorization Code 플로우**로 대체한다.

- **인프라 (`terraform/`, `deploy.sh`)**:
  - `iap.googleapis.com`, IAP 서비스 에이전트, `google_iap_web_cloud_run_service_iam_member`, `iap_access_members` 변수를 모두 제거하고 `youtube.googleapis.com`과 `youtubeanalytics.googleapis.com`을 켠다.
  - Cloud Run v2 서비스에서 `iap_enabled = false`, `invoker_iam_disabled = true`로 설정한다. `allUsers` IAM 바인딩을 만들지 않으면서 공개 HTTPS 진입을 허용하므로 `constraints/iam.allowedPolicyMemberDomains` 조직 정책을 위반하지 않는다.
  - OAuth 클라이언트 설정은 `GOOGLE_OAUTH_CLIENT_ID`와 `GOOGLE_OAUTH_CLIENT_SECRET`(`TF_VAR_oauth_client_id`, `TF_VAR_oauth_client_secret`)으로 주입한다.
- **인증 게이트와 세션 (`yt/studio/youtube.py`, `yt/studio/storage.py`, `yt/server.py`)**:
  - 앱 진입 시 로그인하지 않은 사용자는 OAuth 로그인 화면(`LoginScreen`)을 본다. 도메인·이메일 화이트리스트 없이 어떤 Google / YouTube 계정이든 로그인할 수 있다.
  - OAuth 범위는 `openid email profile`, `youtube.readonly`, `youtube.force-ssl`, `yt-analytics.readonly`, `youtube.upload`를 요청한다(`access_type=offline`).
  - 토큰과 크리에이터 채널 프로필(`CreatorProfile`)은 `Workspace`의 `sessions/<session_id>/session.json`(`STUDIO_GCS_BUCKET` 설정 시 GCS 동기화)에 보관하고, 브라우저에는 HttpOnly 쿠키(`ytcreator_session`)만 심는다. 만료 60초 전에는 `refresh_token`으로 자동 갱신한다.
  - 분석·업로드·렌더·YouTube API 라우트는 모두 로그인 세션을 요구한다(`HTTP 401`).
- **YouTube Analytics(많이 본 구간·적게 본 구간) & 실제 댓글 & 공식 자막 연동 (`yt/studio/youtube.py`, `yt/studio/director.py`, `yt/studio/prompts.py`)**:
  - 시작 화면에서 로컬 파일을 올리면 채널의 업로드 영상 중 `#shorts`가 없는 롱폼 영상 목록을 최신 업로드 날짜순으로 불러오고, 업로드한 파일과 재생 시간이 일치(±2초 이내)하는 최신 영상을 자동으로 연결·강조 표시한다.
  - 연결된 영상에 대해 YouTube Analytics API v2(`metrics=audienceWatchRatio,relativeRetentionPerformance`, `dimensions=elapsedVideoTimeRatio`, `filters=video==<id>`)로 시청자 유지율 곡선을 조회해 **많이 본 구간(`YouTubeRetentionPeak`)**과 **적게 본·이탈 구간(`YouTubeRetentionLow`)**을 함께 추출한다.
  - 동시에 YouTube Data API v3 `commentThreads.list`로 실제 시청자 댓글(좋아요순 및 타임스탬프 언급 댓글)을 조회하고, `captions.list` / `captions.download`(`tfmt=srt`, 수동 트랙)로 공식 자막 트랙을 받아 온다.
  - 시작 화면에서는 `[데이터로 편집 요청 튜닝]` 버튼으로 많이 본 구간·적게 본 구간·시청자 댓글 반응을 사용자의 `Editorial Prompt` 텍스트에 즉시 반영해 직접 수정할 수 있게 하고, 분석 실행 시에도 프롬프트(`# YouTube Audience Retention & Viewer Comments`)에 포함해 Gemini가 많이 본 구간과 댓글 호평 장면을 우선 선별하고 적게 본 구간은 피하게 한다.
  - 편집 화면에서는 4열 와이드 레이아웃(`시나리오 | 클립 | 미리보기 | 자막·스타일·소리·반응/댓글`)을 적용해 왼쪽 여백에 시나리오 사이드바를 두고, 클립 카드의 많이 본/적게 본 구간 배지와 우측 `반응·댓글` 탭에서 유지율 그래프와 실제 댓글을 언제든 확인하며 편집할 수 있다.
- **YouTube Shorts 직접 업로드 (`yt/studio/youtube.py`, `ExportDialog.tsx`)**:
  - 내보내기 대화상자에서 고화질(1080p FHD / 1440p QHD / 4K UHD) MP4 렌더가 끝나면 파일 다운로드와 함께 제목·설명(`#Shorts` 자동 보강)·공개 상태(`private` / `unlisted` / `public`)를 지정해 YouTube Data API v3 Resumable Upload로 내 채널에 바로 올릴 수 있다.

## Considered Options

- IAP를 유지하고 앱 안에서 별도로 YouTube OAuth를 한 번 더 거치는 안: 외부 크리에이터가 조직 정책 때문에 IAP 자체를 통과할 수 없고, 로그인을 두 번 해야 해 사용성이 나쁘다.
- `google-auth-oauthlib` / `google-api-python-client` 패키지 추가: `uv.lock`이 사내 Airlock 미러를 참조해 Cloud Build 호환성을 깨뜨리므로, 기존 `httpx`만으로 OAuth 토큰 교환·갱신·YouTube Data/Analytics REST 호출·Resumable Upload를 직접 구현했다.
