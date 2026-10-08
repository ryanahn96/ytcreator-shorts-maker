# Agentic Shorts 생성 스튜디오

유튜브 크리에이터가 본인 Google / YouTube 계정으로 로그인해 올린 롱폼 영상 파일(및 선택적으로 연결한 내 채널 영상의 시청자 유지율·공식 자막 데이터)에서 Gemini가 핵심 발화 구간을 탐색·선별하고, 원본 음성·자막·영상을 결합한 점프컷 Shorts를 구성·편집해 내 채널에 바로 업로드하는 스튜디오.

## Language

화면에서는 _화면 표기_ 가 있는 용어를 그 말로 부른다.

**Source Video**:
사용자가 올린 원본 롱폼 영상 파일. 분석과 렌더링에 같은 파일을 쓴다. 이미 내 YouTube 채널에 올라가 있는 롱폼 영상(`#shorts`가 없는 영상)이라면 영상 길이와 최신 업로드 날짜를 기준으로 매칭하거나 직접 골라 YouTube Video Context를 연결할 수 있다.
_Avoid_: preset video, sample clip, raw media

**YouTube Video Context**:
로그인한 크리에이터가 Source Video에 연결한 본인 채널 롱폼 영상의 메타데이터(재생 시간, 업로드 날짜, 조회수, 좋아요 수, 댓글 수, 공개 상태), YouTube Analytics 시청자 유지율 곡선(`retentionPoints`), 많이 본 시청 집중 구간(`retentionPeaks`), 적게 본 이탈·저조 구간(`retentionLows`), 실제 시청자 댓글(`comments`), 그리고 공식 자막 트랙(`captionWords`). 시작 화면과 편집 화면 양쪽에서 확인할 수 있으며, 첫 Analysis와 다시 분석 때 Gemini 프롬프트 및 사용자의 Editorial Prompt 튜닝에 활용된다.
_화면 표기_: 내 채널 영상 연결, 시청자 유지율, 많이 본 구간, 적게 본 구간, 시청자 댓글

**Transcript Word**:
원본 음성의 시작 시각과 종료 시각을 가진 최소 단위 발화 단어. 음성 인식(또는 공식 자막)에서 추출해 Source Video 옆에 보관하며, 미리보기 재생 중에는 현재 발화 중인 단어와 대사 줄이 자막 패널에서 실시간으로 강조·추적된다.
_Avoid_: Atom, token, event, timedtext segment

**Editorial Prompt**:
원본 영상에서 어떤 기준으로 구간을 선별하고 시나리오를 구성할지 정의하는 사용자 편집 지시문. 연결된 YouTube Video Context(많이 본 구간, 적게 본 구간, 시청자 댓글 반응)를 바탕으로 영상 맞춤형 지시문으로 튜닝할 수 있다.
_화면 표기_: 편집 요청, 데이터 기반 프롬프트 튜닝
_Avoid_: System template, rule config

**Analysis**:
Source Video와 Editorial Prompt(및 연결된 YouTube Video Context)를 Gemini에 보내 Scenario들과 Transcript Word를 받아 오는 한 번의 실행. 첫 Analysis는 영상을 보고 전체 자막을 받아쓰며, 영상을 Context Cache에 올려 둔다. 다시 분석은 두 가지다: 보관한 전체 자막만으로 구간을 다시 고르는 Fast Re-analysis(기본, 몇 초)와 영상을 다시 보는 Deep Re-analysis(화면을 봐야 하는 요청용, 캐시가 살아 있으면 그것을 재사용). 다시 분석하면 새 Analysis의 결과가 이전 결과를 대신한다.
_화면 표기_: 분석, 다시 분석. Fast는 "빠른 재분석 (자막)", Deep은 "화면 재탐색 (비디오 캐시)"
_Avoid_: Job, run, generation

**Context Cache**:
첫 Analysis 때 분석용 영상 사본을 Gemini에 미리 올려 두고 일정 시간(기본 1시간) 재사용하는 Gemini 기능. Deep Re-analysis가 캐시를 참조하면 영상 입력 토큰이 할인된다. 전체 자막은 토큰이 적어 캐시하지 않고 서버가 파일로 보관한다.
_화면 표기_: 비디오 캐시
_Avoid_: Prompt cache, KV cache

**Analysis Cost**:
Analysis 한 번에서 Gemini가 보고한 토큰 수에 모델 정가를 곱한 예상 비용. 재시도한 호출도 더하고 달러로 나타낸다. 실제 청구액과 다를 수 있다.
_화면 표기_: "약 $0.21"처럼 금액만
_Avoid_: 청구액, billing amount

**Scenario**:
하나의 완결된 Shorts 영상을 이루는 순서 있는 Clip들의 편집 시퀀스.
_화면 표기_: Shorts. 탭마다 Scenario 제목을 붙인다.
_Avoid_: Preset, template, archetype

**Clip**:
Shorts 시퀀스를 이루는 단일 편집 구간. 기본은 원본 영상(Source Video)에서 특정 시작 시각부터 종료 시각까지 잘라낸 구간(`source`)이며, 클립과 클립 사이에 사용자가 올린 외부 이미지(`image`, 지정한 재생 시간 동안 노출)나 외부 영상(`video`, 시작~종료 구간 트리밍 및 음소거 선택 가능)을 B-roll/중간 삽입 클립으로 넣을 수도 있다.
_화면 표기_: 클립, 이미지 삽입, 영상 삽입
_Avoid_: VerifiedSegment, LongformPresetSegment, DiscourseUnit, Atom

**Subcut**:
하나의 Clip 내부에서 무음이나 불필요한 호흡을 제외하고 실제로 재생되는 발화 하위 구간. 화면에는 이름을 드러내지 않는다.
_Avoid_: IntraClipSubcut, silence trim span

