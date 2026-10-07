# Quickstart — 전 품질 게이트 end-to-end 실행

이 feature가 "출시 품질"인지 증명하는 실행 가이드. 모든 게이트가 PASS면 spec의 SC-001~007 충족.

## 전제
```bash
pnpm install
pnpm server:dev        # snack-server :4399
pnpm player:build      # prod 빌드(오라클은 /p/tpl-<id> prod 경로 사용)
# (오라클용) npx playwright install chromium
```

## 게이트 실행

```bash
# A,C — 실제-터치 오라클 (전 스낵 PASS = SC-001/004)
node snack-server/tools/e2e-audit.mjs

# 레이아웃 (V/F — in-bounds/overlap/binding)
node snack-server/tools/verify-layout.mts

# B — 콘텐츠 품질·정합·dedup (SC-002/003)
node snack-server/tools/content-quality.mjs

# E — 멀티클라이언트 동기화 (SC-005); 서버 실행 중이어야 함
node snack-server/tools/multiclient-sim.mjs

# F — 생성 배터리 (SC-006); OpenAI 키 필요
node snack-server/tools/gen-battery.mjs --n 20
```

## 기대 결과 (출시 합격선)
- e2e-audit: 29/29 PASS, exit 0 (open 4종 포함).
- content-quality: violations 0, exit 0.
- multiclient-sim: 전 멀티플레이어 스낵 converged·desync 0·tallyError 0, exit 0.
- gen-battery: passRate ≥ 0.90.

## 통합 게이트 (선택)
```bash
# 한 번에 — 하나라도 실패 시 non-zero
node snack-server/tools/e2e-audit.mjs && \
node snack-server/tools/content-quality.mjs && \
node snack-server/tools/multiclient-sim.mjs
```

## 수동 확인(보조, 게이트 아님)
- 폰에서 cloudflared 터널로 같은 링크 2대 접속 → 투표 % 동시 갱신 눈으로 확인.
- "되는 척" 금지(헌법 I): 위 자동 게이트 증거 없이는 done 아님.
