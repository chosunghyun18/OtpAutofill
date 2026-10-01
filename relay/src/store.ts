/**
 * 릴레이 상태 — 전부 메모리, 영속화 없음. 재시작하면 페어링도 사라진다 (설계 의도).
 *
 * - Pairing: 브라우저가 만든 1회용 페어링 코드. 폰이 join하면 즉시 삭제.
 * - Channel: 폰(송신) → 브라우저(수신) 단방향 큐. 토큰은 SHA-256 해시로만 보관.
 * - 메시지: 암호문 봉투만 보관, TTL 지나면 폐기, 브라우저가 가져가면 즉시 삭제.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Envelope } from "@otp-autofill/protocol";

export interface RelayConfig {
  pairingTtlMs: number;
  messageTtlMs: number;
  channelIdleTtlMs: number;
  maxQueuedPerChannel: number;
}

export const DEFAULT_CONFIG: RelayConfig = {
  pairingTtlMs: 5 * 60_000,
  messageTtlMs: 2 * 60_000,
  channelIdleTtlMs: 30 * 24 * 60 * 60_000,
  maxQueuedPerChannel: 20,
};

interface Pairing {
  code: string;
  channelId: string;
  browserPublicKey: string;
  phonePublicKey?: string;
  expiresAt: number;
}

interface QueuedMessage {
  env: Envelope;
  expiresAt: number;
}

interface Channel {
  id: string;
  browserTokenHash: Buffer;
  phoneTokenHash?: Buffer;
  queue: QueuedMessage[];
  lastSeenAt: number;
}

export class RelayError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// 헷갈리는 문자(0/O, 1/I/L) 제외한 페어링 코드 알파벳
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function newPairingCode(len = 8): string {
  const bytes = randomBytes(len);
  let s = "";
  for (const b of bytes) s += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return s;
}

const token = () => randomBytes(32).toString("base64url");
const hash = (t: string) => createHash("sha256").update(t).digest();

function tokenMatches(expected: Buffer | undefined, given: string | undefined): boolean {
  if (!expected || !given) return false;
  return timingSafeEqual(expected, hash(given));
}

export class RelayStore {
  private pairings = new Map<string, Pairing>();
  private channels = new Map<string, Channel>();
  private waiters = new Map<string, Set<() => void>>();

  constructor(
    private readonly config: RelayConfig = DEFAULT_CONFIG,
    private readonly now: () => number = Date.now,
  ) {}

  /** 브라우저: 페어링 시작 */
  createPairing(browserPublicKey: string) {
    const channelId = randomBytes(16).toString("base64url");
    const browserToken = token();
    let code = newPairingCode();
    while (this.pairings.has(code)) code = newPairingCode();
    const expiresAt = this.now() + this.config.pairingTtlMs;
    this.pairings.set(code, { code, channelId, browserPublicKey, expiresAt });
    this.channels.set(channelId, {
      id: channelId,
      browserTokenHash: hash(browserToken),
      queue: [],
      lastSeenAt: this.now(),
    });
    return { pairingCode: code, channelId, browserToken, expiresAt };
  }

  /** 폰: 페어링 코드로 합류. 두 번째 join은 거부, 브라우저가 폰 공개키를 받아가면 코드 삭제 */
  joinPairing(code: string, phonePublicKey: string) {
    const p = this.livePairing(code);
    if (p.phonePublicKey) throw new RelayError(409, "이미 사용된 페어링 코드");
    p.phonePublicKey = phonePublicKey;
    const phoneToken = token();
    const ch = this.channels.get(p.channelId)!;
    ch.phoneTokenHash = hash(phoneToken);
    return { channelId: p.channelId, phoneToken, peerPublicKey: p.browserPublicKey };
  }

  /** 브라우저: 폰 공개키 수신. 받으면 페어링 레코드 삭제 */
  pollPairing(code: string, browserToken: string) {
    const p = this.livePairing(code);
    const ch = this.channels.get(p.channelId);
    if (!tokenMatches(ch?.browserTokenHash, browserToken)) throw new RelayError(401, "토큰 불일치");
    if (!p.phonePublicKey) return { status: "waiting" as const };
    this.pairings.delete(code);
    return { status: "joined" as const, peerPublicKey: p.phonePublicKey };
  }

  /** 폰: 암호문 전송 */
  push(channelId: string, phoneToken: string, env: Envelope) {
    const ch = this.authChannel(channelId, phoneToken, "phone");
    this.gc(ch);
    if (ch.queue.length >= this.config.maxQueuedPerChannel) throw new RelayError(429, "큐 가득 참");
    ch.queue.push({ env, expiresAt: this.now() + this.config.messageTtlMs });
    this.waiters.get(channelId)?.forEach((wake) => wake());
  }

  /** 브라우저: 대기 중 메시지를 가져가고 즉시 삭제 */
  drain(channelId: string, browserToken: string): Envelope[] {
    const ch = this.authChannel(channelId, browserToken, "browser");
    this.gc(ch);
    const out = ch.queue.map((q) => q.env);
    ch.queue = [];
    return out;
  }

  /** long-poll 지원: 메시지가 들어오면 깨운다 */
  onMessage(channelId: string, wake: () => void): () => void {
    let set = this.waiters.get(channelId);
    if (!set) this.waiters.set(channelId, (set = new Set()));
    set.add(wake);
    return () => {
      set.delete(wake);
      if (set.size === 0) this.waiters.delete(channelId);
    };
  }

  /** 페어링 해제 (어느 쪽이든) */
  revoke(channelId: string, anyToken: string) {
    const ch = this.channels.get(channelId);
    if (!ch || !(tokenMatches(ch.browserTokenHash, anyToken) || tokenMatches(ch.phoneTokenHash, anyToken))) {
      throw new RelayError(401, "토큰 불일치");
    }
    this.channels.delete(channelId);
  }

  /** 주기적 정리 — 만료 페어링/메시지/유휴 채널 제거 */
  sweep() {
    const t = this.now();
    for (const [code, p] of this.pairings) if (p.expiresAt <= t) this.pairings.delete(code);
    for (const [id, ch] of this.channels) {
      this.gc(ch);
      if (t - ch.lastSeenAt > this.config.channelIdleTtlMs) this.channels.delete(id);
    }
  }

  stats() {
    let queued = 0;
    for (const ch of this.channels.values()) queued += ch.queue.length;
    return { pairings: this.pairings.size, channels: this.channels.size, queued };
  }

  private livePairing(code: string): Pairing {
    const p = this.pairings.get(code.toUpperCase());
    if (!p || p.expiresAt <= this.now()) throw new RelayError(404, "페어링 코드 없음 또는 만료");
    return p;
  }

  private authChannel(channelId: string, tok: string, role: "phone" | "browser"): Channel {
    const ch = this.channels.get(channelId);
    const expected = role === "phone" ? ch?.phoneTokenHash : ch?.browserTokenHash;
    if (!ch || !tokenMatches(expected, tok)) throw new RelayError(401, "토큰 불일치");
    ch.lastSeenAt = this.now();
    return ch;
  }

  private gc(ch: Channel) {
    const t = this.now();
    ch.queue = ch.queue.filter((q) => q.expiresAt > t);
  }
}
