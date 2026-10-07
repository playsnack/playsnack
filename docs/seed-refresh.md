# 실데이터 월드컵 — 시드 갱신 런북 (Seed Refresh)

음원/인물 월드컵은 `snack-server/data/pools/*.json` 시드를 읽어 "지금 차트/평판"을 보여준다.
서버 런타임은 Melon·brikorea에 직접 접근하지 못하므로(인증/MCP), **시드는 Claude(인터랙티브 세션)가 주기적으로 재기록**한다. 이 문서가 그 절차다.

> 한 줄: 소스 fetch → `pools/*.json` 갱신 → `validate-pools.mjs` → 서버 재기동. 실패하면 **그냥 덮어쓰지 마라** — 직전 시드가 유지되며 앱은 계속 동작한다.

## 시드 3종 · 소스 · 주기

| 파일 | 소스 | 주기 | 버킷(content.mjs) |
|---|---|---|---|
| `songs.json` | Melon TOP_100 (Melon MCP `get_music_chart`) | **매일** (KST 09시 권장) | 일 버킷 `kstDayBucket(9)` |
| `idols.json` | brikorea 아이돌/걸그룹 **개인** 브랜드평판 (`brikorea.com/rk/bp<YYMM>` 등, WebFetch) | **매월** | 월 버킷 `YYYY-MM` KST |
| `singers.json` | brikorea **가수** 브랜드평판 `…/rk/singer<YYMM>` + 트로트 `…/rk/trot<YYMM>` (WebFetch) | **매월** | 월 버킷 |

`<YYMM>` = 2자리 연/월. 예: 2026년 6월 = `singer2606`, `trot2606`.

## 시드 스키마 (validate-pools가 강제)

```jsonc
// songs.json
{ "updatedAt": "2026-06-29", "items": [ { "song": "갑자기", "artist": "아이오아이", "rank": 1 }, … ] }   // ≥2개

// idols.json / singers.json (동일 스키마)
{ "updatedAt": "2026-06", "items": [ { "name": "임영웅", "rank": 3, "gender": "m", "rookie": true }, … ] } // 성별당 ≥4, 신인 ≥1 권장
```

- **이름만 넣으면 된다.** 위키 검색 q는 `content.mjs`가 만든다(가수=`"이름|가수"` → 서버가 `"이름 (가수)"`→`"이름"` bare 순으로 사진 해상). 시드에 q/url 넣지 말 것.
- `rank` = 평판 순위(작을수록 상위). 인물은 성별별로 정렬 후 **top-16**이 16강이 된다. `rank` 없으면 999 취급.
- `rookie:true` = 신인 1명 이상 보장(SC-002). top-16에 신인이 없으면 풀에서 첫 신인을 마지막 슬롯에 주입.

## 인물 시드 만들 때 주의 (★중요)

1. **솔로/개인만.** 월드컵 카드는 본인 얼굴 사진이라 그룹(방탄소년단·아이브 등)은 단체사진이 떠서 부적합 → 가수 평판 표에서 **솔로만 발췌**한다.
2. **성별은 절대 페이지 추정값을 믿지 마라.** WebFetch 요약 모델이 성별을 틀리게 단다(SC-004 성별 100% 위반 위험). **확신하는 인물만** `gender` 배정하고, 애매하면 **제외**한다.
3. 트로트는 남초 → 여자 풀이 얇으면 `trot<YYMM>`의 여성 트로트(전유진·홍진영·김다현 등)로 보강한다.

## 절차

```bash
# 1) (인터랙티브 Claude) 소스 fetch 후 파일 재기록
#    - songs:   Melon MCP get_music_chart → songs.json
#    - idols:   WebFetch brikorea bp<YYMM> → idols.json
#    - singers: WebFetch brikorea singer<YYMM> + trot<YYMM> → singers.json (솔로·성별검증)

# 2) 스키마/성별/신인/사이즈 검증 (PRESENT-but-broken이면 FAIL)
node snack-server/tools/validate-pools.mjs

# 3) 사진 해상 스폿체크 (선택) — 16강 q가 위키 사진을 끌어오는지
curl -s "localhost:4399/api/content?kind=singercup&theme=f"   # 후보 확인

# 4) 서버 재기동 (부팅 시 룸/시드 캐시) — 데이터 변경은 반드시 재기동
kill $(lsof -ti:4399); BUILD_PER_IP_HR=500 BUILD_GLOBAL_HR=500 node --env-file=snack-server/.env snack-server/src/index.mjs
```

## 폴백·실패 안전 (검증됨, T010/SC-006)

- 시드 **없음/파싱실패** → `content.mjs`가 `null` 반환 → `getContent`가 **LLM worldcup 경로로 graceful 폴백**(앱 안 깨짐, 오라클 PASS 확인).
- 갱신 **실패** → 새 파일을 쓰지 않으면 직전 시드가 그대로 산다. 부분/깨진 JSON을 덮어쓰지 말 것(validate가 1차 방어).

## 자동화(CronCreate)를 지금 안 하는 이유

- 음원(Melon)은 **claude.ai MCP** 경유 → **헤드리스/클라우드 cron에서 미도달**(인증). 가수/아이돌(brikorea)은 WebSearch/WebFetch라 헤드리스 가능하지만, 음원이 빠지면 반쪽이라 "조용한 실패"가 된다.
- 따라서 **인터랙티브 세션에서 위 절차를 주기적으로 수행**하는 것이 현재 가장 신뢰할 수 있는 방식. (검증+재기동 합쳐 ~2분.)
- 추후 음원 소스를 비-MCP(예: 공개 차트 API/페이지)로 바꾸면 cron 자동화 재검토.
