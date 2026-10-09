# CLAUDE.md

## 개요
**v2 (2026-10-09~):** 크롬 확장 단독. 사이트 이메일 인증 메일을 Gmail API(`gmail.readonly`, `chrome.identity`)로 찾아
크롬 알림으로 보여 주고, 알림 클릭 시 그 탭 입력칸에 입력한다. 자체 서버 없음, 메일 원문 미저장·미전송.
v1(폰 SMS → 릴레이 → 확장) 코드(`relay/`, `packages/protocol`, `scripts/fake-phone.ts`, `companion/`)는 보류 상태다.
입력칸 탐지·입력·칩·파서·E2E 하네스는 v2에서 재사용한다.
**설계 SSOT는 Obsidian `Projects/work/OtpAutofill/` (`OtpAutofill Design Spec.md`). 코드와 문서가 충돌하면 문서가 우선.**
할 일: 같은 폴더 `task/todo.md`.

## 구조
- `packages/otp-parser` — SMS → 코드 추출 (순수 함수)
- `packages/protocol` — 메시지 타입, E2E 암호화(WebCrypto), safety number
- `relay/` — Node `node:http` 릴레이, 메모리 전용
- `extension/` — MV3 확장. `detect.ts`/`origin.ts`는 DOM 없는 순수 로직(테스트 대상), `content.ts`/`background.ts`는 얇은 어댑터
- `companion/` — SMS 소스 설계 문서 (코드 없음)
- `scripts/fake-phone.ts` — 폰 시뮬레이터 (Phase 1 개발용, `npm run fake-phone -- <코드>`)

## 명령
- `npm test` (vitest, 루트에서 전체) / `npm run typecheck` / `npm run relay` / `npm run build:ext`
- `npm run e2e` — 실제 Chromium에 확장을 올려 페어링~입력 30개 시나리오 검증 (최초 `npx playwright install chromium`). `npm run e2e:latency` — 수신 지연 실측

## 컨벤션
- 문서·주석은 한국어, 식별자는 영어.
- 판단 로직은 순수 함수로 분리하고 테스트를 붙인다. chrome API·DOM 코드는 얇게.
- 보안 불변식(깨면 안 됨):
  - 릴레이는 평문 OTP를 절대 보거나 저장하지 않는다. 로그에 본문·토큰 금지.
  - 확장은 사용자 클릭 없이 입력하지 않는다. 클릭 전 페이지 DOM에 코드를 넣지 않는다.
  - 입력 허용 판단은 content가 아닌 background에서 `sender.url` 기준으로 한다.
  - 코드는 `chrome.storage.session`에만, TTL 후·사용 후 삭제.
  - 페어링은 커밋-공개 순서를 지킨다 (브라우저 공개키는 폰 공개키를 받은 뒤에만 공개). 안전번호 확인 전에는 메시지를 가져오지 않는다.
- 새 의존성은 최소화 (릴레이 런타임 의존성 0 유지).