**Short Template**:
모든 Shorts가 공유하는 단일 9:16 화면 구성. 기본은 단색 배경 가운데 각진 모서리의 16:9 영상 박스, 박스 위 Headline, 박스 아래 배경 위에 자막 한 줄이다(자막은 영상에 겹치지 않는다). Framing Layout으로 영상을 화면 전체(9:16)로 채우거나 박스의 가로·세로 크기와 위치를 자유롭게 바꿀 수 있으며, 모든 영상 박스는 각진 모서리로 통일한다. 템플릿은 배치(기하)만 정하고, 색과 글꼴은 Look Style이 정한다.
_Avoid_: Layout kind, split stack, fit blur, center crop, rounded corners

**Look**:
Clip이 화면에 어떻게 보일지 정하는 묶음. Headline, Framing Layout, Text Layout, Look Style, Image Overlay로 이루어진다. Scenario는 모든 Clip이 함께 쓰는 공통 Look을 하나 가지고, 사용자가 고른 Clip만 공통 Look을 복사한 자기 Look을 가질 수 있다. 자기 Look을 지우면 그 Clip은 다시 공통 Look을 따른다. Background Music은 Look에 속하지 않는다. 미리보기에서 영상 박스·Headline·자막·Image Overlay를 누르면 오른쪽 패널이 그 항목을 고치는 자리로 바로 옮겨 간다.
_화면 표기_: 스타일. 적용 범위는 "모든 클립"과 "이 클립만"이다.
_Avoid_: Clip style, theme, preset

**Look Style**:
Look의 색과 글꼴. 캔버스 배경색, 박스 영상 바깥쪽 직각 테두리(켜기·색·두께), 그리고 Headline과 자막 각각의 Text Style을 가진다. 테두리는 박스 배치에서만 그려진다.
_Avoid_: Theme, skin, template colors

**Text Style**:
Headline 또는 자막 한 블록을 그리는 방식. Bundled Font 하나, 크기(ASS 글자 크기, 한 줄 높이), 글자색(Headline은 첫 줄 강조색과 나머지 줄 색), 외곽선 색·두께, 줄마다 깔리는 배경 박스(켜기·색·불투명도)를 가진다.
_Avoid_: Caption style, font settings

**Bundled Font**:
저장소(yt/studio/fonts)에 들어 있는 무료(OFL) 한글 글꼴 파일. 렌더(ffmpeg)와 미리보기(브라우저)가 같은 파일을 쓴다. Text Style은 이 목록에서만 글꼴을 고른다.
_Avoid_: System font, font family setting

**Framing Layout**:
Look 안에서 영상이 캔버스에 놓이는 방식. 자유 크기 박스(`box`, 기본 16:9 또는 비율 프리셋·슬라이더·미리보기 드래그로 지정한 `VideoBoxSpec {x, y, width, height}`) 또는 전체 화면(`full`, 9:16), 그리고 원본 화면에서 보여줄 부분을 정하는 크롭(가로·세로 초점과 확대)을 가진다. 모서리는 항상 각진 모서리다.
_Avoid_: Clip crop mode, layout kind, rounded corner

**Headline**:
Look마다 정하는 제목. 줄 수에 제한이 없고 사용자가 줄을 더하거나 뺀다(Gemini는 보통 두 줄, 길어야 세 줄을 제안한다). 첫 줄은 강조색, 나머지 줄은 기본색이다(색은 Look Style의 Headline Text Style). 빈 줄은 그리지 않는다. 박스 배치에서는 영상 박스 위, 전체 화면에서는 영상 위에 겹친다. Scenario 제목(탭과 파일 이름용)과는 다르다.
_Avoid_: Context banner, title overlay

**Hard Cut**:
Clip과 Clip이 만나는 유일한 방식. 앞 Clip의 그림과 소리가 함께 끝나고 다음 Clip이 바로 시작한다. J컷·L컷 같은 소리 겹침은 없다.
_Avoid_: Audio Transition, J-cut, L-cut, crossfade

**Text Layout**:
Look의 Headline 블록과 자막 줄의 위치. 각 위치는 마지막 줄 아래쪽 가운데 기준점(1080×1920 캔버스 좌표)이며, 기본값은 박스·전체 화면 배치마다 따로 있다. 박스 배치의 자막 기본 위치는 박스 아래 배경 위다.
_Avoid_: Caption margin

**Image Overlay**:
사용자가 올린 이미지를 그 Look을 쓰는 Clip이 재생되는 동안 영상과 글자 위에 얹는 요소. 가운데 좌표, 너비·높이, 시계 방향 회전 각도를 가진다.
_Avoid_: Sticker, watermark, logo layer

**Background Music**:
사용자가 올린 오디오를 Scenario의 원본 음성 아래에 반복 재생으로 깔고, 음성 길이에 맞춰 자른 뒤 끝에서 줄여 끝내는 배경음. 볼륨은 0~100%이며 원본 음성 크기는 바꾸지 않는다.
_Avoid_: BGM track, soundtrack mix

**Uploaded Asset**:
Image Overlay, Background Music, 또는 클립 사이 B-roll 삽입(이미지·외부 영상 클립)에 쓰려고 서버에 올린 이미지·오디오·영상 파일. Source Video 업로드와는 따로 보관된다.
_Avoid_: Media file, attachment

**Render**:
Scenario 하나를 Short Template대로 합성해 Shorts MP4 파일 하나로 만드는 일. 완성된 MP4는 파일로 내려받거나 내 YouTube 채널에 Shorts(비공개·일부 공개·공개)로 바로 업로드할 수 있다.
_화면 표기_: MP4 만들기, YouTube Shorts로 업로드
_Avoid_: 최종 렌더, 미리보기 렌더, export
