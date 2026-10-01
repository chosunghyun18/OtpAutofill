/**
 * 피싱 방어용 origin 정책 — 순수 함수.
 *
 * - SMS에 WebOTP origin-bound 줄(@example.com #123456)이 있으면, 페이지 호스트가 그 도메인
 *   (또는 하위 도메인)일 때만 입력을 허용한다. 불일치 = 피싱 의심 → 차단.
 * - origin 정보가 없으면 "사용자 클릭 시에만" 입력 (자동 입력 금지). 칩에 현재 호스트를 표시해
 *   사용자가 직접 확인하게 한다.
 * - https가 아닌 페이지(localhost 제외)에서는 입력하지 않는다.
 */

export type FillDecision =
  | { allow: true; requiresClick: true; reason: "origin-match" | "no-origin-hint" }
  | { allow: false; reason: "origin-mismatch" | "insecure-context" | "expired" };

export function hostMatches(pageHost: string, boundOrigin: string): boolean {
  const h = pageHost.toLowerCase().replace(/\.$/, "");
  const o = boundOrigin.toLowerCase().replace(/\.$/, "");
  return h === o || h.endsWith("." + o);
}

export function decideFill(opts: {
  pageUrl: string;
  boundOrigin?: string;
  expiresAt: number;
  now?: number;
}): FillDecision {
  const now = opts.now ?? Date.now();
  if (now >= opts.expiresAt) return { allow: false, reason: "expired" };

  const url = new URL(opts.pageUrl);
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !isLocal) return { allow: false, reason: "insecure-context" };

  if (opts.boundOrigin) {
    return hostMatches(url.hostname, opts.boundOrigin)
      ? { allow: true, requiresClick: true, reason: "origin-match" }
      : { allow: false, reason: "origin-mismatch" };
  }
  // 현재 MVP는 origin이 일치해도 클릭을 요구한다 (자동 입력은 이후 단계에서 옵트인으로 검토)
  return { allow: true, requiresClick: true, reason: "no-origin-hint" };
}
