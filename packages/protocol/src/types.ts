/**
 * 폰 ↔ 릴레이 ↔ 브라우저 사이의 메시지 타입.
 * 릴레이는 `Envelope`(암호문)만 보며, `OtpPayload`(평문)는 양 끝 기기에서만 존재한다.
 */

/** 암호화 전 평문 — 폰에서 만들고 브라우저에서만 복호화된다. */
export interface OtpPayload {
  v: 1;
  /** 재전송 방지용 랜덤 ID */
  msgId: string;
  /** SMS 원문. 파싱은 브라우저(otp-parser)에서 한다 — iOS 단축어처럼 파서를 못 돌리는 소스 대응 */
  text: string;
  /** 발신자 표시(선택). 번호 대신 표시명만 보내는 것을 권장 */
  sender?: string;
  /** SMS 수신 시각 (epoch ms) */
  receivedAt: number;
}

/** 릴레이를 통과하는 암호문 봉투 */
export interface Envelope {
  v: 1;
  /** AES-GCM IV (base64url, 12 bytes) */
  iv: string;
  /** AES-GCM 암호문 + 태그 (base64url) */
  ct: string;
}

export const PAYLOAD_MAX_AGE_MS = 5 * 60 * 1000;
export const ENVELOPE_MAX_BYTES = 4096;
