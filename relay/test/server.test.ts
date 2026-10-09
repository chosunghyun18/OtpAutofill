import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import {
  commitPublicKey,
  deriveChannelKey,
  exportPublicKey,
  generateKeyPair,
  importPublicKey,
  openEnvelope,
  sealPayload,
  verifyCommitment,
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

    const browserPub = await exportPublicKey(browser.publicKey);
    const phonePub = await exportPublicKey(phone.publicKey);

    // 1) 브라우저는 커밋만 올린다
    const created = await call("POST", "/v1/pairings", { commitment: await commitPublicKey(browserPub) });
    expect(created.status).toBe(201);
    const { pairingCode, channelId, browserToken } = created.json;

    // 2) 폰 join → 커밋을 받는다 (브라우저 공개키는 아직 모름)
    const joined = await call("POST", `/v1/pairings/${pairingCode}/join`, { publicKey: phonePub });
    expect(joined.status).toBe(200);
    expect(joined.json.peerPublicKey).toBeUndefined();
    expect((await call("GET", `/v1/pairings/${pairingCode}/reveal`, undefined, joined.json.phoneToken)).json).toEqual({
      status: "waiting",
    });

    // 3) 브라우저가 폰 키를 받은 뒤 자기 키 공개
    const polled = await call("GET", `/v1/pairings/${pairingCode}`, undefined, browserToken);
    expect(polled.json).toEqual({ status: "joined", peerPublicKey: phonePub });
    expect((await call("POST", `/v1/pairings/${pairingCode}/reveal`, { publicKey: browserPub }, browserToken)).status).toBe(
      204,
    );

    // 4) 폰이 공개키를 받아 커밋과 대조
    const revealed = await call("GET", `/v1/pairings/${pairingCode}/reveal`, undefined, joined.json.phoneToken);
    expect(revealed.json.status).toBe("revealed");
    expect(await verifyCommitment(revealed.json.peerPublicKey, joined.json.commitment)).toBe(true);

    const phoneKey = await deriveChannelKey(phone.privateKey, await importPublicKey(revealed.json.peerPublicKey), channelId);
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
    expect((await call("POST", "/v1/pairings", { commitment: "short" })).status).toBe(400);
    expect((await call("GET", "/v1/channels/nope/messages", undefined, "bad")).status).toBe(401);
  });
});
