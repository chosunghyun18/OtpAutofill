/**
 * HTTP API (JSON). WebSocket 대신 HTTP + long-poll을 쓰는 이유:
 * iOS 단축어/Android 백그라운드 작업에서 단발 POST가 가장 다루기 쉽고,
 * MV3 서비스 워커는 어차피 언제든 종료될 수 있어 재연결 로직이 필요하다.
 *
 *   POST   /v1/pairings                     {commitment}           → {pairingCode, channelId, browserToken, expiresAt}
 *   POST   /v1/pairings/:code/join          {publicKey}            → {channelId, phoneToken, commitment}
 *   GET    /v1/pairings/:code               (Bearer browserToken)  → {status: waiting|joined, peerPublicKey?}
 *   POST   /v1/pairings/:code/reveal        (Bearer browserToken) {publicKey} → 204   (커밋과 일치해야 함)
 *   GET    /v1/pairings/:code/reveal        (Bearer phoneToken)    → {status: waiting|revealed, peerPublicKey?}
 *   POST   /v1/channels/:id/messages        (Bearer phoneToken) Envelope → 202
 *   GET    /v1/channels/:id/messages?waitMs (Bearer browserToken)  → {messages: Envelope[]}
 *   DELETE /v1/channels/:id                 (Bearer 어느 쪽이든)    → 204
 *   GET    /healthz
 *
 * 페어링 생성·join은 각각 IP(IPv6는 /56)당 분당 10회로 제한한다 (초과 시 429 + retry-after).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ENVELOPE_MAX_BYTES, type Envelope } from "@otp-autofill/protocol";
import { clientKey, RateLimiter } from "./ratelimit.js";
import { RelayError, RelayStore } from "./store.js";

const MAX_WAIT_MS = 25_000;
const B64URL = /^[A-Za-z0-9_-]+$/;

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > ENVELOPE_MAX_BYTES) throw new RelayError(413, "본문이 너무 큼");
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new RelayError(400, "JSON 아님");
  }
}

function bearer(req: IncomingMessage): string {
  const h = req.headers.authorization ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

function publicKeyOf(body: unknown): string {
  const k = (body as { publicKey?: unknown })?.publicKey;
  // P-256 raw 공개키 65바이트 → base64url 87자
  if (typeof k !== "string" || k.length !== 87 || !B64URL.test(k)) throw new RelayError(400, "publicKey 형식 오류");
  return k;
}

function commitmentOf(body: unknown): string {
  const c = (body as { commitment?: unknown })?.commitment;
  // SHA-256 32바이트 → base64url 43자
  if (typeof c !== "string" || c.length !== 43 || !B64URL.test(c)) throw new RelayError(400, "commitment 형식 오류");
  return c;
}

function envelopeOf(body: unknown): Envelope {
  const e = body as Partial<Envelope>;
  if (e?.v !== 1 || typeof e.iv !== "string" || typeof e.ct !== "string" || !B64URL.test(e.iv) || !B64URL.test(e.ct)) {
    throw new RelayError(400, "Envelope 형식 오류");
  }
  return { v: 1, iv: e.iv, ct: e.ct };
}

function send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, {
    ...headers,
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

function waitForMessage(store: RelayStore, channelId: string, waitMs: number, req: IncomingMessage): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      off();
      resolve();
    };
    const timer = setTimeout(done, waitMs);
    const off = store.onMessage(channelId, done);
    req.on("close", done);
  });
}

export interface RelayServerOptions {
  /** 페어링 생성·join 요청 제한 (IP 기준) */
  pairingLimiter?: RateLimiter;
  /** 앞단 리버스 프록시 수. 0(기본)이면 X-Forwarded-For를 무시하고 소켓 주소만 쓴다 */
  trustedProxyHops?: number;
}

export function createRelayServer(store = new RelayStore(), opts: RelayServerOptions = {}): Server {
  const limiter = opts.pairingLimiter ?? new RateLimiter();
  const hops = opts.trustedProxyHops ?? 0;
  // 본문을 읽기 전에 검사한다. 생성과 join은 서로의 한도를 깎지 않도록 키를 나눈다
  const limitPairing = (req: IncomingMessage, route: "create" | "join") => {
    const r = limiter.hit(`${route}:${clientKey(req.socket.remoteAddress, req.headers["x-forwarded-for"], hops)}`);
    if (!r.ok) throw new RelayError(429, "요청이 너무 많음", { "retry-after": String(Math.ceil(r.retryAfterMs / 1000)) });
  };
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://relay");
      const parts = url.pathname.split("/").filter(Boolean);
      const m = req.method ?? "GET";

      if (m === "OPTIONS") return send(res, 204);
      if (m === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true, ...store.stats() });

      if (parts[0] === "v1" && parts[1] === "pairings") {
        const code = parts[2];
        if (m === "POST" && !code) {
          limitPairing(req, "create");
          return send(res, 201, store.createPairing(commitmentOf(await readJson(req))));
        }
        if (m === "POST" && code && parts[3] === "join") {
          limitPairing(req, "join");
          return send(res, 200, store.joinPairing(code, publicKeyOf(await readJson(req))));
        }
        if (m === "GET" && code && parts.length === 3) return send(res, 200, store.pollPairing(code, bearer(req)));
        if (code && parts[3] === "reveal" && parts.length === 4) {
          if (m === "POST") {
            await store.revealBrowserKey(code, bearer(req), publicKeyOf(await readJson(req)));
            return send(res, 204);
          }
          if (m === "GET") return send(res, 200, store.fetchBrowserKey(code, bearer(req)));
        }
      }

      if (parts[0] === "v1" && parts[1] === "channels" && parts[2]) {
        const id = parts[2];
        if (parts[3] === "messages" && m === "POST") {
          store.push(id, bearer(req), envelopeOf(await readJson(req)));
          return send(res, 202, { ok: true });
        }
        if (parts[3] === "messages" && m === "GET") {
          const tok = bearer(req);
          let messages = store.drain(id, tok);
          const waitMs = Math.min(Number(url.searchParams.get("waitMs") ?? 0) || 0, MAX_WAIT_MS);
          if (messages.length === 0 && waitMs > 0) {
            await waitForMessage(store, id, waitMs, req);
            messages = store.drain(id, tok);
          }
          return send(res, 200, { messages });
        }
        if (parts.length === 3 && m === "DELETE") {
          store.revoke(id, bearer(req));
          return send(res, 204);
        }
      }

      send(res, 404, { error: "not found" });
    } catch (err) {
      if (err instanceof RelayError) return send(res, err.status, { error: err.message }, err.headers);
      // 요청 본문/토큰을 로그에 남기지 않는다
      console.error("[relay] internal error", (err as Error).message);
      send(res, 500, { error: "internal" });
    }
  });
}
