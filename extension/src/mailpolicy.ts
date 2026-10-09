/**
 * 메일 발신 도메인 인증과 입력/열기/복사 판단 — 순수 함수 (Design Spec v2 §3 도메인 정책, §5 E1·E2·E6).
 *
 * - 신뢰하는 헤더는 맨 위 `Authentication-Results` 하나뿐이고, authserv-id가 `mx.google.com`이어야 한다.
 *   그 아래 헤더나 본문의 인증 결과는 보낸 사람이 써 넣을 수 있으므로 보지 않는다.
 * - From 도메인은 `dmarc=pass header.from=<From 도메인>` 또는 From과 eTLD+1이 같은 `dkim=pass`일 때만 인증됨.
 *   SPF 단독 통과는 쓰지 않는다 (발송 대행사 mailfrom이라 From 위조를 막지 못함).
 * - 입력은 인증된 From의 eTLD+1 == 클릭 시점 대상 프레임 URL의 eTLD+1 이고 https일 때만.
 */
import { getDomain } from "tldts";

export interface MailHeader {
  name: string;
  value: string;
}

export const TRUSTED_AUTHSERV_ID = "mx.google.com";

/** eTLD+1 — 공개 접미사 목록의 private 도메인 포함(github.io 테넌트끼리 묶이지 않게). IP·localhost는 null */
export function siteOf(host: string): string | null {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (!h || h === "localhost") return null;
  return getDomain(h, { allowPrivateDomains: true }) ?? null;
}

/** From 헤더 값에서 주소 도메인. 주소가 여러 개이거나 형식이 이상하면 null */
export function fromDomain(value: string): string | null {
  const angles = [...value.matchAll(/<([^<>]*)>/g)];
  let addr: string;
  if (angles.length > 1) return null;
  if (angles.length === 1) addr = angles[0]![1]!.trim();
  else {
    if (value.includes(",")) return null;
    addr = value.trim();
  }
  const m = /^[^@\s<>",]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i.exec(addr);
  return m ? m[1]!.toLowerCase() : null;
}

export interface AuthResult {
  method: string;
  result: string;
  props: Record<string, string>;
}

export interface AuthResults {
  authservId: string;
  results: AuthResult[];
}

function stripComments(s: string): string {
  let prev: string;
  do {
    prev = s;
    s = s.replace(/\([^()]*\)/g, " ");
  } while (s !== prev);
  return s;
}

/** RFC 8601 Authentication-Results 값 해석 (Gmail이 쓰는 형식 범위) */
export function parseAuthResults(value: string): AuthResults {
  const parts = stripComments(value).split(";").map((p) => p.trim());
  const authservId = (parts[0] ?? "").split(/\s+/)[0]!.toLowerCase();
  const results: AuthResult[] = [];
  for (const part of parts.slice(1)) {
    const tokens = part.split(/\s+/).filter(Boolean);
    const head = /^([a-z0-9_-]+)=([a-z0-9_-]+)$/i.exec(tokens[0] ?? "");
    if (!head) continue;
    const props: Record<string, string> = {};
    for (const t of tokens.slice(1)) {
      const kv = /^([a-z0-9_.-]+)=(.+)$/i.exec(t);
      if (kv) props[kv[1]!.toLowerCase()] = kv[2]!.replace(/^"|"$/g, "");
    }
    results.push({ method: head[1]!.toLowerCase(), result: head[2]!.toLowerCase(), props });
  }
  return { authservId, results };
}

/**
 * 누구나 그 도메인 주소로 메일을 보낼 수 있는 무료 메일 사이트 — DMARC pass여도 "그 사이트가 보낸 인증 메일"이 아니다.
 * (Google·Microsoft·Apple은 자사 인증 메일을 google.com·microsoft.com·apple.com에서 보낸다.)
 */
export const SHARED_MAIL_SITES = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "aol.com",
  "gmx.com",
  "mail.com",
]);

export interface SenderInfo {
  /** From 헤더가 주장하는 도메인의 eTLD+1 — 감시 세션 매칭용 (인증 아님) */
  claimedSite: string | null;
  /** 인증된 From의 eTLD+1 — 입력·열기 허용 판단용. 미인증·무료 메일 도메인이면 null */
  authSite: string | null;
}

function verdict(ar: AuthResults, domain: string, site: string): boolean {
  const dmarcOk = ar.results.some(
    (r) => r.method === "dmarc" && r.result === "pass" && (r.props["header.from"] ?? "").toLowerCase() === domain,
  );
  const dkimOk = ar.results.some((r) => {
    if (r.method !== "dkim" || r.result !== "pass") return false;
    const d = r.props["header.d"] ?? (r.props["header.i"] ?? "").split("@").pop() ?? "";
    return d !== "" && siteOf(d) === site;
  });
  return dmarcOk || dkimOk;
}

export function senderInfo(headers: MailHeader[]): SenderInfo {
  const froms = headers.filter((x) => x.name.toLowerCase() === "from");
  const domain = froms.length === 1 ? fromDomain(froms[0]!.value) : null;
  const claimedSite = domain ? siteOf(domain) : null;
  if (!domain || !claimedSite || SHARED_MAIL_SITES.has(claimedSite)) return { claimedSite, authSite: null };

  const all = headers.filter((x) => x.name.toLowerCase() === "authentication-results").map((x) => parseAuthResults(x.value));
  const top = all[0];
  if (!top || top.authservId !== TRUSTED_AUTHSERV_ID) return { claimedSite, authSite: null };
  // 헤더 순서가 보장되지 않는 경우까지 막는다: mx.google.com을 자칭하는 결과가 여럿이면 모두 통과여야 인증
  const google = all.filter((ar) => ar.authservId === TRUSTED_AUTHSERV_ID);
  const ok = google.every((ar) => verdict(ar, domain, claimedSite));
  return { claimedSite, authSite: ok ? claimedSite : null };
}

export type MailAction = "fill" | "open" | "copy" | "none";
export type MailWarning = "unauthenticated" | "site-mismatch" | "insecure" | "expired";

export interface MailDecision {
  action: MailAction;
  warning?: MailWarning;
}

/**
 * 클릭 시점 판단.
 * - 코드형: targetUrl = 입력할 프레임의 URL(브라우저가 알려준 값). 허용이면 fill, 아니면 copy + 경고.
 * - 링크형: targetUrl = 메일 속 링크. From이 인증됐고 링크가 https면 open, 아니면 링크 copy + 경고.
 *   링크 도메인은 클릭 추적 도메인(sendgrid 등)일 수 있어 판단은 From 기준이다(E6).
 */
export function decideMail(opts: {
  kind: "code" | "link";
  authSite: string | null;
  targetUrl?: string;
  expiresAt: number;
  now: number;
}): MailDecision {
  if (opts.now >= opts.expiresAt) return { action: "none", warning: "expired" };
  const copy = (warning: MailWarning): MailDecision => ({ action: "copy", warning });
  if (!opts.authSite) return copy("unauthenticated");
  let url: URL;
  try {
    url = new URL(opts.targetUrl ?? "");
  } catch {
    return copy("site-mismatch");
  }
  if (url.protocol !== "https:") return copy("insecure");
  if (opts.kind === "link") return { action: "open" };
  return siteOf(url.hostname) === opts.authSite ? { action: "fill" } : copy("site-mismatch");
}

