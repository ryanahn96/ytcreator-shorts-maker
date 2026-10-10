# 말로 편집의 음성 입력은 브라우저 Web Speech API로 받고 음성 답변은 Gemini TTS로 읽는다

말로 편집은 음성으로도 Edit Request를 받고, 편집 결과를 글과 함께 음성으로도 읽어 준다. 받아쓰기는 브라우저의 Web Speech API가 한국어 `ko-KR`로 한다. 말하는 동안 중간 글자를 입력창에 보여 주고, 확정되면 글로 입력한 요청과 똑같이 보낸다. 그 뒤의 서버와 Gemini 편집 호출은 글 입력과 같다. Web Speech API가 없는 Firefox 같은 브라우저에서는 마이크 버튼을 숨긴다. 편집 결과가 도착하면 브라우저는 화면 편집과 글자 안내를 즉시 반영한 뒤, 편집 호출이 귀로 듣기 좋게 따로 써 준 답(`speech`)과 안내를 서버의 Gemini TTS(`gemini-3.8-flash-lite-tts` 기본, `gemini-3.8-flash-tts` 폴백, `Kore` 목소리)로 보내 받아 온 오디오를 재생한다. 사용자는 위젯에서 음성 읽기를 끄거나 재생 중인 음성을 멈출 수 있으며, 마이크로 듣거나 TTS가 말하는 동안에는 미리보기 재생을 멈춰 영상 소리와 섞이지 않게 한다.

## Considered Options

- Gemini 3.5 Transcribe Live: 한국어 실시간 받아쓰기와 단어 목록 보정은 가장 좋지만, Live API는 WebSocket으로만 쓴다. 브라우저가 직접 붙을 때 쓰는 임시 토큰은 Gemini API 키 방식에만 있고, 배포본은 Vertex AI를 쓴다. 서버가 중계하려 해도 Cloud Run 문서는 WebSocket을 쓰려면 HTTP/2 end-to-end를 켜지 말라고 한다. 이 서비스는 32 MiB가 넘는 영상 업로드를 받으려고 Hypercorn h2c로 HTTP/2 end-to-end를 켜 두었다. 중계 전용 HTTP/1 서비스를 하나 더 두거나 업로드를 조각으로 나눠야 해서 이번에는 쓰지 않는다.
- 녹음한 오디오를 편집 호출에 함께 보내 Flash가 듣고 바로 편집하는 안: 배포를 바꾸지 않고 고유명사 인식에도 유리하지만, 말하는 동안 글자가 뜨지 않는다. 사용자가 Web Speech API를 골랐다.
- 브라우저 내장 `speechSynthesis`로 답장을 읽는 안: 기기와 OS마다 한국어 목소리 품질 편차가 크다. 사용자가 Gemini TTS API를 골랐다.
