# extension (Chrome MV3)

```bash
npm run build:ext                  # 루트에서 → extension/dist (실사용)
npm run build:e2e -w extension     # → dist-e2e (목 Gmail :8790, 고정 토큰, 테스트 훅 __e2e, 폴링 300ms)
npm run build:v1 -w extension      # → dist-v1 (보류된 v1 SMS 경로)
npm run watch -w extension
```

| 파일 | 역할 |
|---|---|
| `src/background.ts` | 토큰, 감시 세션·폴링 루프, 메일 처리, 알림, 클릭 시 프레임 probe → 입력 지시, offscreen 복사, 팝업 응답 |
| `src/content.ts` | 트리거 감지(이메일 폼 제출·버튼, 입력칸 등장, "인증 메일 발송" 문구, 입력칸 포커스), probe 회신, 입력, 칩 |
| `src/popup.ts` | Gmail 연결·해제, 최근 항목·복사, 지금 확인, 알림 꺼짐 안내, 코드 마스킹 옵션 |
| `src/offscreen.ts` | 클립보드 복사 (서비스 워커엔 clipboard 없음) |
| `src/gmail.ts` | Gmail REST(getProfile·history·messages) + base64url·charset·RFC 2047 디코딩 — 순수 부분 테스트 |
| `src/mailpolicy.ts` | Authentication-Results 해석, DMARC 정렬 From, eTLD+1(tldts), 입력/열기/복사 판단 — 순수 |
| `src/watch.ts` | 탭별 세션, 메일↔세션 매칭, 아이템 TTL, 알림 문구·버튼, 입력 프레임 선택 — 순수 |
| `src/triggers.ts` | 이메일 입력칸·인증 문구 판단, 트리거 쿨다운 — 순수 |
| `src/detect.ts` `dom.ts` `fill.ts` `chip.ts` | 입력칸 탐지(순수)·DOM 헬퍼·React 대응 입력·칩 |
| `src/v1/` | 보류된 v1 진입점과 순수 로직 (페어링·릴레이 수신) |

## 흐름

1. content 트리거 → `watch:start {reason, activated}` → background가 `sender.tab.id`·`sender.url`로 탭별 세션(10분).
   사용자 활성화가 없는 트리거는 기존 세션 연장만 한다.
2. 세션 시작 때 `getProfile`의 historyId를 저장하고, 최근 메일 5개 중 2분 안에 온 것도 1회 확인(늦은 트리거 대비).
3. 폴링: `history.list(messageAdded)` → 새 메일 metadata(From·Subject·Authentication-Results·snippet) →
   From 사이트가 세션과 맞을 때만 파싱(제목·snippet → 실패 시 full 본문). 맞지 않으면 버린다.
4. 알림(본문 클릭 = 기본). 클릭 → 탭·창 앞으로 → `fill:probe`를 모든 프레임에 → 회신의 `sender.url/frameId/documentId`로
   `planFill` → 통과 프레임이 하나면 그 문서에만 `fill:code` (content는 origin이 같을 때만 입력), 여럿이면 칩, 없으면 복사(+경고).
5. 사용하면 아이템·알림·세션 삭제. 30초 alarm이 TTL 정리와 워커 재기동을 맡는다.

## 알려진 한계
- 헤드리스 E2E는 OS 알림을 누를 수 없어 e2e 훅으로 같은 핸들러를 부른다. 실제 크롬 알림 클릭·macOS 배너 동작은 사람이 확인해야 한다(P2).
- `oauth2.client_id`는 자리표시자다. 실제 Gmail 연결은 P2(OAuth 클라이언트 발급) 이후.
- 코드는 숫자 4~8자리만, 발신 도메인 ≠ 사이트 도메인인 서비스(Cognito·Firebase 등)는 복사만 된다(P3 정적 별칭 표).
