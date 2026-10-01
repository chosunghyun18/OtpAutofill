# extension (Chrome MV3)

```bash
npm run build:ext   # 루트에서 → extension/dist
npm run watch -w extension
```

| 파일 | 역할 |
|---|---|
| `src/background.ts` | 페어링, 릴레이 long-poll(+30초 alarm으로 재기동), 복호화, 파싱, 코드 보관·정책 판단 |
| `src/content.ts` | OTP 입력칸 탐지 → "인증번호 입력(●●●●●●)" 칩 → 클릭 시 코드 요청·입력 |
| `src/popup.ts` | 최근 코드 표시/복사, 페어링 시작/해제, 안전번호 표시 |
| `src/detect.ts` | 입력칸 점수화(`autocomplete=one-time-code`, name/id/placeholder 힌트), 분할 입력칸 그룹 탐지 — 순수 |
| `src/origin.ts` | 입력 허용 정책 (origin-bound 일치, https, 만료) — 순수 |
| `src/keystore.ts` | IndexedDB에 non-extractable CryptoKey 보관 |

## 입력 흐름

1. 새 코드 도착 → 배지 `OTP` + 활성 탭에 `otp:available` (코드 미포함)
2. content가 입력칸을 찾으면 `otp:query` → background가 `sender.url`로 정책 판단 → 허용이면 자릿수만 응답
3. 사용자가 칩 클릭(`isTrusted`) → `otp:take` → background가 다시 판단 후 코드 전달·즉시 삭제 → 입력

## 알려진 한계
- MV3 서비스 워커는 유휴 시 종료됨 → alarm 주기(30초)만큼 수신 지연 가능. Phase 1에서 실측 후 WebSocket(Chrome 116+ keepalive) 전환 검토.
- 교차 출처 iframe(결제창 등) 내부 입력칸은 `all_frames`로 동작하지만 정책은 iframe의 URL 기준.
