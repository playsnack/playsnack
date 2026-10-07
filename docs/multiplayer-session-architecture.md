# 멀티플레이어 세션 아키텍처 (M1, 2026-06-25)

기존 vote-poll 멀티 6종(balance/this-or-that/best-award/who-most-likely/mood-vote/mood-slider)을 전부 제거하고, "사람들이 정말 좋아하고 많이 찾는" 멀티 게임을 리서치(61후보→8선정)해 **대기실→3·2·1 카운트다운→플레이→결과** 세션 모델로 처음부터 재구축했다.

## 세션 컨트랙트 (서버: `snack-server/src/index.mjs`)
모든 멀티 게임은 한 방에서 **서버 타이밍**으로 동기화된다. 서버가 `sessionPhase`(lobby/countdown/play/result)와 `sessionCountdown`(3·2·1)을 `setVar`로 브로드캐스트 → 클라 레거시 엔진는 `onFrame` 가드(`sessionPhase === 'play'` 등)로 상태 전환. 누구나 대기실에서 `start` 호스트 이벤트로 시작.

`room().session = { phase, round, num, mode, timers, ... }`. `startSession(slug, opts)`가 `opts`로 모드 분기:
- **단일 플레이**(opts.duration): 카운트다운 → play(duration) → result. (tap-war, coop)
- **라운드**(opts.game + 콘텐츠팩): `startRound`가 라운드마다 `roundContent` 브로드캐스트 + 표 리셋, roundMs 후 다음 라운드. (balance, most-likely)
- **퀴즈**(opts.quiz): `startQuizRound`(정답 stripped → 클라 못 봄) → answerMs → `revealQuizRound`(roundAnswer 공개 + 점수). `answer` 이벤트가 정답×속도로 채점. (speed-trivia)
- **반응**(opts.mode="reaction"): 랜덤 딜레이 후 `reactionGo=true` 동기 플립 → `tap`이 reaction-ms 점수(초록 전 탭=부정출발 0점). (reaction-duel)
- **눈치**(opts.mode="nunchi"): `tap`을 350ms 충돌 윈도우로 그룹화 — 단독=선점(nunchiNum++), 2+=전원 탈락. `iAmOut`은 탈락 소켓에만 **타겟 setVar**. (nunchi)
- **브래킷**(opts.bracket + 콘텐츠팩): `startMatchup`/`resolveMatchup`/`finishBracketRound` — 매 매치업 vote, 다수표 진출, 16강→결승, `matchWinner` 2.2s 공개. (worldcup)

## 호스트 이벤트 (client emitHostEvent → WS action)
`start`(duration|{game,rounds,roundMs}|{quiz}|{mode}|{bracket}) · `vote`{option} · `tally`{delta} · `tap` · `answer`{option}. payload는 **정적**(표현식 불가) — 동적 값이 필요한 연타/반응은 서버가 카운트(`tap`은 페이로드 없이 +1/reaction-ms).

## 콘텐츠팩 (`snack-server/data/multi-content/`)
서버 권위 동기화 콘텐츠. `balance.json`(딜레마 a/b) · `most-likely.json`(프롬프트; 후보=roster) · `trivia.json`(q/options/answer) · `worldcup.json`(name/emoji). 라운드/매치업마다 서버가 셔플·브로드캐스트.

## 8종 게임 (전부 oracle + multiclient-sim + 멀티클라 스크린샷 검증)
| id | 컨트랙트/모드 | 핵심 |
|----|------|------|
| tap-war | tap·단일 | 10초 연타 레이스, 이름 막대 |
| coop-tap-goal | tally·단일 | 협동 게이지 채우기 |
| balance-game-vote | vote·라운드 | A/B 딜레마 5라운드 |
| most-likely-roster-vote | vote·라운드(roster) | 방 멤버 지목 |
| speed-trivia-score | score·퀴즈 | 정답숨김+속도점수+공개 |
| reaction-duel-score | score·반응 | 초록불 동기 + 부정출발 |
| nunchi-tap | tap·눈치 | 충돌 판정 + 타겟 탈락 |
| worldcup-group-vote | vote·브래킷 | 16강 그룹투표, emoji 카드(이미지 신뢰성 회피) |

## 검증 인프라
`multiclient-sim`(`tools/multiclient-sim.mjs`)에 세션 커버리지 추가: `kindOf`가 `sessionPhase`→session, sub를 `nunchiNum/reactionGo/roundAnswer/coopTotal/votesByOption`로 세분(tap/tally/vote/quiz/reaction/nunchi). `startPayload(doc)`로 앱의 실제 start 페이로드를 추출해 진짜 모드로 실행. `_wsclient.mjs`에 `start(opts)/tap/answer` 추가. 전 모드 phaseSynced + 수렴 검증.

## 주의
- worldcup은 strict `/api/img`가 일부 음식(부대찌개 등)에서 빈 회색박스 → **emoji 카드로 전환**(항상 렌더, 신뢰성). 이미지 신뢰성보다 "안 깨짐"이 우선(사용자 원칙).
- `iAmOut`(nunchi)은 브로드캐스트가 아니라 **소켓별 타겟 setVar** — sim은 broadcast 변수만 수렴 검사.
