import { describe, expect, it } from "vitest";
import { RelayError, RelayStore, DEFAULT_CONFIG } from "../src/store.js";

const PUB_B = "B".repeat(87);
const PUB_P = "P".repeat(87);
const env = { v: 1 as const, iv: "aXY", ct: "Y3Q" };

function setup() {
  let t = 1_000_000;
  const store = new RelayStore(DEFAULT_CONFIG, () => t);
  const advance = (ms: number) => (t += ms);
  const pairing = store.createPairing(PUB_B);
  const joined = store.joinPairing(pairing.pairingCode, PUB_P);
  return { store, advance, pairing, joined };
}

describe("RelayStore 페어링", () => {
  it("공개키를 교환하고 페어링 코드는 1회용이다", () => {
    const { store, pairing, joined } = setup();
    expect(joined.peerPublicKey).toBe(PUB_B);
    expect(store.pollPairing(pairing.pairingCode, pairing.browserToken)).toEqual({
      status: "joined",
      peerPublicKey: PUB_P,
    });
    // 브라우저가 수신한 뒤에는 코드가 사라진다
    expect(() => store.joinPairing(pairing.pairingCode, PUB_P)).toThrow(RelayError);
  });

  it("이미 join된 코드로 다시 join할 수 없다 (코드 탈취 대비)", () => {
    const { store, pairing } = setup();
    expect(() => store.joinPairing(pairing.pairingCode, "X".repeat(87))).toThrow(/이미 사용/);
  });

  it("만료된 페어링 코드는 거부한다", () => {
    let t = 0;
    const store = new RelayStore(DEFAULT_CONFIG, () => t);
    const p = store.createPairing(PUB_B);
    t += DEFAULT_CONFIG.pairingTtlMs + 1;
    expect(() => store.joinPairing(p.pairingCode, PUB_P)).toThrow(/만료/);
  });

  it("브라우저 토큰 없이 폰 공개키를 조회할 수 없다", () => {
    const { store, pairing } = setup();
    expect(() => store.pollPairing(pairing.pairingCode, "wrong")).toThrow(/토큰/);
  });
});

describe("RelayStore 메시지", () => {
  it("폰이 보낸 봉투를 브라우저가 한 번만 받는다", () => {
    const { store, pairing, joined } = setup();
    store.push(pairing.channelId, joined.phoneToken, env);
    expect(store.drain(pairing.channelId, pairing.browserToken)).toEqual([env]);
    expect(store.drain(pairing.channelId, pairing.browserToken)).toEqual([]);
  });

  it("역할별 토큰을 구분한다 (브라우저 토큰으로 push 불가)", () => {
    const { store, pairing, joined } = setup();
    expect(() => store.push(pairing.channelId, pairing.browserToken, env)).toThrow(/토큰/);
    expect(() => store.drain(pairing.channelId, joined.phoneToken)).toThrow(/토큰/);
  });

  it("TTL이 지난 메시지는 전달하지 않는다", () => {
    const { store, advance, pairing, joined } = setup();
    store.push(pairing.channelId, joined.phoneToken, env);
    advance(DEFAULT_CONFIG.messageTtlMs + 1);
    expect(store.drain(pairing.channelId, pairing.browserToken)).toEqual([]);
  });

  it("큐 상한을 넘으면 429", () => {
    const { store, pairing, joined } = setup();
    for (let i = 0; i < DEFAULT_CONFIG.maxQueuedPerChannel; i++) store.push(pairing.channelId, joined.phoneToken, env);
    expect(() => store.push(pairing.channelId, joined.phoneToken, env)).toThrow(
      expect.objectContaining({ status: 429 }),
    );
  });

  it("revoke 후에는 채널을 쓸 수 없다", () => {
    const { store, pairing, joined } = setup();
    store.revoke(pairing.channelId, joined.phoneToken);
    expect(() => store.push(pairing.channelId, joined.phoneToken, env)).toThrow(RelayError);
  });
});
