# extension (Chrome MV3)

```bash
npm run build:ext   # 루트에서 → extension/dist
npm run watch -w extension
```

| 파일 | 역할 |
|---|---|
| `src/background.ts` | 페어링, 릴레이 long-poll(+30초 alarm으로 재기동), 복호화, 파싱, 코드 보관·정책 판단 |
| `src/content.ts` | OTP 입력칸 탐지 → "인증번호 입력(●●●●●●)" 칩 → 클릭 시 코드 요청·입력 |
| `src/popup.ts` | 최근 코드 표시/복사, 페어링 시작/해제, 안전번호 확인(일치함/다름) |
| `src/detect.ts` | 입력칸 점수화(`autocomplete=one-time-code`, name/id/placeholder 힌트), 분할 입력칸 그룹 탐지 — 순수 |
| `src/origin.ts` | 입력 허용 정책 (origin-bound 일치, https, 만료, 서비스명 불일치 경고) — 순수 |
| `src/pairing.ts` | 페어링 단계(`unpaired`/`waiting-phone`/`needs-verify`/`active`)·배지 — 순수 |
| `src/service.ts` | 문자 속 서비스명(`[네이버]` 등) → 도메인 표 — 순수 |
| `src/keystore.ts` | IndexedDB에 non-extractable CryptoKey 보관 |

## 페어링 흐름

1. 팝업 "폰 페어링 시작" → 공개키 커밋만 릴레이에 등록, 페어링 코드 표시
2. 폰 join → 브라우저가 폰 공개키 수신 → 자기 공개키 공개 → 채널 키 유도
3. 팝업에 안전번호 + [일치함] [다름 · 취소], 배지 `?`. **일치함을 누르기 전에는 릴레이에서 메시지를 가져오지 않는다.**
   다름이면 즉시 해제.

## 입력 흐름

1. 새 코드 도착 → 배지 `OTP` + 활성 탭에 `otp:available` (코드 미포함)
2. content가 입력칸을 찾으면 `otp:query` → background가 `sender.url`로 정책 판단 → 허용이면 자릿수만 응답
3. 사용자가 칩 클릭(`isTrusted`) → `otp:take` → background가 다시 판단 후 코드 전달·즉시 삭제 → 입력
4. 문자에 알려진 서비스명이 있는데 현재 사이트가 그 도메인이 아니면 칩에 주황 테두리 경고 (입력은 허용)

## 알려진 한계
- MV3 서비스 워커가 종료되면 30초 alarm까지 수신이 멈춘다. 다만 사용자가 OTP 입력칸에 포커스하면 content의 조회가 워커를 깨워
  즉시 수신을 재개한다. 실측(2026-10-09, `npm run e2e:latency`): 활성 ≈60ms, 워커 강제 종료 후 포커스 시 ≈130ms, 포커스 없으면 최대 ≈29초.
- 교차 출처 iframe(결제창 등) 내부 입력칸은 `all_frames`로 동작하지만 정책은 iframe의 URL 기준.
