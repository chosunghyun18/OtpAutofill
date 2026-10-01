import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import {
  deriveChannelKey,
  exportPublicKey,
  generateKeyPair,
  importPublicKey,
  openEnvelope,
  sealPayload,
} from "@otp-autofill/protocol";
import { createRelayServer } from "../src/server.js";

const server = createRelayServer();
let base = "";

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function call(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: res.status === 204 ? null : await res.json() };
}

describe("relay HTTP — 페어링부터 E2E 전달까지", () => {
  it("릴레이는 암호문만 보고 브라우저가 평문을 복원한다", async () => {
    const browser = await generateKeyPair();
    const phone = await generateKeyPair();

    const created = await call("POST", "/v1/pairings", { publicKey: await exportPublicKey(browser.publicKey) });
    expect(created.status).toBe(201);
    const { pairingCode, channelId, browserToken } = created.json;

    const joined = await call("POST", `/v1/pairings/${pairingCode}/join`, {
      publicKey: await exportPublicKey(phone.publicKey),
    });
    expect(joined.status).toBe(200);

    const polled = await call("GET", `/v1/pairings/${pairingCode}`, undefined, browserToken);
    expect(polled.json.status).toBe("joined");

    const phoneKey = await deriveChannelKey(phone.privateKey, await importPublicKey(joined.json.peerPublicKey), channelId);
    const browserKey = await deriveChannelKey(
      browser.privateKey,
      await importPublicKey(polled.json.peerPublicKey),
      channelId,
    );

    // long-poll을 먼저 걸어 두고 폰이 전송
    const pending = call("GET", `/v1/channels/${channelId}/messages?waitMs=5000`, undefined, browserToken);
    const env = await sealPayload(phoneKey, channelId, {
      v: 1,
      msgId: "x",
      text: "인증번호 [123456]",
      receivedAt: Date.now(),
    });
    expect((await call("POST", `/v1/channels/${channelId}/messages`, env, joined.json.phoneToken)).status).toBe(202);

    const got = await pending;
    expect(got.json.messages).toHaveLength(1);
    expect(JSON.stringify(got.json)).not.toContain("123456");
    const opened = await openEnvelope(browserKey, channelId, got.json.messages[0]);
    expect(opened.text).toContain("123456");
  });

  it("잘못된 공개키·토큰은 거부한다", async () => {
    expect((await call("POST", "/v1/pairings", { publicKey: "short" })).status).toBe(400);
    expect((await call("GET", "/v1/channels/nope/messages", undefined, "bad")).status).toBe(401);
  });
});
