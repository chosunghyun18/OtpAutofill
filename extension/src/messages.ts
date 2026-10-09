/** background ↔ content/popup/offscreen 내부 메시지 (v2) */
import type { TriggerReason } from "./watch.js";

export type ExtMessage =
  /** content: 감시 시작·연장. activated = 이 프레임에 사용자 활성화가 있었는지 (없으면 기존 세션 연장만) */
  | { type: "watch:start"; reason: TriggerReason; activated: boolean }
  /** background → content(최상위 프레임): 팝업 "지금 확인" */
  | { type: "watch:ask" }
  /** content: 이 프레임에 입력 가능한 대기 코드가 있는지 (코드는 받지 않음) */
  | { type: "otp:query" }
  /** content: 칩 클릭(isTrusted) 후 코드 요청. background가 sender.url로 다시 판단 */
  | { type: "otp:take" }
  /** background → content: 이 탭의 코드 도착 (코드 미포함) */
  | { type: "otp:available" }
  /** background → 탭의 모든 프레임: 입력칸 있는지 */
  | { type: "fill:probe"; nonce: string }
  /** content → background: probe 회신. 프레임 URL은 background가 sender.url로 얻는다 */
  | { type: "fill:probe-reply"; nonce: string; hasInput: boolean }
  /** background → 한 프레임: 입력. origin이 지금 문서와 다르면 입력하지 않는다 */
  | { type: "fill:code"; code: string; origin: string }
  /** background → 프레임: 칩 표시 (정책 통과 프레임이 여럿일 때) */
  | { type: "chip:show"; length: number }
  // 팝업 전용
  | { type: "popup:state" }
  | { type: "gmail:connect" }
  | { type: "gmail:disconnect" }
  | { type: "watch:now" }
  | { type: "settings:set"; mask: boolean }
  /** background → offscreen */
  | { type: "offscreen:copy"; text: string };

export interface PopupItem {
  id: string;
  kind: "code" | "link";
  value: string;
  site: string;
  authenticated: boolean;
  expiresAt: number;
}

export interface PopupState {
  connected: boolean;
  authError: boolean;
  watching: number;
  mask: boolean;
  items: PopupItem[];
}
