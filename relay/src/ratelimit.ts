/**
 * IP별 고정 윈도 카운터 — 페어링 코드 브루트포스(T9)와 페어링 남발(메모리 고갈) 방지.
 * 메모리 전용, 의존성 0. 윈도가 끝난 키는 sweep()에서 지운다.
 */
import { isIPv4, isIPv6 } from "node:net";

export interface RateLimitConfig {
  limit: number;
  windowMs: number;
  /** 추적하는 키 수 상한(메모리 고갈 방지). 넘으면 가장 오래된 키를 버린다 — 새 사용자를 막지 않는다 */
  maxKeys: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitConfig = { limit: 10, windowMs: 60_000, maxKeys: 100_000 };

export class RateLimiter {
  private windows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly config: RateLimitConfig = DEFAULT_RATE_LIMIT,
    private readonly now: () => number = Date.now,
  ) {}

  /** 요청 1회 기록. 한도를 넘으면 ok=false와 남은 대기 시간 */
  hit(key: string): { ok: boolean; retryAfterMs: number } {
    const t = this.now();
    let w = this.windows.get(key);
    if (!w || w.resetAt <= t) {
      if (!w && this.windows.size >= this.config.maxKeys) {
        this.sweep();
        // Map은 삽입 순서를 유지하므로 첫 키가 가장 오래된 윈도다
        if (this.windows.size >= this.config.maxKeys) this.windows.delete(this.windows.keys().next().value!);
      }
      w = { count: 0, resetAt: t + this.config.windowMs };
      this.windows.set(key, w);
    }
    w.count++;
    return w.count <= this.config.limit ? { ok: true, retryAfterMs: 0 } : { ok: false, retryAfterMs: w.resetAt - t };
  }

  sweep() {
    const t = this.now();
    for (const [k, w] of this.windows) if (w.resetAt <= t) this.windows.delete(k);
  }

  get size() {
    return this.windows.size;
  }
}

/**
 * IPv6의 /56 접두어. 가입자 한 명이 보통 /56~/64를 받으므로 /64 단위로 세면 한 사람이 주소를 바꿔 가며
 * 리밋을 우회할 수 있다. /56이면 /48 대역 하나로 쓸 수 있는 키가 256개로 줄어든다.
 */
function ipv6Prefix56(ip: string): string {
  const [head = "", tail = ""] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...h, ...Array(8 - h.length - t.length).fill("0"), ...t] : h;
  const [a, b, c, d] = groups.slice(0, 4).map((g) => g.toLowerCase().padStart(4, "0"));
  return `${a}:${b}:${c}:${d!.slice(0, 2)}00::/56`;
}

/** 레이트 리밋 키로 쓸 IP 정규화: IPv4-mapped → IPv4, IPv6 → /56. 형식이 아니면 null */
export function rateLimitKey(ip: string): string | null {
  const s = ip.trim().replace(/^\[|\]$/g, "");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  if (mapped && isIPv4(mapped[1]!)) return mapped[1]!;
  if (isIPv4(s)) return s;
  if (isIPv6(s)) return ipv6Prefix56(s.split("%")[0]!);
  return null;
}

/**
 * 클라이언트 IP 키. trustedHops=0이면 소켓 주소만 쓴다.
 * 리버스 프록시 N단 뒤면 X-Forwarded-For의 오른쪽에서 N번째 값(가장 바깥 신뢰 프록시가 붙인 값)을 쓴다.
 * 그보다 왼쪽 값은 클라이언트가 조작할 수 있으므로 쓰지 않는다. 형식이 이상하면 소켓 주소로 폴백.
 */
export function clientKey(remoteAddress: string | undefined, xff: string | string[] | undefined, trustedHops: number) {
  const socketKey = rateLimitKey(remoteAddress ?? "") ?? "unknown";
  if (trustedHops <= 0 || !xff) return socketKey;
  const list = (Array.isArray(xff) ? xff.join(",") : xff).split(",").map((v) => v.trim());
  const picked = list[list.length - trustedHops];
  return (picked && rateLimitKey(picked)) || socketKey;
}
