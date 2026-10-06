# Scenario 단위 글 위치·이미지·배경음악과 영상 파일 분석

ADR 0004의 Short Template은 Headline과 자막 자리를 고정했다. 사용자가 글 위치를 옮기고, 이미지를 넣어 크기·회전·위치를 바꾸고, 배경음악을 볼륨과 함께 깔고, YouTube 링크 대신 영상 파일로도 분석을 시작하길 원했다. ADR 0003·0004가 화면 구성을 Scenario 전체에 통일한 흐름을 따라 Text Layout, Image Overlay, Background Music도 Clip별이 아니라 Scenario 단위로 둔다. Text Layout 기본값은 템플릿 자리이고, 미리보기에서 끌어 옮기거나 슬라이더로 바꾼다. 이미지는 Scenario 전체 길이 동안 영상과 글자 위에 그린다. 배경음악은 반복 재생해 음성 길이에 맞춰 자르고 끝에서 1.5초 동안 줄이며, 브라우저 `<audio>`가 1보다 크게 키울 수 없어 최대 볼륨은 100%다. 렌더는 여전히 ffmpeg 명령 하나와 ASS 파일 하나다. 이미지는 추가 입력을 `scale`·`rotate` 후 자막 뒤에 `overlay`하고, 음악은 `-stream_loop`로 넣어 `amix`한다.

미리보기에서 헤드라인 두 줄이 겹친 원인은 두 가지였다. libass의 Fontsize는 글자 크기가 아니라 줄 높이(Noto CJK는 1.448em)라 CSS에서 같은 숫자를 쓰면 글자가 약 1.45배 커져 더 자주 줄바꿈됐다. 또 두 줄이 서로 다른 ASS 이벤트와 별도 div였기 때문에 긴 줄이 위로 넘치면 강조 줄과 겹쳤다. 그래서 Headline을 ASS 이벤트 하나(`\N` 사이 간격 조각 포함)와 HTML 블록 하나로 쌓고, 미리보기 글자 크기는 캔버스 폰트 측정값으로 ASS 크기를 환산한다.

영상 파일 분석은 YouTube URL 대신 업로드한 Source Video를 360p·10fps 분석용 사본으로 줄여 요청에 직접 담고 AGENTIC으로 보낸다. Files API는 AI Studio에만 있어 두 백엔드에 같은 방식을 쓰며, Vertex 인라인 한도(100MB)를 넘으면 분석을 거절한다. 자막이 없으므로 받아쓰기도 Gemini가 한다. 분석을 다시 돌리는 기능은 이미 있었다(Editorial Prompt를 고치고 다시 분석).

갱신: 화면 구성을 Scenario 전체에 하나로 두던 부분은 [ADR 0006](0006-per-clip-looks-and-video-fit.md)의 Clip별 Look으로 바뀌었다.
