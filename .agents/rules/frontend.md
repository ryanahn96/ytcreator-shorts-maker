---
trigger: model_decision
description: frontend/ 아래 React, TypeScript, CSS 코드나 스튜디오 화면을 고치기 전에 읽는다. DESIGN.md와 실제 색·글꼴 토큰의 관계, CSS와 Vite에서 생기는 함정.
---

# 프런트엔드 규칙

- 화면을 고치기 전에 [DESIGN.md](../../DESIGN.md)를 읽는다. 토큰의 실제 값은 `frontend/src/index.css`에 있고, DESIGN.md의 색 표와 글꼴은 그 값과 같다.
- 작업 화면 색은 `bg-surface-container`, `text-on-surface-variant`처럼 index.css 토큰에서 나온 Tailwind 클래스로 쓰고, 라이트와 다크 테마를 둘 다 확인한다. Shorts 캔버스 색은 사용자가 고르는 Look Style 값이라 여기에 해당하지 않는다.
- `index.css`의 커스텀 클래스는 CSS 레이어 밖에 있어서 같은 요소의 Tailwind 유틸리티를 이긴다. 둘이 부딪히면 요소를 한 겹 감싸거나 CSS 규칙을 따로 쓴다. `buttonClass`에는 이미 `inline-flex`가 있어서 반응형으로 숨길 때는 `max-lg:hidden`을 쓴다.
- `npm run lint`는 `tsc --noEmit`뿐이다. ESLint와 Prettier가 없어서 `eslint-disable` 주석은 아무 일도 하지 않는다.
- Vite HMR 갱신이 `Studio.tsx`까지 번지면 Fast Refresh가 Studio와 그 hook의 effect 정리 함수를 의존성과 상관없이 다시 돌린다. 컴포넌트가 아닌 값(함수, 상수)을 export하는 컴포넌트 파일을 고쳐도 갱신이 그 파일을 import하는 쪽으로 번진다. 그래서 언마운트 정리 함수에서 blob URL 해제처럼 되돌릴 수 없는 일을 하지 않는다. `useSourceUpload`도 업로드만 멈추고 원본 영상 URL은 남긴다. 업로드 중에 갱신이 번지면 업로드가 멈추니 다시 올린다.
