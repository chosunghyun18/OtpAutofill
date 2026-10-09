/**
 * 페어링 단계 판단 — 순수 함수 (Design Spec 5절 T2).
 *
 * 채널 키를 유도한 뒤에도 사용자가 팝업에서 안전번호 "일치함"을 누르기 전까지는 수신하지 않는다.
 * 비교를 선택 사항으로 두면 대부분 건너뛰어 릴레이 MITM 방어가 무력해지기 때문이다.
 * 이전 버전이 저장한 상태(verified 필드 없음)는 미확인으로 본다.
 */
import type { PairState } from "./messages.js";

export type PairPhase = "unpaired" | "waiting-phone" | "needs-verify" | "active";

export function pairPhase(s: PairState, now: number = Date.now()): PairPhase {
  if (s.paired) return s.verified === true ? "active" : "needs-verify";
  if (s.pairingCode && now < (s.pairingExpiresAt ?? 0)) return "waiting-phone";
  return "unpaired";
}

/** 툴바 배지: 안전번호 확인 대기 "?" > 받은 코드 "OTP" > 없음 */
export function badgeText(phase: PairPhase, hasLatest: boolean): string {
  if (phase === "needs-verify") return "?";
  return hasLatest ? "OTP" : "";
}

/**
 * 폰 공개키 고정. 처음 받으면 "pin", 같은 키면 "same", 다른 키면 "mismatch"(릴레이 바꿔치기 의심 → 중단).
 * 브라우저 키를 공개한 뒤 릴레이가 새 폰 키를 고를 수 있으면 안전번호를 맞출 수 있기 때문이다.
 */
export function pinPeerKey(pinned: string | undefined, received: string): "pin" | "same" | "mismatch" {
  if (pinned === undefined) return "pin";
  return pinned === received ? "same" : "mismatch";
}
