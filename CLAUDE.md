# CLAUDE.md

## 개요
**v2 (2026-10-09~):** 크롬 확장 단독. 사이트 이메일 인증 메일을 Gmail API(`gmail.readonly`, `chrome.identity`)로 찾아
크롬 알림으로 보여 주고, 알림 클릭 시 그 탭 입력칸에 입력한다. 자체 서버 없음, 메일 원문 미저장·미전송.
v1(폰 SMS → 릴레이 → 확장) 코드(`relay/`, `packages/protocol`, `scripts/fake-phone.ts`, `companion/`)는 보류 상태다.
입력칸 탐지·입력·칩·파서·E2E 하네스는 v2에서 재사용한다.
**설계 SSOT는 Obsidian `Projects/work/OtpAutofill/` (`OtpAutofill Design Spec.md`). 코드와 문서가 충돌하면 문서가 우선.**
할 일: 같은 폴더 `task/todo.md`.

## 구조
- `packages/otp-parser` — SMS·이메일 → 코드/인증 링크 추출 (순수 함수)
- `extension/` — MV3 확장 v2. `gmail`/`mailpolicy`/`watch`/`triggers`/`detect`는 순수 로직(테스트 대상), `background`/`content`/`popup`은 얇은 어댑터. 상세는 `extension/README.md`
- `extension/src/v1/`, `extension/public-v1/` — 보류된 v1 진입점 (`dist-v1`)
- v1 전용(보류): `packages/protocol`(E2E 암호화), `relay/`, `companion/`, `scripts/fake-phone.ts`

## 명령
- `npm test` (vitest, 루트에서 전체) / `npm run typecheck` / `npm run build:ext`
- `npm run e2e` — v2: Chromium + e2e 빌드 확장 + 목 Gmail(:8790)로 트리거~알림~클릭 입력 43개 시나리오 (최초 `npx playwright install chromium`)
- `npm run e2e:v1` / `npm run e2e:v1:latency` — 보류된 v1 회귀 (릴레이 :8787)

## 컨벤션
- 문서·주석은 한국어, 식별자는 영어.
- 판단 로직은 순수 함수로 분리하고 테스트를 붙인다. chrome API·DOM 코드는 얇게.
- 보안 불변식(깨면 안 됨):
  - 확장은 사용자 클릭(알림·칩) 없이 입력하지 않는다. 클릭 전 페이지 DOM에 코드를 넣지 않는다.
  - 입력 허용 판단은 content가 아닌 background에서 브라우저가 준 `sender.url`/프레임 기준으로 한다.
  - 발신 인증은 맨 위 mx.google.com `Authentication-Results`의 DMARC 정렬 From만. 위조 헤더 테스트를 깨지 않는다.
  - 감시 세션과 무관한 메일은 알림·본문 조회를 하지 않는다. 메일 원문은 저장·전송하지 않는다.
  - 코드는 `chrome.storage.session`에만, TTL 후·사용 후 삭제. 테스트 훅(`__e2e`)은 e2e 빌드에만 (build.mjs가 검사).
  - (v1) 릴레이는 평문 OTP를 보거나 저장하지 않는다. 페어링 커밋-공개 순서·안전번호 확인 전 수신 금지.
- 새 의존성은 최소화 (확장 런타임 의존성은 `tldts`뿐, 릴레이 런타임 의존성 0 유지).
