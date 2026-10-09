# OtpAutofill

> **2026-10-09 기획 변경 (v2).** 목표는 **크롬 확장 하나로 이메일 인증을 처리하는 것**이다.
> 흐름: 사이트 회원가입 → 이메일 인증 → 확장이 Gmail에서 인증 메일을 찾아 크롬 알림 → 클릭하면 입력칸에 자동 입력.
> 폰·릴레이 서버는 필요 없다. 아래 내용은 보류된 v1(폰 SMS 경로) 구현 설명이다.
> 설계 기준: Obsidian `Projects/work/OtpAutofill/OtpAutofill Design Spec.md` (v2).

휴대폰으로 받은 **문자 인증번호를 크롬 브라우저에서 클릭 한 번으로 입력**하는 도구.
iOS/Android가 키보드 위에 인증번호를 띄워주는 기능을 데스크톱 크롬으로 가져온다.

```
[폰: SMS 수신] ──암호문──▶ [relay: 중계만, 평문 모름] ──암호문──▶ [크롬 확장: 복호화·파싱·입력 칩]
  companion/                    relay/                              extension/
  (Android 앱 / iOS 단축어)      (메모리 전용, TTL)                   (MV3 service worker + content script)
```

- **종단간 암호화**: ECDH P-256 → HKDF → AES-GCM. 키는 양 끝 기기에만 있고 릴레이는 암호문만 본다.
- **피싱 방어**: 자동 입력하지 않는다. 입력칸 옆 칩을 사용자가 클릭해야 입력되며, 문자에
  WebOTP 형식(`@example.com #123456`) 도메인이 있으면 그 사이트에서만 입력된다.
- **짧은 수명**: 코드는 수신 후 3분, 릴레이 메시지는 2분, 페어링 코드는 5분. 1회 사용 후 삭제.

설계 SSOT: Obsidian `Projects/work/OtpAutofill/OtpAutofill Design Spec.md`
동작 방식(설치·흐름·상태 머신·검증): 같은 폴더 `OtpAutofill 동작 방식.md`

**크롬 확장 프로그램(MV3)으로만 동작하며, 사용자가 평소 쓰는 크롬에 설치해야 한다.**

## 구조

```
OtpAutofill/
├── packages/
│   ├── otp-parser/     # SMS 본문 → 인증번호 추출 (순수 함수, 한/영, 금액·전화번호·날짜 제외)
│   └── protocol/       # 메시지 타입 + E2E 암호화(WebCrypto) + safety number
├── relay/              # Node/TS HTTP 릴레이 (런타임 의존성 0, 메모리 전용)
│   └── src/            #   store.ts(상태·TTL) / server.ts(HTTP·long-poll) / main.ts
├── extension/          # Chrome MV3 확장 (esbuild 번들 → dist/)
│   ├── public/         #   manifest.json, popup.html
│   └── src/            #   background / content / popup / detect(입력칸 탐지) / origin(입력 정책)
└── companion/          # SMS 소스 설계 문서 (Android 앱, iOS 단축어) — 코드 없음
```

## 실행 방법

```bash
npm install
npm test             # 전체 단위·통합 테스트 (vitest)
npm run typecheck    # tsc --noEmit

npm run relay        # 릴레이 :8787 (PORT 환경변수로 변경)
npm run build:ext    # extension/dist 생성
npm run fake-phone -- <페어링코드>   # 폰 시뮬레이터 (companion/README.md)
npm run e2e          # 브라우저 E2E (Chromium + 확장 + 릴레이 + fake-phone). 최초 `npx playwright install chromium`
```

확장 로드: `chrome://extensions` → 개발자 모드 → "압축해제된 확장 프로그램을 로드" → `extension/dist`.
팝업에서 "폰 페어링 시작" → 표시된 페어링 코드를 폰(companion)에 입력 → 양쪽 **안전번호(XXXX-XXXX)** 비교 →
팝업에서 [일치함]을 눌러야 수신이 시작된다.

폰 앱이 아직 없으므로 Phase 1에서는 `npm run fake-phone`(scripts/fake-phone.ts)으로 폰 역할을 흉내 낸다.

### 릴레이 기술 선택: Node/TypeScript

- 파서·암호화 코드를 **확장과 릴레이 테스트가 같은 TS 패키지로 공유**한다 (Python이면 이중 구현).
- WebCrypto가 Node 20에 내장 → 브라우저와 동일한 API로 E2E 통합 테스트 가능.
- 릴레이 로직이 작아(라우트 6개) 프레임워크 없이 `node:http`로 충분 — 런타임 의존성 0.

## 보안 요약 (상세는 Design Spec 5절)

| 위협 | 대응 |
|---|---|
| 릴레이 탈취/운영자 열람 | 암호문만 경유, 영속화 없음, 토큰은 해시로만 보관 |
| 페어링 중 릴레이 MITM | 공개키 커밋-공개, 안전번호 확인 버튼 강제, 페어링 코드 1회용·5분 |
| 페어링 코드 브루트포스 | IP(IPv6 /64)당 분당 10회, 동시 페어링 상한 |
| 피싱 사이트에 코드 입력 | 자동 입력 없음·클릭 필수, origin-bound 도메인 불일치 시 차단, 서비스명 불일치 경고, https 전용, 클릭 전 코드 미노출 |
| 페이지 스크립트의 합성 클릭 | `isTrusted` 검사, closed shadow DOM 칩 |
| 재전송/오래된 메시지 | msgId 중복 거부, 수신 5분 초과 거부, AAD=channelId |
| 확장 내 코드 잔존 | `chrome.storage.session`(메모리), 3분 만료, 입력 후 즉시 삭제 |

## 로드맵

| Phase | 내용 | 완료 기준 |
|---|---|---|
| **0** | 스캐폴드 + 핵심 순수 로직 | 파서·암호화·릴레이·입력칸 탐지 테스트 통과 |
| **1** | 데스크톱 E2E 데모 | 폰 시뮬레이터 스크립트 → 릴레이 → 확장 칩 → 실제 로그인 페이지 입력 ← 현재 |
| **2** | Android companion MVP | 실기기 SMS 수신 → 5초 내 크롬 칩 표시, 페어링 QR |
| **3** | iOS 경로 + 파서 고도화 | 단축어 자동화 경로 문서화·검증, 실제 SMS 샘플 100건 정확도 ≥ 95% |
| **4** | 배포 | 릴레이 호스팅(저비용), Chrome Web Store 비공개 배포, 개인정보처리방침 |
