// ─────────────────────────────────────────────────────────────────────────────
// SNACKAPP DESIGN TOKENS — SINGLE SOURCE OF TRUTH ("Mini-Block Arcade")
// ─────────────────────────────────────────────────────────────────────────────
// 확정 방향(2026-06-26): 검정+라임 유지·심화 + 청키 블록 시그니처 + 절제된 픽셀.
// 이 파일이 색/라디우스/간격/그림자/서체의 유일한 원천이다. 세 소비처가 파생한다:
//   1) snack-server/src/componentLibrary.mjs  (Bite node props)  ← P3에서 채택
//   2) snack-player/src/tokens.gen.ts          (React CSS)  ← gen-tokens.mjs로 생성
//   3) snack-server/src/builder.mjs            (생성 프롬프트 토큰표)  ← P3
//
// 규율(린트로 강제 예정):
//   · 라임(accent)은 단일 영웅 색 — CTA·현재선택·1위에만. 장식 금지.
//   · 라임 면 위 텍스트/아이콘은 항상 accentInk(검정). 라임-온-라임 금지.
//   · 별점·일반 뱃지는 ink(흰색)로. 초록/빨강은 의미색 전용(장식 아님).
//   · spacing은 4그리드만. radius는 4단만. raw hex 직박 금지.
// ─────────────────────────────────────────────────────────────────────────────

export const TOKENS = {
  // ── 색 (고정 로스터 · 역할 잠금) ──
  color: {
    bg:          "#0B0C0E", // 영구 중립 바닥
    surface:     "#16181C", // 블록 바디
    surface2:    "#1E2127", // 카드 위 카드 / 입력 / 트랙
    hairline:    "#2A2D33", // 디바이더 1px 전용 (블록 테두리로 쓰지 않음)
    borderBlock: "#3A3F47", // 청키 블록 두꺼운 테두리 2~3px
    ink:         "#FFFFFF", // 기본 텍스트 + 별점·뱃지(라임서 강등)
    inkMuted:    "#9AA3AF", // 보조/설명/비활성
    accent:      "#D9FF00", // 단일 영웅 색
    accentInk:   "#0B0C0E", // 라임 면 위 텍스트는 항상 이 검정
    live:        "#22C55E", // 접속·성공 신호 전용
    roster1:     "#FF5A5F", // 옵션1 / 오답·위험
    roster2:     "#4DA3FF", // 옵션2
    roster3:     "#FACC15", // 옵션3 / 경고
    roster4:     "#B46CFF", // 옵션4 / '같이' 멀티 태그
    shadow:      "#000000", // 하드 오프셋 그림자
  },

  // ── 라디우스 (강한 레트로 = 샤프 픽셀 코너) ──
  radius: { block: 0, chip: 0, bar: 0, full: 999 },

  // ── 보더 3단 ──
  border: { hairline: 1, block: 2, heavy: 3 },

  // ── 간격 4그리드 ──
  space: { s1: 4, s2: 8, s3: 12, s4: 16, s5: 24, s6: 32 },

  // ── 그림자 (blur 0 = 진짜 크리스프 네오브루탈, 필터비용 0) ──
  // 표현: CSS는 "x y blur color", Bite shadow는 {x, y, blur:0, color}
  shadow: { hardY: 6, hardYsm: 5 },

  // ── 서체 (픽셀은 외침=display, 본문은 가독=body) ──
  // display = Galmuri11(한글+라틴 픽셀, 셀프호스팅 /fonts/galmuri11.woff2) → 제목·점수·뱃지·브랜드.
  //   Press Start 2P(라틴 전용 아케이드)는 보조 폴백. @font-face는 index.html.
  // body = 가독 폰트(긴 한글·잔글씨). 22px 미만 한글엔 display 금지.
  font: {
    display: '"Galmuri11", "Press Start 2P", ui-monospace, monospace',          // 한글+라틴 픽셀 (제목/점수)
    displayLatin: '"Press Start 2P", "Galmuri11", ui-monospace, monospace',      // 라틴/숫자 전용 강한 아케이드 (브랜드마크)
    body:    '-apple-system, "Apple SD Gothic Neo", "Pretendard", system-ui, "Segoe UI", Roboto, sans-serif',
  },

  // ── 타입 스케일 ──
  size:   { displayLg: 40, displayMd: 28, titleLg: 26, titleMd: 21, bodyLg: 17, bodyMd: 15, bodySm: 13, caption: 12 },
  weight: { display: 800, strong: 700, body: 600, muted: 500 },

  // ── iOS 레이아웃 치수(390×844 고정 프레임; 템플릿·컴포넌트가 소비) ──
  layout: { safeTop: 59, safeBottom: 34, margin: 16, navH: 44, rowH: 56, btnH: 50, tap: 44 },
};

// CSS 하드 그림자 헬퍼 (React 측에서 사용)
export const hardShadow   = `0 ${TOKENS.shadow.hardY}px 0 ${TOKENS.color.shadow}`;
export const hardShadowSm = `0 ${TOKENS.shadow.hardYsm}px 0 ${TOKENS.color.shadow}`;
// 8비트 픽셀 베벨: 밝은 상단 하이라이트 + 어두운 하단 음영 → 어두운 바닥에서도 '솟은 블록'으로 읽힘.
// (검정 위 검정 드롭섀도는 안 보여 'too weak' 했던 문제 해결)
export const pixelBevel  = "inset 2px 2px 0 rgba(255,255,255,0.10), inset -2px -2px 0 rgba(0,0,0,0.45)";
// 블록 표준 그림자 = 베벨 + 하드 오프셋 (카드/버튼에 통째로 사용)
export const blockShadow = `${pixelBevel}, ${hardShadow}`;
