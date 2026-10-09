/** background ↔ content/popup 내부 메시지 */
import type { FillDecision } from "./origin.js";
import type { ServiceHint } from "./service.js";

export interface LatestOtp {
  code: string;
  boundOrigin?: string;
  sender?: string;
  /** 문자에서 찾은 서비스명·도메인 (불일치 경고용) */
  service?: ServiceHint;
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
  /** popup 전용: 안전번호 비교 결과. false면 페어링 해제 */
  | { type: "pair:confirm"; match: boolean; channelId: string; safetyNumber: string }
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
  /** 처음 받은 폰 공개키 — 공개(reveal) 전에 고정해 재시도 때 바꿔치기를 막는다 */
  peerPublicKey?: string;
  safetyNumber?: string;
  /** 채널 키 유도 완료 */
  paired: boolean;
  /** 사용자가 팝업에서 안전번호 일치를 확인함. true일 때만 수신한다 */
  verified?: boolean;
}

/** 코드 유효시간 — 폰 수신 시각 기준 3분 */
export const OTP_TTL_MS = 3 * 60_000;
