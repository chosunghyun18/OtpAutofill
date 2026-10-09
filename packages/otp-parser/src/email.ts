/**
 * 인증 메일(제목 + 본문)에서 인증번호 또는 인증 링크를 뽑는 순수 함수 (Design Spec v2 §3 이메일 파서).
 *
 * 순서: 제목 → 본문 텍스트 코드(SMS 파서 재사용) → 단독 줄 코드(제목·본문에 인증 문구가 있을 때) → 인증 링크.
 * 코드는 숫자 4~8자리만 본다(MVP, 오탐 0 원칙). 서비스 워커에는 DOMParser가 없어 HTML은 정규식으로 다룬다.
 */
import { parseOtp } from "./index.js";

export type EmailOtp = { kind: "code"; code: string } | { kind: "link"; url: string };

export interface EmailInput {
  subject?: string;
  /** text/plain 본문 또는 Gmail snippet */
  text?: string;
  /** text/html 본문 */
  html?: string;
}

/** 메일이 인증 메일임을 보여 주는 문구 — 단독 줄 코드는 이 문구가 있을 때만 받는다 */
const VERIFY_HINT =
  /인증|확인\s?(?:번호|코드)|verif|confirm|one[- ]time|\bOTP\b|\bcode\b|passcode|sign[- ]?in|log[- ]?in/i;
const STANDALONE_CODE = /^\s*(\d{4,8})\s*$/m;

const LINK_HINT_STRONG = /verif|confirm|activat|validat|인증|이메일\s?확인|메일\s?확인/i;
const LINK_HINT_WEAK = /확인|sign[- ]?up|register|가입/i;
const LINK_EXCLUDE =
  /unsubscribe|수신\s?거부|opt[-_ ]?out|privacy|개인정보|help|support|고객\s?센터|preferences|설정|terms|약관|mailto:/i;

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    const lower = e.toLowerCase();
    if (lower.startsWith("#x")) return safeCodePoint(parseInt(lower.slice(2), 16)) ?? m;
    if (lower.startsWith("#")) return safeCodePoint(parseInt(lower.slice(1), 10)) ?? m;
    return NAMED_ENTITIES[lower] ?? m;
  });
}

function safeCodePoint(n: number): string | undefined {
  return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : undefined;
}

/** HTML → 텍스트. 블록 경계는 줄바꿈으로 남겨 "단독 줄 코드"를 찾을 수 있게 한다 */
export function htmlToText(html: string): string {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(head|style|script|title)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|tr|td|th|li|h[1-6]|table|section|center|blockquote)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(stripped)
    .replace(/[ \t ​]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** 본문에서 인증 링크 하나를 고른다 (https만, 수신거부·약관 등 제외) */
export function findVerifyLink(input: { html?: string; text?: string }): string | null {
  type Cand = { url: string; score: number };
  const cands: Cand[] = [];
  const consider = (rawUrl: string, label: string) => {
    const url = decodeEntities(rawUrl.trim());
    if (!/^https:\/\//i.test(url)) return;
    try {
      new URL(url);
    } catch {
      return;
    }
    const hay = `${label} ${url}`;
    if (LINK_EXCLUDE.test(hay)) return;
    let score = 0;
    if (LINK_HINT_STRONG.test(label)) score += 3;
    else if (LINK_HINT_WEAK.test(label)) score += 1;
    if (LINK_HINT_STRONG.test(url)) score += 2;
    if (score > 0) cands.push({ url, score });
  };
  if (input.html) {
    for (const m of input.html.matchAll(/<a\b[^>]*?\bhref\s*=\s*(["'])([\s\S]*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi)) {
      consider(m[2] ?? "", htmlToText(m[3] ?? ""));
    }
  } else if (input.text) {
    // 텍스트 본문은 URL과 같은 줄의 문구를 라벨로 본다
    for (const line of input.text.split("\n")) {
      for (const m of line.matchAll(/https:\/\/[^\s<>"')\]]+/gi)) consider(m[0], line.replace(m[0], " "));
    }
  }
  let best: Cand | null = null;
  for (const c of cands) if (!best || c.score > best.score) best = c;
  return best?.url ?? null;
}

/** 제목과 본문 텍스트만으로 코드를 찾는다 (링크 제외) */
export function findEmailCode(subject: string, body: string): string | null {
  const fromSubject = subject ? parseOtp(subject) : null;
  if (fromSubject && !fromSubject.origin) return fromSubject.code;
  const fromBody = body ? parseOtp(body) : null;
  if (fromBody) return fromBody.code;
  // 메일은 코드를 큰 글씨로 한 줄에 따로 두는 경우가 많다 — 인증 문구가 있을 때만 받는다
  if (VERIFY_HINT.test(subject) || VERIFY_HINT.test(body)) {
    const m = STANDALONE_CODE.exec(body);
    if (m?.[1] && !/^(19|20)\d{2}$/.test(m[1])) return m[1];
  }
  return null;
}

/** 인증 메일에서 코드(우선) 또는 인증 링크를 뽑는다. 확신할 수 없으면 null */
export function parseEmail(input: EmailInput): EmailOtp | null {
  const subject = decodeEntities(input.subject ?? "");
  const body = input.html ? htmlToText(input.html) : decodeEntities(input.text ?? "");
  const code = findEmailCode(subject, body);
  if (code) return { kind: "code", code };
  const url = findVerifyLink({ html: input.html, text: input.html ? undefined : input.text });
  return url ? { kind: "link", url } : null;
}

/**
 * Gmail snippet은 약 200자에서 잘린다. 잘린 끝 토큰은 숫자가 반쯤 잘렸을 수 있으므로 버린다.
 */
export function trimSnippet(snippet: string): string {
  const s = decodeEntities(snippet);
  if (s.length < 150) return s;
  const i = s.search(/\s\S*$/);
  return i > 0 ? s.slice(0, i) : s;
}
