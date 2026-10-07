# 반응속도 대결 `race-reaction`  ·  game

**Verdict:** needs-fix  ·  **Mode:** single

## 주제 매력도
반응속도(reflex) 게임은 "1초도 안 걸리는 즉석 한 판 + 숫자로 나오는 내 실력"이라는 점에서 스낵 소비에 완벽하다. 누구나 룰 설명 없이 0.2초 만에 이해하고, "내 반응속도 몇 ms?"는 SNS에서 자랑·비교 욕구를 자극하는 검증된 바이럴 소재다(Human Benchmark, "초록 되면 탭" 류가 수년간 인기). 한국 맥락에서도 "반응속도 테스트 짤"은 단톡방에서 서로 돌려보며 경쟁하는 친숙한 포맷. 주제 변경 불필요 — 다만 제목의 '대결'이 본질(혼자 reflex 측정)보다 멀티를 암시하니, 콘텐츠 카피는 "내 반응속도 측정 + 전체 랭킹에 올리기"로 명확히 하는 게 좋다.

## 레퍼런스 (검증된 인기 포맷 모방)
- **모방 대상:** Human Benchmark - Reaction Time Test (휴먼벤치마크 반응속도 테스트)
- **구조 100% 복제:** 검증된 reflex-test 표준 룰을 100% 모방: (1) 대기 화면, (2) 시작 후 무작위 지연 동안 '아직 누르지 마' 상태(빨강/어두움), (3) 신호가 켜지는 순간(초록) 가장 빠르게 탭, (4) 신호 전에 누르면 실격/0점(too soon), (5) 반응시간 ms를 즉시 표시하고 기록. 이 5단계 상태머신이 reflex 장르의 정답 구조이고 본 앱이 정확히 따르고 있다(ready→wait→go→result).
- **우리 콘텐츠/디자인:** 콘텐츠: 한국어 카피('기다렸다가 탭!', '대기 중…', 'TAP!', '실격')와 점수 환산(1000-반응ms = 점수), 라이브 리더보드(TOP10). 디자인: 블랙(#0b0c0e) 배경 + 라임(#d9ff00) 액센트 톤으로, go 상태에서만 전면 라임으로 전환해 '지금!' 신호를 시각적으로 강렬하게 — Human Benchmark의 빨강→초록을 우리 톤의 어둠→라임으로 번역.

## 목적
초록(라임)으로 바뀌는 순간을 가장 빠르게 탭해 내 반응속도(ms)를 재는 1초 스낵 게임. "내 반응속도 몇이지?"라는 즉각적 궁금증을 풀어주고, 빠를수록 높은 점수와 전체 랭킹 진입이라는 자랑거리를 준다. 한 판이 3초 안에 끝나고 바로 다시 도전 가능한 데드타임 0 경험.

## 핵심 루프
시작 → (무작위 지연 동안 대기) → 라임으로 바뀌는 순간 탭 → 반응시간 ms와 점수가 즉시 뜨고 리더보드에 올라감 → 다시 도전.

## 시나리오
1. 사용자가 앱을 연다 → ready 화면: 제목 '반응속도 대결', 안내 카드, '시작' 버튼 표시
2. '시작' 탭 → 점수·반응시간 0으로 초기화, 무작위 목표시각(1.2~3.4초 뒤) 설정, wait 화면으로 전환('아직 누르지 마세요')
3. 사용자가 초록 신호를 기다림 → onFrame이 매 프레임 $now>=targetAt 체크, 도달 시 자동으로 go 화면(전면 라임 'TAP!')으로 전환하며 측정 시작
4. [성급한 경우] wait 화면에서 미리 탭 → reactionMs=-1, 점수 0, result로 이동해 '실격' 표시
5. go 화면에서 사용자가 라임 패드를 탭 → reactionMs=현재-시작 시각 계산, 점수=max(0,1000-ms), emitHostEvent('score')로 서버 제출, result로 전환
6. [미반응] 3초 안에 안 누르면 onFrame이 duration 초과 감지 → 0점 제출 후 result로 전환
7. result 화면: 내 점수·반응시간 카드 + 라이브 리더보드(TOP10) 표시, 기록 없으면 빈 안내
8. '다시 도전' 탭 → ready로 복귀, 무한 반복

## 성공 기준
- go 신호(라임 전환)가 wait→go 사이에 시각적으로 명확히 구분되어 '지금 탭'을 0.1초 안에 인지시킨다
- 탭한 순간 반응시간 ms가 거짓 없이 실제 경과시간으로 계산·표시된다(타이머 진실성)
- 성급한 탭=실격, 미반응=0점 등 reflex 표준 룰의 엣지케이스가 모두 정직하게 처리된다
- 네 화면(ready/wait/go/result) 모두 텍스트가 겹치지 않고 390x844 안에 들어오며 컨테이너 collapse가 없다
- 한 판이 끊김 없이 ready→…→result→ready로 즉시 순환해 데드타임이 없다
- 리더보드가 실제 서버 제출 기록을 반영하거나, 기록이 없을 때 빈 상태를 깔끔히 보여준다

## QA 검증 시나리오
- [ ] **QA1** ready의 '시작' 버튼(startBtn) 탭 시 wait 화면으로 전환되는가 → `readyScreen 숨김, waitScreen 표시, targetAt이 $now+1200~3400 범위로 설정됨`
- [ ] **QA2** wait 상태에서 targetAt 도달 시 go 화면으로 자동 전환되는가 → `onFrame이 $now>=targetAt 감지 후 자동으로 goScreen(라임) 표시, 사용자 입력 없이 전환`
- [ ] **QA3** go 화면의 라임 패드(goPad)를 탭하면 반응시간이 실제 경과 ms로 측정되는가 → `reactionMs = Math.round($now-startedAt), 점수 = max(0,1000-ms), result로 전환`
- [ ] **QA4** go 화면 goTimer가 라임 진입 후 실시간으로 ms 증가를 보여주는가 → `goTimer.content가 매 프레임 갱신되어 0ms부터 증가하는 숫자 표시`
- [ ] **QA5** wait 화면에서 성급히 탭(waitPad 클릭) 시 실격 처리되는가 → `reactionMs=-1, 점수 0, result에서 반응시간 카드에 '실격' 표시`
- [ ] **QA6** 3초 안에 탭 안 하면 자동 0점 제출되는가 → `go의 onFrame이 $now-startedAt>=duration(3000) 감지, reactionMs=3000·점수0으로 result 전환`
- [ ] **QA7** result의 점수/반응시간 카드 값이 실제 측정값으로 바인딩되는가 → `scoreCard.value=`${score}점`, reactionCard.value가 실격/ms 분기로 정확히 표시`
- [ ] **QA8** 리더보드가 서버 제출(emitHostEvent 'score')을 반영하거나 빈 상태를 보여주는가 → `leaderboard 배열이 채워지면 repeat로 순위 목록, 비면 emptyRankHint만 표시`
- [ ] **QA9** go 화면의 goText/goSub/goTimer 텍스트 자식이 goPad 탭을 가로채지 않는가 → `패드 어디를 탭해도 click 트리거 발화(텍스트에 pointerEvents:none 필요)`
- [ ] **QA10** 네 화면 모두 텍스트 겹침·화면 밖 이탈·컨테이너 0높이 collapse가 없는가 → `ready/wait/result 스크린샷에서 확인됨, go도 동일 패턴으로 정상`
- [ ] **QA11** '다시 도전'(againBtn) 탭 시 ready로 복귀해 재플레이 가능한가 → `resultScreen 숨김, readyScreen 표시, 무한 반복 가능`

## 현재 깨짐 (진단)
- **[high]** go(라임 'TAP!') 화면의 텍스트 자식 goText/goSub/goTimer에 pointerEvents:'none'이 없다. Button/GhostButton 등 다른 컴포넌트의 라벨은 모두 pointerEvents:'none'을 명시한 반면(예: line 845, 884), goPad의 자식 텍스트 3개(line 339-365)는 누락. 반응속도 게임은 '화면 아무 데나 가장 빠르게 탭'이 핵심인데, 사용자가 큰 'TAP!' 글자(fontSize 58) 위를 탭하면 click이 텍스트에 흡수돼 goPad 트리거가 발화하지 않을 수 있다 — reflex 게임의 가장 치명적인 탭 누락.
  - 근거: line 339-365 goText/goSub/goTimer에 pointerEvents 미지정 vs line 845 Button lbl의 'pointerEvents':'none'
  - 수정: goText·goSub·goTimer 각각에 'pointerEvents':'none' 추가. 동일하게 readyOrb/waitCircle 등 탭 영역을 덮는 자식도 점검.
- **[medium]** '대결'이라는 제목과 '실시간 랭킹/라이브 리더보드' 카피가 멀티(함께 겨루기)를 강하게 암시하지만, 실제 메커닉은 완전한 single — 각자 혼자 측정하고 점수만 공유 리더보드에 비동기 제출되는 spectate/async 구조다. 게임 로직은 single이 맞고 잘 만들어졌으나, 카피가 '함께 동시 대결'을 약속하면 소비자 기대와 어긋난다.
  - 근거: emitHostEvent 'score'(line 624,686,718)는 점수만 비동기 제출, 동시 라운드/상대 동기화 메커닉 없음. 제목 '반응속도 대결' + chipLive '실시간 랭킹'(line 166)
  - 수정: single 본질을 인정하고 카피를 '내 반응속도 측정 + 전체 랭킹 도전'으로 명확화하거나, 리더보드를 실제로 보여줄 수 있게 서버 leaderboard 피드를 보장. 동시 대결을 원하면 별도 멀티 버전으로(아래 multiVariantIdea).
- **[medium]** 라이브 리더보드가 항상 빈 상태로 보일 위험. leaderboard 변수는 initial:[]이고 서버가 setVar로 채워야 채워지는데(스크린샷3에서 '아직 도착한 기록이 없어요'만 표시), 제출은 emitHostEvent로 보내지만 서버→leaderboard 동기화 와이어링이 구조 파일만으로는 확인 불가. 와이어링이 없으면 '실시간 랭킹'이 영구 빈 상태가 되어 핵심 자랑 기능이 죽는다.
  - 근거: line 39-43 leaderboard initial:[], line 483-526 repeat varId:leaderboard, 스크린샷3은 빈 상태. 서버측 score→leaderboard 반영 로직은 .문서에 없음
  - 수정: 서버가 score 이벤트 수신 시 leaderboard(TOP10 정렬)를 setVar로 전체 브로드캐스트하는지 검증. 미구현이면 서버 핸들러 추가, 또는 내 직전 기록만이라도 즉시 1행 추가해 빈 화면을 피한다.

## 멀티 변형 아이디어 (별도 앱)
멀티 버전이면 매우 재밌다 — live-race 메커닉: 같은 방의 N명이 동시에 한 라운드를 공유하고, 호스트가 무작위 시점에 전원 화면을 동시에 라임으로 전환(서버 setVar로 goAt 동기화), 각자 탭한 ms를 실시간 수집해 '1등 0.21초!' 식으로 즉시 순위 발표. 고도화: 먼저 누른 사람 화면에 'WIN' 폭죽, 성급한 탭은 그 라운드 실격으로 빨갛게, 라운드를 3판 best-of로 누적해 방 챔피언 결정. vote가 아닌 동시-반응 경쟁이라 '대결' 제목에 진짜로 부합.
