# Snack-App Content Taxonomy + Template Plan (reference-grounded)

Synthesized from a verified deep-research pass (2026-06-23): Instagram/TikTok story
stickers, Kahoot/Mentimeter/Slido, Jackbox, **PlayDuo** (the closest Korean analog),
이상형 월드컵, BoardGameGeek mechanics taxonomy, GameAnalytics/Sensor Tower 2025.
Confidence: format + server-contract claims verified 3-0; the matrix/30-list is
design synthesis (medium). Caveat: the Kaggle "17k App Store" set is strategy-only —
popularity grounding comes from GameAnalytics/Sensor Tower + the format evidence, not it.

## Key evidence
- **Highest-engagement genre = "classic" (trivia/word/quiz)**: top-quartile D1 retention 31%, ~10 min sessions (beats casual 28%/7 min). → skew templates toward **quiz/trivia**.
- **Proven together-pattern = host-driven simultaneous play + live leaderboard** (Kahoot/Jackbox): room/code join, own-device browser, no install.
- **PlayDuo validates our exact product**: create-room + share-invite-link, **≤8 players**, solo-without-login; bingo/MBTI filed as **solo-only**. Worldcup/quiz/tier support realtime + streamer viewer-voting.
- **Instagram stickers** (poll/quiz/emoji-slider/add-yours) map 1:1 onto tap/choice/slider + shared counter; they work because "a poll is one tap, a quiz feels like a game, a slider expresses nuance without typing."

## Current snackapp server contract (from code)
Anonymous **symmetric** clients per room (slug). Server authoritatively tallies a per-room
**`votesByOption` global counter** + broadcasts reactions. **No** per-player scores,
leaderboard, host/player roles, room codes, or turn token.
→ **Buildable NOW (zero server work):** solo (any), vote/poll aggregation, co-op shared tally.
→ **Needs new server contract:** live competitive race, host-spectate, turn-based.

## Category × play-mode matrix (engine-fit; difficulty rises with server contract, never physics)

| Category | Solo | Vote-aggregate (★now) | Co-op tally (★now) | Live race (server) | Turn-based (server) | Host-spectate (server) |
|---|---|---|---|---|---|---|
| Worldcup (이상형 월드컵) | ✅ bracket | ✅ group picks each matchup | – | – | – | ✅ streamer pick |
| Quiz / Trivia | ✅ self-score | ✅ poll answer | – | 🔶 fastest-correct LB | – | 🔶 host show |
| Poll / This-or-That / Balance | ✅ preview | ✅ **core** | – | – | – | – |
| Tier-list | ✅ arrange | ✅ group consensus | – | – | – | – |
| Emoji-slider / Mood | ✅ | ✅ running average | – | – | – | – |
| Clicker | ✅ counter | – | ✅ **shared goal bar** | 🔶 tap-race | – | – |
| Whack-a-mole / Reaction / Timing | ✅ timed | – | ✅ combined hits | 🔶 score LB | 🔶 (눈치게임) | – |
| Memory (Simon) | ✅ | – | – | – | 🔶 relay | – |
| Wheel / Gacha | ✅ | – | – | – | – | 🔶 penalty spin |
| Psych-test / MBTI | ✅ **solo-only** | – | – | – | – | – |

✅ = buildable now · 🔶 = needs the noted server contract · – = weak/NA

## 30 templates (tagged by build phase)
**Phase 1 — buildable NOW (solo / vote / co-op; no server work):**
1. 최애 월드컵 — 1-of-2 아이돌/음식 32강 토너먼트 · worldcup · solo+vote
2. 음식 월드컵 — 야식 토너먼트 · worldcup · vote
3. 이상형 월드컵 — 클래식 이상형 브래킷 · worldcup · solo
4. 밸런스 게임 — 두 딜레마 강제선택 + 그룹 분포 · this-or-that · vote
5. 라면 vs 김밥 티어리스트 — S/A/B/F 탭 배치 · tier-list · solo+vote
6. MBTI 빠른 테스트 — 분기 선택 → 4글자 · psych · **solo-only**
7. 너는 무슨 동물? — 선택트리 → 동물 결과 · psych · solo
8. 반응속도 테스트 — 화면 전환 시 탭, ms 기록 · reaction · solo
9. 두더지 잡기 — 제한시간 탭, 점수 · tap-timing · solo (+co-op 합산)
10. 클릭 노가다 — 탭 카운터 + 업그레이드 · clicker · solo
11. 다같이 1만번 클릭 — 공동 목표 게이지 · clicker · **co-op tally**
12. Simon 따라하기 — 늘어나는 패턴 기억 · memory · solo
13. 색깔 순서 기억 — 색 순서 재현 · memory · solo
14. 감정 슬라이더 — 이모지 드래그, 그룹 평균 · slider · vote
15. 오늘 기분 투표 — 원탭 무드, 라이브 바 · poll · vote
16. 행운의 룰렛 — 탭해서 스핀(타이머 정지) · wheel · solo
17. 뽑기 가챠 — 탭 드로우, 가중 랜덤 등급 · gacha · solo
18. 우리 모임 베스트 투표 — 시상식형 멀티폴 · poll · vote
19. 사다리 타기 — 결과 배정, 경로 공개 · choice+random · solo+vote
20. 초성 퀴즈 — 초성 보고 단어 4지선다 · quiz · solo
21. 우리 중 누가? — 멤버별 프롬프트 투표, 라이브 집계 · poll · vote
22. 야구 응원 떼창 카운터 — 팬 공동 탭 게이지 · co-op · co-op tally
23. 메뉴 정하기 룰렛 — 모임 저녁 룰렛 · wheel · solo+vote
24. 상식 OX 퀴즈 — 자기채점 퀴즈 · quiz · solo

**Phase 2 — needs a new server contract (build after Phase-1 + contract work):**
25. K-pop 트리비아 레이스 — 가장 빨리 맞히기 · quiz · **live race** (per-player score+LB)
26. 상식 퀴즈쇼 — Kahoot식 호스트 트리비아 · quiz · **host-spectate** (roles+code)
27. 빨리 누르기 대결 — 먼저 N탭 · clicker · **live race**
28. 눈치게임 — 숫자 탭, 겹치면 아웃 · reaction · **turn/race** (turn token)
29. 단체 가위바위보 — 동시 선택, 승자 집계 · turn · **race/turn**
30. 복불복 벌칙 룰렛 — 그룹 스핀, 패자 벌칙 · wheel · **host-spectate**

## Don't template (over-rated / weak fit)
- Physics/motion/free-aim/drawing — excluded by engine.
- Auction/Bidding, Trading, Take-That (BGG) — rich state, low snack value.
- "Add Yours" UGC chains — value is the host platform's follower graph; a standalone app can't replicate propagation. Novelty only.

## Build order (recommended)
1. **Vertical-overflow lint** into the live builder (fold in `verify-layout`).
2. **Phase-1 templates (24)** via the generate→verify→repair workflow — no server work.
3. **Server contracts**: (a) co-op shared counter is already `votesByOption` — confirm; (b) per-player score + sorted leaderboard (live race); (c) host/player roles + room code (spectate); (d) turn token (turn-based). PlayDuo's ≤8-player room+invite-link is the proven target shape.
4. **Phase-2 templates (6+)** once contracts land.
5. Rating/ranking + Create-landing gallery + select→prompt (reuses refine path).
