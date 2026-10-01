# companion — SMS 소스

브라우저로 보낼 SMS를 **폰에서** 읽어 암호화 후 릴레이에 POST하는 쪽. 현재는 설계 문서만 있다.

## 공통 프로토콜 (폰 쪽 책임)

1. 페어링: 사용자가 크롬 팝업의 페어링 코드(이후 QR)를 입력 → ECDH P-256 키 생성 → `POST /v1/pairings/:code/join {publicKey}`
2. 응답의 `peerPublicKey`로 채널 키 유도 (`packages/protocol/src/crypto.ts`와 동일: HKDF-SHA256, salt=channelId, info=`otp-autofill/v1/aes-gcm`)
3. 화면에 안전번호(XXXX-XXXX) 표시 → 사용자가 크롬 팝업과 비교
4. SMS 수신 시 `OtpPayload{v:1, msgId, text, sender?, receivedAt}` → AES-GCM(AAD=channelId) → `POST /v1/channels/:id/messages`

**보낼 문자 필터**: 모든 SMS를 보내지 않는다. 폰에서 인증 키워드(인증번호/verification code 등)가 있는 문자만 전송한다 — 개인 문자가 기기 밖으로 나가는 범위를 최소화.

## Android (주 경로)

- 권한: `RECEIVE_SMS`는 Play 정책상 기본 SMS 앱 외 사용이 제한됨 → **SMS User Consent API**(`SmsRetriever.startSmsUserConsent`) 우선 검토. 문자마다 사용자 동의 팝업이 뜨지만 권한 심사가 필요 없다.
  - 대안: 알림 접근(NotificationListenerService)으로 메시지 앱 알림 본문 읽기 — 권한은 넓지만 심사 대상 아님. 사이드로드 개인용이면 `RECEIVE_SMS`도 가능.
- 구현 후보: Kotlin + `java.security`/Tink 로 ECDH·HKDF·AES-GCM (WebCrypto와 바이트 호환 테스트 필수), 키는 Android Keystore.
- 전송: WorkManager 단발 작업(네트워크 제약), 실패 시 1회 재시도 후 폐기 (코드는 어차피 3분 뒤 무의미).

## iOS (대안 경로)

iOS 앱은 SMS를 읽을 수 없다. **단축어(Shortcuts) 개인용 자동화**를 쓴다.

- 트리거: "메시지" 자동화 → 메시지 내용에 "인증" / "code" 포함 시 → 즉시 실행(확인 없이) 설정
- 동작: "URL 콘텐츠 가져오기"로 HTTP POST
- **문제: 단축어에는 AES-GCM/ECDH 액션이 없다.** 선택지:
  1. **Scriptable 앱**(JS 실행)에서 WebCrypto 대체 구현으로 암호화 후 POST — E2E 유지, 설치 1개 추가
  2. 단축어 → 사용자 소유 장치(같은 Wi-Fi의 PC 로컬 릴레이)로만 평문 전송 — 외부 릴레이 미경유
  3. 평문 전송 옵트인 — **기본값 금지**, 위협 모델상 릴레이 탈취 시 노출
- Phase 3에서 1번을 우선 검증한다.

## 폰 시뮬레이터 (Phase 1 개발용, 예정)

`scripts/fake-phone.ts`: 페어링 코드로 join → 안전번호 출력 → 표준입력의 문자열을 암호화 전송. `packages/protocol`을 그대로 사용.
