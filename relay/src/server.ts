/**
 * HTTP API (JSON). WebSocket 대신 HTTP + long-poll을 쓰는 이유:
 * iOS 단축어/Android 백그라운드 작업에서 단발 POST가 가장 다루기 쉽고,
 * MV3 서비스 워커는 어차피 언제든 종료될 수 있어 재연결 로직이 필요하다.
 *
 *   POST   /v1/pairings                     {publicKey}            → {pairingCode, channelId, browserToken, expiresAt}
 *   POST   /v1/pairings/:code/join          {publicKey}            → {channelId, phoneToken, peerPublicKey}
 *   GET    /v1/pairings/:code               (Bearer browserToken)  → {status, peerPublicKey?}
 *   POST   /v1/channels/:id/messages        (Bearer phoneToken) Envelope → 202
 *   GET    /v1/channels/:id/messages?waitMs (Bearer browserToken)  → {messages: Envelope[]}
 *   DELETE /v1/channels/:id                 (Bearer 어느 쪽이든)    → 204
 *   GET    /healthz
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ENVELOPE_MAX_BYTES, type Envelope } from "@otp-autofill/protocol";
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

function envelopeOf(body: unknown): Envelope {
  const e = body as Partial<Envelope>;
  if (e?.v !== 1 || typeof e.iv !== "string" || typeof e.ct !== "string" || !B64URL.test(e.iv) || !B64URL.test(e.ct)) {
    throw new RelayError(400, "Envelope 형식 오류");
  }
  return { v: 1, iv: e.iv, ct: e.ct };
}

function send(res: ServerResponse, status: number, body?: unknown) {
  res.writeHead(status, {
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

export function createRelayServer(store = new RelayStore()): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://relay");
      const parts = url.pathname.split("/").filter(Boolean);
      const m = req.method ?? "GET";

      if (m === "OPTIONS") return send(res, 204);
      if (m === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true, ...store.stats() });

      if (parts[0] === "v1" && parts[1] === "pairings") {
        const code = parts[2];
        if (m === "POST" && !code) return send(res, 201, store.createPairing(publicKeyOf(await readJson(req))));
        if (m === "POST" && code && parts[3] === "join") {
          return send(res, 200, store.joinPairing(code, publicKeyOf(await readJson(req))));
        }
        if (m === "GET" && code && parts.length === 3) return send(res, 200, store.pollPairing(code, bearer(req)));
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
      if (err instanceof RelayError) return send(res, err.status, { error: err.message });
      // 요청 본문/토큰을 로그에 남기지 않는다
      console.error("[relay] internal error", (err as Error).message);
      send(res, 500, { error: "internal" });
    }
  });
}
