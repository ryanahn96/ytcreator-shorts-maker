# 말로 편집의 음성 입력은 브라우저 Web Speech API로 받는다

말로 편집은 음성으로도 Edit Request를 받는다. 받아쓰기는 브라우저의 Web Speech API가 한국어 `ko-KR`로 한다. 말하는 동안 중간 글자를 입력창에 보여 주고, 확정되면 글로 입력한 요청과 똑같이 보낸다. 그 뒤의 서버와 Gemini 호출은 글 입력과 같다. Web Speech API가 없는 Firefox 같은 브라우저에서는 마이크 버튼을 숨긴다. 듣기 시작하면 미리보기 재생을 멈춰 영상 소리가 마이크에 섞이지 않게 한다.

답장을 Gemini TTS로 소리 내어 읽는 기능은 2026-10-10에 넣었다가 같은 날 뺐다. 답은 글로만 보여 준다.

## Considered Options

- Gemini 3.5 Transcribe Live: 한국어 실시간 받아쓰기와 단어 목록 보정은 가장 좋지만, Live API는 WebSocket으로만 쓴다. 브라우저가 직접 붙을 때 쓰는 임시 토큰은 Gemini API 키 방식에만 있고, 배포본은 Vertex AI를 쓴다. 서버가 중계하려 해도 Cloud Run 문서는 WebSocket을 쓰려면 HTTP/2 end-to-end를 켜지 말라고 한다. 이 서비스는 32 MiB가 넘는 영상 업로드를 받으려고 Hypercorn h2c로 HTTP/2 end-to-end를 켜 두었다. 중계 전용 HTTP/1 서비스를 하나 더 두거나 업로드를 조각으로 나눠야 해서 이번에는 쓰지 않는다.
- 녹음한 오디오를 편집 호출에 함께 보내 Flash가 듣고 바로 편집하는 안: 배포를 바꾸지 않고 고유명사 인식에도 유리하지만, 말하는 동안 글자가 뜨지 않는다. 사용자가 Web Speech API를 골랐다.
