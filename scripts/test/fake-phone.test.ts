import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { parseOtp } from "@otp-autofill/otp-parser";
import {
  commitPublicKey,
  deriveChannelKey,
  exportPublicKey,
  generateKeyPair,
  importPublicKey,
  openEnvelope,
  safetyNumber,
  type Envelope,
} from "@otp-autofill/protocol";
import { createRelayServer } from "../../relay/src/server.js";
import { CommitmentMismatch, joinAsPhone, sendSms } from "../fake-phone.js";

const server = createRelayServer();
let base = "";
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const post = (url: string, body: unknown, token?: string) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

/** background.ts와 같은 순서로 움직이는 브라우저 역할: 커밋 → 폰 키 수신 → 자기 키 공개 */
async function browserSide() {
  const kp = await generateKeyPair();
  const pub = await exportPublicKey(kp.publicKey);
  const created = await (await post(`${base}/v1/pairings`, { commitment: await commitPublicKey(pub) })).json();
  const auth = { authorization: `Bearer ${created.browserToken}` };
  const finish = async () => {
    for (;;) {
      const polled = await (await fetch(`${base}/v1/pairings/${created.pairingCode}`, { headers: auth })).json();
      if (polled.status === "joined") {
        await post(`${base}/v1/pairings/${created.pairingCode}/reveal`, { publicKey: pub }, created.browserToken);
        return {
          peerPub: polled.peerPublicKey as string,
          key: await deriveChannelKey(kp.privateKey, await importPublicKey(polled.peerPublicKey), created.channelId),
        };
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return { pub, created, auth, finish };
}

describe("fake-phone ↔ relay ↔ 브라우저", () => {
  it("페어링 → 안전번호 일치 → 문자 전송 → 브라우저가 복호화·파싱", async () => {
    const b = await browserSide();
    const [phone, done] = await Promise.all([joinAsPhone(base, b.created.pairingCode, { pollMs: 10 }), b.finish()]);
    expect(phone.channelId).toBe(b.created.channelId);
    expect(await safetyNumber(b.pub, done.peerPub)).toBe(phone.safetyNumber);

    const sent = await sendSms(phone, "[Web발신]\n[네이버] 인증번호 [482913]를 입력해주세요.", "네이버");
    const { messages } = (await (
      await fetch(`${base}/v1/channels/${b.created.channelId}/messages`, { headers: b.auth })
    ).json()) as { messages: Envelope[] };
    expect(messages).toHaveLength(1);

    const opened = await openEnvelope(done.key, b.created.channelId, messages[0]!);
    expect(opened).toEqual(sent);
    expect(parseOtp(opened.text)?.code).toBe("482913");
  });

  it("없는 페어링 코드는 오류", async () => {
    await expect(joinAsPhone(base, "ZZZZZZZZ")).rejects.toThrow(/404/);
  });
});

describe("악성 릴레이", () => {
  it("공개된 키가 커밋과 다르면(바꿔치기) 폰이 페어링을 중단한다", async () => {
    const real = await exportPublicKey((await generateKeyPair()).publicKey);
    const fake = await exportPublicKey((await generateKeyPair()).publicKey);
    const commitment = await commitPublicKey(real);
    const evil = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.method === "POST") res.end(JSON.stringify({ channelId: "c", phoneToken: "t", commitment }));
      else res.end(JSON.stringify({ status: "revealed", peerPublicKey: fake }));
    });
    await new Promise<void>((r) => evil.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${(evil.address() as AddressInfo).port}`;
      await expect(joinAsPhone(url, "ABCDEFGH")).rejects.toBeInstanceOf(CommitmentMismatch);
    } finally {
      await new Promise<void>((r) => evil.close(() => r()));
    }
  });
});
