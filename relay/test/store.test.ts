import { describe, expect, it } from "vitest";
import { commitPublicKey } from "@otp-autofill/protocol";
import { RelayError, RelayStore, DEFAULT_CONFIG } from "../src/store.js";

const PUB_B = "B".repeat(87);
const PUB_P = "P".repeat(87);
const env = { v: 1 as const, iv: "aXY", ct: "Y3Q" };

async function setup() {
  let t = 1_000_000;
  const store = new RelayStore(DEFAULT_CONFIG, () => t);
  const advance = (ms: number) => (t += ms);
  const pairing = store.createPairing(await commitPublicKey(PUB_B));
  const joined = store.joinPairing(pairing.pairingCode, PUB_P);
  return { store, advance, pairing, joined };
}

describe("RelayStore 페어링 (커밋-공개)", () => {
  it("폰은 먼저 커밋만 받고, 브라우저가 폰 키를 받은 뒤 공개한 키를 받는다", async () => {
    const { store, pairing, joined } = await setup();
    expect(joined.commitment).toBe(await commitPublicKey(PUB_B));
    expect(store.fetchBrowserKey(pairing.pairingCode, joined.phoneToken)).toEqual({ status: "waiting" });
    expect(store.pollPairing(pairing.pairingCode, pairing.browserToken)).toEqual({
      status: "joined",
      peerPublicKey: PUB_P,
    });
    await store.revealBrowserKey(pairing.pairingCode, pairing.browserToken, PUB_B);
    expect(store.fetchBrowserKey(pairing.pairingCode, joined.phoneToken)).toEqual({
      status: "revealed",
      peerPublicKey: PUB_B,
    });
    // 응답 유실 대비 재조회는 되지만, join은 여전히 1회
    expect(store.fetchBrowserKey(pairing.pairingCode, joined.phoneToken).status).toBe("revealed");
    expect(() => store.joinPairing(pairing.pairingCode, PUB_P)).toThrow(RelayError);
  });

  it("커밋과 다른 키는 공개할 수 없고, 폰 합류 전에는 공개할 수 없다", async () => {
    const { store, pairing } = await setup();
    await expect(store.revealBrowserKey(pairing.pairingCode, pairing.browserToken, "X".repeat(87))).rejects.toThrow(
      /커밋/,
    );
    const early = store.createPairing(await commitPublicKey(PUB_B));
    await expect(store.revealBrowserKey(early.pairingCode, early.browserToken, PUB_B)).rejects.toThrow(/합류/);
  });

  it("역할별 토큰으로만 조회한다", async () => {
    const { store, pairing, joined } = await setup();
    expect(() => store.pollPairing(pairing.pairingCode, "wrong")).toThrow(/토큰/);
    expect(() => store.pollPairing(pairing.pairingCode, joined.phoneToken)).toThrow(/토큰/);
    expect(() => store.fetchBrowserKey(pairing.pairingCode, pairing.browserToken)).toThrow(/토큰/);
  });

  it("이미 join된 코드로 다시 join할 수 없다 (코드 탈취 대비)", async () => {
    const { store, pairing } = await setup();
    expect(() => store.joinPairing(pairing.pairingCode, "X".repeat(87))).toThrow(/이미 사용/);
  });

  it("만료된 페어링 코드는 거부한다", async () => {
    let t = 0;
    const store = new RelayStore(DEFAULT_CONFIG, () => t);
    const p = store.createPairing(await commitPublicKey(PUB_B));
    t += DEFAULT_CONFIG.pairingTtlMs + 1;
    expect(() => store.joinPairing(p.pairingCode, PUB_P)).toThrow(/만료/);
  });

  it("동시 페어링 수 상한을 넘으면 503", () => {
    const store = new RelayStore({ ...DEFAULT_CONFIG, maxPairings: 2 });
    store.createPairing("c".repeat(43));
    store.createPairing("c".repeat(43));
    expect(() => store.createPairing("c".repeat(43))).toThrow(expect.objectContaining({ status: 503 }));
  });
});

describe("RelayStore 메시지", () => {
  it("폰이 보낸 봉투를 브라우저가 한 번만 받는다", async () => {
    const { store, pairing, joined } = await setup();
    store.push(pairing.channelId, joined.phoneToken, env);
    expect(store.drain(pairing.channelId, pairing.browserToken)).toEqual([env]);
    expect(store.drain(pairing.channelId, pairing.browserToken)).toEqual([]);
  });

  it("역할별 토큰을 구분한다 (브라우저 토큰으로 push 불가)", async () => {
    const { store, pairing, joined } = await setup();
    expect(() => store.push(pairing.channelId, pairing.browserToken, env)).toThrow(/토큰/);
    expect(() => store.drain(pairing.channelId, joined.phoneToken)).toThrow(/토큰/);
  });

  it("TTL이 지난 메시지는 전달하지 않는다", async () => {
    const { store, advance, pairing, joined } = await setup();
    store.push(pairing.channelId, joined.phoneToken, env);
    advance(DEFAULT_CONFIG.messageTtlMs + 1);
    expect(store.drain(pairing.channelId, pairing.browserToken)).toEqual([]);
  });

  it("큐 상한을 넘으면 429", async () => {
    const { store, pairing, joined } = await setup();
    for (let i = 0; i < DEFAULT_CONFIG.maxQueuedPerChannel; i++) store.push(pairing.channelId, joined.phoneToken, env);
    expect(() => store.push(pairing.channelId, joined.phoneToken, env)).toThrow(
      expect.objectContaining({ status: 429 }),
    );
  });

  it("revoke 후에는 채널을 쓸 수 없다", async () => {
    const { store, pairing, joined } = await setup();
    store.revoke(pairing.channelId, joined.phoneToken);
    expect(() => store.push(pairing.channelId, joined.phoneToken, env)).toThrow(RelayError);
  });
});
