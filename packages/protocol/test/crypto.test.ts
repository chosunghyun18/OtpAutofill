import { describe, expect, it } from "vitest";
import {
  deriveChannelKey,
  exportPublicKey,
  generateKeyPair,
  importPublicKey,
  openEnvelope,
  PayloadRejected,
  safetyNumber,
  sealPayload,
  type OtpPayload,
} from "../src/index.js";

async function pair(channelId = "chan-1") {
  const phone = await generateKeyPair();
  const browser = await generateKeyPair();
  const phonePub = await exportPublicKey(phone.publicKey);
  const browserPub = await exportPublicKey(browser.publicKey);
  const phoneKey = await deriveChannelKey(phone.privateKey, await importPublicKey(browserPub), channelId);
  const browserKey = await deriveChannelKey(browser.privateKey, await importPublicKey(phonePub), channelId);
  return { phoneKey, browserKey, phonePub, browserPub, channelId };
}

const payload = (over: Partial<OtpPayload> = {}): OtpPayload => ({
  v: 1,
  msgId: "m1",
  text: "[Web발신] 인증번호 [123456]를 입력해주세요",
  receivedAt: Date.now(),
  ...over,
});

describe("E2E 암호화", () => {
  it("폰에서 봉인한 메시지를 브라우저가 연다", async () => {
    const { phoneKey, browserKey, channelId } = await pair();
    const env = await sealPayload(phoneKey, channelId, payload());
    expect(env.ct).not.toContain("123456");
    const opened = await openEnvelope(browserKey, channelId, env);
    expect(opened.text).toContain("123456");
  });

  it("다른 채널 ID(AAD)로는 열 수 없다", async () => {
    const { phoneKey, browserKey, channelId } = await pair();
    const env = await sealPayload(phoneKey, channelId, payload());
    await expect(openEnvelope(browserKey, "other", env)).rejects.toBeInstanceOf(PayloadRejected);
  });

  it("변조된 암호문은 거부한다", async () => {
    const { phoneKey, browserKey, channelId } = await pair();
    const env = await sealPayload(phoneKey, channelId, payload());
    const tampered = { ...env, ct: (env.ct[0] === "A" ? "B" : "A") + env.ct.slice(1) };
    await expect(openEnvelope(browserKey, channelId, tampered)).rejects.toBeInstanceOf(PayloadRejected);
  });

  it("제3자 키(릴레이)로는 열 수 없다", async () => {
    const { phoneKey, channelId, phonePub } = await pair();
    const relay = await generateKeyPair();
    const relayKey = await deriveChannelKey(relay.privateKey, await importPublicKey(phonePub), channelId);
    const env = await sealPayload(phoneKey, channelId, payload());
    await expect(openEnvelope(relayKey, channelId, env)).rejects.toBeInstanceOf(PayloadRejected);
  });

  it("5분 지난 메시지는 만료로 거부한다", async () => {
    const { phoneKey, browserKey, channelId } = await pair();
    const env = await sealPayload(phoneKey, channelId, payload({ receivedAt: Date.now() - 6 * 60_000 }));
    await expect(openEnvelope(browserKey, channelId, env)).rejects.toThrow("만료");
  });
});

describe("safetyNumber", () => {
  it("양쪽에서 같은 값을 계산하고 형식이 XXXX-XXXX", async () => {
    const { phonePub, browserPub } = await pair();
    const a = await safetyNumber(phonePub, browserPub);
    const b = await safetyNumber(browserPub, phonePub);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);
  });

  it("키가 바뀌면(MITM) 값이 달라진다", async () => {
    const { phonePub, browserPub } = await pair();
    const mitm = await exportPublicKey((await generateKeyPair()).publicKey);
    expect(await safetyNumber(phonePub, mitm)).not.toBe(await safetyNumber(phonePub, browserPub));
  });
});
