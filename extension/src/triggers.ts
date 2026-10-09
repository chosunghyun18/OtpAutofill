/**
 * 감시 트리거 판단 — DOM 없는 순수 로직 (Design Spec v2 §3 감시 트리거).
 * content.ts가 DOM에서 값을 뽑아 호출한다.
 */

export interface FieldLike {
  type: string;
  name: string;
  id: string;
  autocomplete: string;
  placeholder: string;
}

const EMAIL_HINT = /e-?mail|이메일|메일\s?주소/i;

/** 이메일 입력칸 여부 */
export function isEmailField(f: FieldLike): boolean {
  if (f.type.toLowerCase() === "email") return true;
  if (f.autocomplete.toLowerCase().split(/\s+/).includes("email")) return true;
  if (["hidden", "password", "checkbox", "radio", "submit", "button"].includes(f.type.toLowerCase())) return false;
  return EMAIL_HINT.test(`${f.name} ${f.id} ${f.placeholder}`);
}

/** "인증 메일을 보냈습니다 / verify your email" 류 문구 */
const SENT_TEXT: RegExp[] = [
  /인증\s?(?:메일|이메일|번호|코드|링크)[^.\n]{0,30}(?:발송|보냈|보내\s?드렸|전송|발급)/,
  /(?:메일|이메일)(?:로|으로)?[^.\n]{0,30}(?:발송|보냈|보내\s?드렸|전송)[^.\n]{0,30}(?:인증|확인)/,
  /(?:메일|이메일)[^.\n]{0,20}(?:확인|인증)해\s?주세요/,
  /verify\s+your\s+(?:e-?mail|account)/i,
  /confirm\s+your\s+(?:e-?mail|account)/i,
  /check\s+your\s+(?:e-?mail|inbox)/i,
  /(?:we(?:'ve|\s+have)?\s+(?:just\s+)?sent|sent\s+you)[^.\n]{0,60}(?:code|link|e-?mail)/i,
  /(?:verification|confirmation)\s+(?:code|e-?mail|link)\s+(?:has\s+been\s+|was\s+)?sent/i,
];

export function hasVerifySentText(text: string): boolean {
  return SENT_TEXT.some((re) => re.test(text));
}

/** 같은 이유의 트리거를 너무 자주 보내지 않는다 (background가 연장만 하므로 30초면 충분) */
export const TRIGGER_COOLDOWN_MS = 30_000;

export function shouldSend(last: Partial<Record<string, number>>, reason: string, now: number): boolean {
  const t = last[reason];
  return t === undefined || now - t >= TRIGGER_COOLDOWN_MS;
}
