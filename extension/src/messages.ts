/** background ↔ content/popup 내부 메시지 */
import type { FillDecision } from "./origin.js";

export interface LatestOtp {
  code: string;
  boundOrigin?: string;
  sender?: string;
  receivedAt: number;
  expiresAt: number;
}

export type ExtMessage =
  /** content: 이 프레임에 입력 가능한지만 묻는다 (코드는 받지 않음) */
  | { type: "otp:query" }
  /** content: 사용자 클릭 후 실제 코드 요청. 성공 시 background가 코드를 소진 처리 */
  | { type: "otp:take" }
  /** popup 전용: 최근 코드 표시/복사 */
  | { type: "otp:peek" }
  /** background → content: 새 코드 도착 알림 (코드 미포함) */
  | { type: "otp:available" }
  | { type: "pair:start"; relayUrl: string }
  | { type: "pair:status" }
  | { type: "pair:revoke" };

export interface QueryResponse {
  decision: FillDecision | null;
  length?: number;
}

export interface PairState {
  relayUrl?: string;
  channelId?: string;
  browserToken?: string;
  pairingCode?: string;
  pairingExpiresAt?: number;
  safetyNumber?: string;
  paired: boolean;
}

/** 코드 유효시간 — 폰 수신 시각 기준 3분 */
export const OTP_TTL_MS = 3 * 60_000;
