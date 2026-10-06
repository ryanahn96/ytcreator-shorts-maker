# Agentic Shortform Jumpcut Studio (Frontend)

React 19 + TypeScript(strict) + Vite + Tailwind 4 UI입니다. 구조와 API는 루트
[README.md](../README.md)를 보세요.

```bash
npm install
npm run dev     # :3000, 백엔드(yt.server, :5000)를 함께 띄움
npm run lint    # tsc --noEmit
npm run build   # dist/ 생성, 백엔드가 서빙
```

Subcut은 브라우저(`src/lib/timeline.ts`)에서 계산해 렌더/내보내기 요청에 담아 보냅니다.
백엔드 `yt/studio/composer.py`는 이를 프레임 단위로 맞추고 J/L컷을 적용합니다. 그래서
브라우저 미리보기는 하드컷만 보여주고, 전환은 렌더 결과에서 확인합니다.