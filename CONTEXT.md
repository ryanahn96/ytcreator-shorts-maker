# Agentic Shortform Studio

원본 롱폼 영상에서 AI가 핵심 발화 구간을 탐색·선별하고, 원본 음성·자막·영상을 결합한 점프컷 숏폼 시나리오를 구성 및 편집하는 스튜디오.

## Language

**Source Video**:
분석 및 렌더링의 대상이 되는 원본 롱폼 영상.
_Avoid_: Preset video, sample clip, raw media

**Transcript Word**:
원본 영상의 자막에서 추출한 시작 시각과 종료 시각을 가진 최소 단위 발화 단어.
_Avoid_: Atom, token, event, timedtext segment

**Editorial Prompt**:
원본 영상에서 어떤 기준으로 구간을 선별하고 시나리오를 구성할지 정의하는 사용자 편집 지시문.
_Avoid_: System template, rule config

**Scenario**:
하나의 완결된 숏폼 영상을 이루는 순서 있는 Clip들의 편집 시퀀스.
_Avoid_: Preset, template, archetype

**Clip**:
원본 영상에서 특정 시작 시각부터 종료 시각까지 잘라낸 단일 편집 구간.
_Avoid_: VerifiedSegment, LongformPresetSegment, DiscourseUnit, Atom

**Subcut**:
하나의 Clip 내부에서 무음이나 불필요한 호흡을 제외하고 실제로 재생되는 발화 하위 구간.
_Avoid_: IntraClipSubcut, silence trim span

**Short Template**:
모든 숏폼이 공유하는 단일 9:16 화면 구성. 기본은 단색 배경 가운데 16:9 영상 박스, 박스 위 Headline 두 줄, 박스 안 아래쪽 자막 한 줄이다. Framing Layout으로 영상을 화면 전체로 채우거나 박스 모서리를 각지게 바꿀 수 있다. 템플릿은 배치(기하)만 정하고, 색과 글꼴은 Look Style이 정한다.
_Avoid_: Layout kind, split stack, fit blur, center crop

**Look**:
Clip이 화면에 어떻게 보일지 정하는 묶음. Headline, Framing Layout, Text Layout, Look Style, Image Overlay로 이루어진다. Scenario는 모든 Clip이 함께 쓰는 공통 Look을 하나 가지고, 사용자가 고른 Clip만 공통 Look을 복사한 자기 Look을 가질 수 있다. 자기 Look을 지우면 그 Clip은 다시 공통 Look을 따른다. Audio Transition과 Background Music은 Look에 속하지 않는다.
_Avoid_: Clip style, theme, preset

**Look Style**:
Look의 색과 글꼴. 캔버스 배경색, 박스 영상 바깥쪽 테두리(켜기·색·두께), 그리고 Headline과 자막 각각의 Text Style을 가진다. 테두리는 박스 배치에서만 그려진다.
_Avoid_: Theme, skin, template colors

**Text Style**:
Headline 또는 자막 한 블록을 그리는 방식. Bundled Font 하나, 크기(ASS 글자 크기, 한 줄 높이), 글자색(Headline은 첫 줄 강조색과 둘째 줄 색), 외곽선 색·두께, 줄마다 깔리는 배경 박스(켜기·색·불투명도)를 가진다.
_Avoid_: Caption style, font settings

**Bundled Font**:
저장소(yt/studio/fonts)에 들어 있는 무료(OFL) 한글 글꼴 파일. 렌더(ffmpeg)와 미리보기(브라우저)가 같은 파일을 쓴다. Text Style은 이 목록에서만 글꼴을 고른다.
_Avoid_: System font, font family setting

**Framing Layout**:
Look 안에서 영상이 캔버스에 놓이는 방식. 박스(16:9) 또는 전체 화면(9:16), 박스일 때 둥근·각진 모서리, 그리고 원본 화면에서 보여줄 부분을 정하는 크롭(가로·세로 위치와 확대)을 가진다. 확대 1은 그 비율로 원본에서 가장 크게 잘라낸 영역이다.
_Avoid_: Clip crop mode, layout kind

**Headline**:
Look마다 정하는 두 줄 제목. 첫 줄은 강조색, 둘째 줄은 기본색이다(색은 Look Style의 Headline Text Style). 박스 배치에서는 영상 박스 위, 전체 화면에서는 영상 위에 겹친다. Scenario 제목(탭과 파일 이름용)과는 다르다.
_Avoid_: Context banner, title overlay

**Audio Transition**:
하나의 Scenario 안의 모든 Clip 경계에 통일되어 적용되는 음성 전환 방식.
_Avoid_: Per-clip transition

**Text Layout**:
Look의 Headline 블록과 자막 줄의 위치. 각 위치는 마지막 줄 아래쪽 가운데 기준점(1080×1920 캔버스 좌표)이며, 기본값은 박스·전체 화면 배치마다 따로 있다.
_Avoid_: Caption margin

**Image Overlay**:
사용자가 올린 이미지를 그 Look을 쓰는 Clip이 재생되는 동안 영상과 글자 위에 얹는 요소. 가운데 좌표, 너비·높이, 시계 방향 회전 각도를 가진다.
_Avoid_: Sticker, watermark, logo layer

**Background Music**:
사용자가 올린 오디오를 Scenario의 원본 음성 아래에 반복 재생으로 깔고, 음성 길이에 맞춰 자른 뒤 끝에서 줄여 끝내는 배경음. 볼륨은 0~100%이며 원본 음성 크기는 바꾸지 않는다.
_Avoid_: BGM track, soundtrack mix

**Uploaded Asset**:
Image Overlay나 Background Music에 쓰려고 서버에 올린 이미지·오디오 파일. Source Video 업로드와는 따로 보관된다.
_Avoid_: Media file, attachment
