/**
 * OTP 입력칸 탐지 — DOM 의존 없는 순수 로직 (테스트 대상).
 * content.ts가 실제 HTMLInputElement를 InputLike로 변환해 호출한다.
 */

export interface InputLike {
  type: string;
  autocomplete: string;
  name: string;
  id: string;
  className: string;
  placeholder: string;
  ariaLabel: string;
  inputMode: string;
  /** 지정 안 되면 -1 (DOM 기본값과 동일) */
  maxLength: number;
}

export const OTP_SCORE_THRESHOLD = 50;

const OTP_HINT =
  /one[-_ ]?time|otp|verif|auth[-_ ]?code|sms[-_ ]?code|2fa|mfa|totp|passcode|security[-_ ]?code|confirm(?:ation)?[-_ ]?code|인증|확인\s?코드|보안\s?코드/i;
const NOT_OTP =
  /phone|tel\b|mobile|zip|postal|card|cc-|cvc|cvv|birth|email|search|coupon|promo|전화|휴대폰\s?번호|생년|우편|쿠폰/i;
const IGNORED_TYPES = new Set(["hidden", "checkbox", "radio", "submit", "button", "email", "search", "file", "date"]);

function haystack(i: InputLike): string {
  return [i.name, i.id, i.className, i.placeholder, i.ariaLabel].join(" ");
}

/** 단일 입력칸이 OTP 입력칸일 가능성 점수 (0~) */
export function scoreOtpInput(i: InputLike): number {
  if (IGNORED_TYPES.has(i.type.toLowerCase())) return 0;
  const ac = i.autocomplete.toLowerCase();
  if (ac.split(/\s+/).includes("one-time-code")) return 100;

  const text = haystack(i);
  const hinted = OTP_HINT.test(text);
  if (!hinted && NOT_OTP.test(text + " " + ac)) return 0;

  let score = hinted ? 60 : 0;
  if (i.maxLength >= 4 && i.maxLength <= 8) score += 15;
  if (i.inputMode === "numeric" || i.type === "tel" || i.type === "number") score += 10;
  return score;
}

export function isOtpInput(i: InputLike): boolean {
  return scoreOtpInput(i) >= OTP_SCORE_THRESHOLD;
}

export interface SplitCandidate {
  maxLength: number;
  type: string;
  /** 같은 부모 아래인지 판단하는 키 (content.ts에서 부모 노드 식별자로 채움) */
  groupKey: string;
}

/**
 * 한 칸에 한 글자씩 받는 분할 입력칸(예: □□□□□□) 묶음을 찾는다.
 * DOM 순서대로 받은 입력칸 중 같은 groupKey를 가진 maxLength=1 칸이 4~8개 연속이면 한 그룹.
 * 반환: 그룹별 입력칸 인덱스 배열
 */
export function findSplitGroups(inputs: SplitCandidate[]): number[][] {
  const groups: number[][] = [];
  let run: number[] = [];
  const flush = () => {
    if (run.length >= 4 && run.length <= 8) groups.push(run);
    run = [];
  };
  inputs.forEach((inp, idx) => {
    const ok = inp.maxLength === 1 && !IGNORED_TYPES.has(inp.type.toLowerCase());
    const prev = run.length ? inputs[run[run.length - 1]!] : undefined;
    if (ok && (!prev || prev.groupKey === inp.groupKey)) {
      run.push(idx);
    } else {
      flush();
      if (ok) run.push(idx);
    }
  });
  flush();
  return groups;
}

/** 코드를 분할 칸 수에 맞게 나눈다. 길이가 다르면 null (잘못 채우지 않는다) */
export function splitCode(code: string, slots: number): string[] | null {
  return code.length === slots ? code.split("") : null;
}
