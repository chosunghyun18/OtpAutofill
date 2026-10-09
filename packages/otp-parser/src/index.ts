/**
 * SMS 본문에서 일회용 인증번호(OTP)를 추출하는 순수 함수 모음.
 *
 * 원칙
 * - 인증 관련 키워드가 없는 문자는 추출하지 않는다 (오탐보다 미탐이 낫다).
 * - 금액·전화번호·날짜·시각·카드 끝자리처럼 "숫자이지만 코드가 아닌 것"은 후보에서 제외한다.
 * - WebOTP 형식(`@example.com #123456`)의 origin-bound 줄이 있으면 그 값을 최우선으로 쓴다.
 */

export interface OtpResult {
  /** 추출된 인증번호 (숫자 문자열) */
  code: string;
  /** WebOTP origin-bound 줄에서 얻은 도메인. 없으면 undefined */
  origin?: string;
  /** 후보 선택 점수 — 디버깅/임계값 조정용 */
  score: number;
}

const KEYWORDS: RegExp[] = [
  // 한국어
  /인증\s?번호/g,
  /인증\s?코드/g,
  /승인\s?번호/g,
  /확인\s?번호/g,
  /보안\s?(?:번호|코드)/g,
  /본인\s?확인/g,
  /일회용\s?(?:비밀번호|번호|코드)/g,
  /로그인\s?(?:번호|코드)/g,
  // 영어
  /verification\s+code/gi,
  /security\s+code/gi,
  /login\s+code/gi,
  /sign[- ]?in\s+code/gi,
  /one[- ]time\s+(?:pass(?:word|code)|code|pin)/gi,
  /passcode/gi,
  /\bOTP\b/gi,
  /\bPIN\b/gi,
  /\bcode\b/gi,
];

/** 숫자 바로 뒤에 오면 코드가 아닌 단위들 (금액·시간·수량) */
const UNIT_SUFFIX =
  /^\s?(?:원|₩|달러|만|천|억|분|초|시간|시|일|월|년|개|건|회|명|%|won\b|krw\b|usd\b|dollars?\b|min(?:ute)?s?\b|sec(?:ond)?s?\b|hours?\b|days?\b)/i;
/** 숫자 바로 앞에 오면 코드가 아닌 기호/표현 */
const MONEY_PREFIX = /(?:[$₩€£]|USD|KRW)\s?$/i;
/** 숫자 사이 구분자 — 양쪽이 숫자면 전화번호/날짜/시각/천단위 금액으로 본다 */
const NUMERIC_SEPARATORS = new Set(["-", ".", "/", ":", ","]);

const CANDIDATE = /(?<!\d)\d{4,8}(?!\d)/g;
const WEB_OTP_LINE = /^@([a-z0-9.-]+\.[a-z]{2,})\s+#(\d{4,8})(?:\s+@[a-z0-9.-]+)?\s*$/im;

const MAX_KEYWORD_DISTANCE = 40;

interface Span {
  start: number;
  end: number;
}

function findKeywordSpans(text: string): Span[] {
  const spans: Span[] = [];
  for (const re of KEYWORDS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      spans.push({ start: m.index, end: m.index + m[0].length });
    }
  }
  return spans;
}

function isPartOfLargerNumber(text: string, start: number, end: number): boolean {
  const before = text[start - 1];
  const beforeBefore = text[start - 2];
  const after = text[end];
  const afterAfter = text[end + 1];
  if (before && NUMERIC_SEPARATORS.has(before) && beforeBefore && /\d/.test(beforeBefore)) return true;
  if (after && NUMERIC_SEPARATORS.has(after) && afterAfter && /\d/.test(afterAfter)) return true;
  return false;
}

function isAmountOrQuantity(text: string, start: number, end: number): boolean {
  if (UNIT_SUFFIX.test(text.slice(end, end + 10))) return true;
  if (MONEY_PREFIX.test(text.slice(Math.max(0, start - 5), start))) return true;
  return false;
}

/** 카드 끝자리 등 괄호로 감싼 4자리 — "신한카드(1234)" */
function isCardSuffix(text: string, start: number, end: number): boolean {
  return end - start === 4 && text[start - 1] === "(" && text[end] === ")" && /[가-힣a-z]/i.test(text[start - 2] ?? "");
}

function isBracketed(text: string, start: number, end: number): boolean {
  const open = text[start - 1];
  const close = text[end];
  return (
    (open === "[" && close === "]") ||
    (open === "(" && close === ")") ||
    (open === "【" && close === "】") ||
    (open === "<" && close === ">") ||
    (open === "'" && close === "'") ||
    (open === '"' && close === '"')
  );
}

function distanceToNearestKeyword(spans: Span[], start: number, end: number): number {
  let best = Infinity;
  for (const s of spans) {
    const d = s.end <= start ? start - s.end : end <= s.start ? s.start - end : 0;
    if (d < best) best = d;
  }
  return best;
}

/** origin-bound 줄(WebOTP 표준 형식)을 우선 확인한다. */
export function parseOriginBound(text: string): { origin: string; code: string } | null {
  const m = WEB_OTP_LINE.exec(text);
  if (!m || !m[1] || !m[2]) return null;
  return { origin: m[1].toLowerCase(), code: m[2] };
}

/**
 * SMS 본문에서 인증번호를 추출한다. 확신할 수 없으면 null.
 */
export function parseOtp(text: string): OtpResult | null {
  if (!text) return null;

  const bound = parseOriginBound(text);
  if (bound) return { code: bound.code, origin: bound.origin, score: 1000 };

  const spans = findKeywordSpans(text);
  if (spans.length === 0) return null;

  let best: OtpResult | null = null;
  for (const m of text.matchAll(CANDIDATE)) {
    const start = m.index;
    const end = start + m[0].length;
    if (isPartOfLargerNumber(text, start, end)) continue;
    if (isAmountOrQuantity(text, start, end)) continue;
    if (isCardSuffix(text, start, end)) continue;

    const distance = distanceToNearestKeyword(spans, start, end);
    if (distance > MAX_KEYWORD_DISTANCE) continue;

    let score = 100 - distance;
    if (isBracketed(text, start, end)) score += 20;
    if (m[0].length === 6) score += 10;
    if (/^(19|20)\d{2}$/.test(m[0])) score -= 30; // 연도로 보이는 4자리

    if (!best || score > best.score) best = { code: m[0], score };
  }
  return best;
}

export { decodeEntities, findEmailCode, findVerifyLink, htmlToText, parseEmail, trimSnippet, type EmailInput, type EmailOtp } from "./email.js";
