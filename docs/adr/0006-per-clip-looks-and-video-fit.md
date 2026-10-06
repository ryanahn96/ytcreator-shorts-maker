# Clip별 Look, 전체 화면 배치, 점프컷·자막 설정 패널 제거

ADR 0003·0004·0005는 화면 구성(크롭, Headline, 글 위치, 이미지)을 Scenario 전체에 하나로 통일했다. 사용자가 방향을 바꿨다. 영상을 16:9 박스 대신 9:16 화면 전체로 채우거나 박스 모서리를 각지게 할 수 있어야 하고, 글·배치·이미지를 Clip마다 따로 정할 수 있어야 한다. 다만 기본은 여전히 모든 Clip이 한 설정을 함께 쓰는 것이다.

그래서 화면에 관한 설정을 Look(Headline, Framing Layout, Text Layout, Image Overlay) 하나로 묶었다. Scenario는 공통 Look을 가지고, Clip은 `look`이 비어 있으면 공통 Look을 따른다. 편집 화면에서 Clip을 고르고 "Clip N만 따로"를 누르면 그 순간의 공통 Look을 복사해 그 Clip에 붙이고, "모든 Clip 공통"으로 돌리면 복사본을 확인 없이 지운다. Audio Transition과 Background Music은 Clip 경계와 숏폼 전체에 걸치므로 Look에 넣지 않고 Scenario에 남겼다. Gemini는 공통 Look 하나만 추천한다.

Framing Layout에 `fit`(box, full)과 `rounded`를 더했다. full이면 크롭 비율이 9:16이고 영상이 캔버스 전체를 채우며 모서리 설정은 쓰지 않는다. 글 위치 기본값은 배치마다 따로 있다(box: Headline 606, 자막 1218 / full: 480, 1480). 배치를 바꿀 때 글이 이전 배치의 기본 자리에 그대로 있으면 새 배치의 기본 자리로 옮기고, 사용자가 옮겨 둔 글은 그대로 둔다.

렌더는 여전히 ffmpeg 명령 하나와 ASS 파일 하나다. 크롭·스케일·박스 패딩은 Clip마다 이어 붙이기 전에 적용한다. J/L컷이 있으면 Clip 경계에서 영상과 음성 시점이 어긋나므로, Look이 바뀌는 시점은 영상 타임라인을 따른다. 이웃한 Clip이 같은 Look이면 한 구간으로 합친다(`composer.look_spans`). ASS에는 구간마다 모서리 가림(박스·둥근 모서리일 때만)과 Headline 이벤트를 넣고, 자막은 구간 경계에서 나누며 구간의 박스 폭에 맞춘 여백을 이벤트마다 준다. 이미지는 구간별 `overlay`에 `enable`로 시간을 제한한다.

같은 요청에서 "점프컷·자막 설정" 패널(무음 기준, 앞뒤 여유, 자막 글자 수와 간격)을 없앴다. 기본값만 쓰고, 값 자체는 서버 설정(`CompositionSettings`)에 남아 있다.
