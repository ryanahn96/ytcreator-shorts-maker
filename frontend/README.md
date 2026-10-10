# Agentic Shorts 생성 스튜디오 (Frontend)

React 19 + TypeScript(strict) + Vite + Tailwind 4 UI입니다. 구조와 API는 루트
[README.md](../README.md)를 보세요.

```bash
npm install
npm run dev     # :3000, 백엔드(src.main, :5000)를 함께 띄움
npm run lint    # tsc --noEmit
npm run build   # dist/ 생성, 백엔드가 서빙
```

- 화면은 라우팅 없이 시작 → 분석 중 → 편집 셋이고 `components/Studio.tsx`가 고릅니다.
- 색은 `src/index.css`의 Material 3 색 역할 변수 한 곳에서 관리합니다. `<html>`의
  `data-theme`이 라이트·다크를 고르고, `index.html`이 첫 화면을 그리기 전에 저장된 테마를
  적용합니다. Tailwind에서는 `bg-surface`, `text-on-surface`, `text-primary`처럼 씁니다.
- 아이콘은 Material Symbols Rounded입니다. 새 아이콘은 `src/components/Icon.tsx`의
  `ICON_NAMES`에 알파벳순으로 넣어야 글꼴에 포함됩니다.
- 브라우저 미리보기는 렌더와 같은 Subcut과 J/L컷 타이밍을 씁니다. 렌더는 서버에서
  1080×1920 MP4 하나로 만듭니다.