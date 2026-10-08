# Cloud Run + IAP + GCS로 배포하고, 영상은 Context Cache와 전체 자막으로 다시 분석한다

`deploy.sh`는 `gcloud run deploy --source`로 서비스 하나를 올렸다. 누구나 URL로 들어왔고, 업로드와 렌더 파일은 인스턴스 메모리에만 있어 인스턴스를 1개로 묶어야 했으며, 인스턴스가 내려가면 다시 올려야 했다. 다시 분석은 매번 영상을 처음부터 Gemini에 보내 몇 분과 비용을 다시 썼다. 사용자는 배포를 Terraform으로 옮기고, GCP 계정이 있는 사람만 들어오게 하고, 영상을 Cloud Storage에 두되 로컬에서는 지금처럼 디스크에 두고, 프롬프트만 고친 재분석은 몇 초 만에 끝나길 바랐다. 같은 작업에서 편집 규칙도 바꿨다: 클립 사이는 하드 컷만, 헤드라인은 줄 수 제한 없이, 자막은 영상 박스 아래 배경 위에, 미리보기에서 글자나 이미지를 누르면 오른쪽 패널이 그 항목으로 옮겨 간다.

그래서 다음과 같이 정한다.

- 인프라는 `terraform/`이 정의한다: Cloud Run v2 서비스(Hypercorn h2c, 0~5 인스턴스), Artifact Registry 저장소, 미디어 버킷, 런타임 서비스 계정, API. `deploy.sh`는 Cloud Build로 이미지를 올리고 다이제스트를 고정해 `terraform apply`하는 얇은 wrapper다. 상태는 로컬 파일이다.
- 접근은 Cloud Run 자체 IAP(`iap_enabled`)로 막는다. 들어올 수 있는 멤버는 `iap_access_members`이고 기본은 `allAuthenticatedUsers`다. 조직 정책 `constraints/iam.allowedPolicyMemberDomains`가 있는 프로젝트는 이 값을 거부하므로 `domain:`이나 `user:` 멤버를 넘긴다. *(이후 [ADR 0010](0010-youtube-oauth-retention-and-direct-upload.md)에서 외부 유튜브 크리에이터 접속과 본인 채널 YouTube API 활용을 위해 IAP를 제거하고 Google / YouTube OAuth 2.0으로 대체함.)*
- 저장은 `STUDIO_GCS_BUCKET`으로 고른다. 값이 있으면 `Workspace`가 원본, 분석용 사본, 전체 자막, 캐시 정보, 자산, 렌더 결과를 버킷에 두고 로컬 디스크는 내려받기 캐시로만 쓴다. 비어 있으면 지금처럼 로컬 디스크만 쓴다. GCS는 google-auth 토큰과 JSON API(httpx)로 직접 부르고 새 Python 의존성은 들이지 않는다. 버킷 수명 주기가 파일을 지운다.
- 첫 분석은 영상을 보고 전체 자막(`transcriptLines`)을 한 번에 받아 `transcript.json`으로 보관하고, 분석용 사본을 Gemini Context Cache에 `STUDIO_CONTEXT_CACHE_TTL_SEC`(기본 1시간) 동안 올려 둔다(`cache.json`). 다시 분석은 두 가지다. `fast`(기본)는 보관한 자막만 텍스트로 보내 구간을 다시 고르므로 몇 초면 끝난다. `deep`은 영상을 다시 보되 캐시가 살아 있으면 `cached_content`로 참조해 입력 토큰을 할인받고, 캐시가 없거나 만들 수 없으면 영상을 요청에 직접 담는다. 캐시 생성이 실패해도 분석은 멈추지 않고 경고만 남긴다.
- 클립은 하드 컷으로만 이어진다. `AudioTransition`, J컷·L컷 타임라인, 미리보기의 보조 비디오가 모두 빠진다.
- `Headline`은 `lines: string[]`이다. 첫 줄은 강조색, 나머지는 기본색, 빈 줄은 그리지 않는다. 사용자가 줄을 더하고 뺀다.
- 자막의 기본 위치는 박스 아래 `caption_gap`만큼 떨어진 배경 위다(헤드라인은 그대로 박스 위).
- 미리보기에서 3캔버스 단위 미만으로 움직인 누름은 클릭이다. 헤드라인 줄을 누르면 스타일 탭의 그 줄 입력으로, 자막을 누르면 자막 탭의 "자막 수정"으로 재생 위치의 단어 편집을 열고, 빈 자막 자리를 누르면 자막 글자 스타일로, 이미지를 누르면 그 이미지의 설정으로 스크롤한다.

## Considered Options

- 배포를 `gcloud run deploy`에 두고 IAP만 `--iap` 플래그로 켜는 안: 버킷, IAM, API까지 한곳에 남기려 Terraform을 골랐다.
- IAP 앞에 외부 HTTPS 부하 분산기를 두는 고전 구성: 도메인과 인증서가 더 필요하다. Cloud Run 자체 IAP면 충분하다.
- `google-cloud-storage` 클라이언트 라이브러리: `uv.lock`이 사내 미러를 가리켜 의존성 추가가 번거롭고, 필요한 호출이 업로드·다운로드·목록·삭제뿐이라 JSON API를 직접 부른다.
- 전체 자막도 Context Cache에 넣는 안: 10~20분 영상의 자막은 수천 토큰이라 캐시 최소 토큰 수에 못 미치고, 캐시 없이 보내도 거의 무료라 서버 파일로 둔다.
- `fast`를 영상 없이 돌리지 않고 늘 캐시된 영상을 쓰는 안: 캐시가 만료되면 영상을 다시 올려야 해 "몇 초" 목표를 못 지킨다. 화면이 필요할 때만 `deep`을 고르게 한다.
- 헤드라인 줄 수를 3~4줄로 제한하는 안: 사용자가 상한을 두지 말라고 했다. Gemini에게는 보통 두 줄, 길어야 세 줄을 제안하라고만 적는다.
