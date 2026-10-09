import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { exportPublicKey, generateKeyPair } from "@otp-autofill/protocol";
import { clientKey, RateLimiter, rateLimitKey } from "../src/ratelimit.js";
import { createRelayServer } from "../src/server.js";
import { RelayStore } from "../src/store.js";

describe("RateLimiter", () => {
  it("윈도 안에서 한도까지만 허용하고, 윈도가 지나면 초기화", () => {
    let t = 0;
    const rl = new RateLimiter({ limit: 2, windowMs: 1000, maxKeys: 100 }, () => t);
    expect(rl.hit("a").ok).toBe(true);
    expect(rl.hit("a").ok).toBe(true);
    expect(rl.hit("a")).toEqual({ ok: false, retryAfterMs: 1000 });
    expect(rl.hit("b").ok).toBe(true); // 키별로 독립
    t = 1000;
    expect(rl.hit("a").ok).toBe(true);
  });

  it("sweep은 끝난 윈도만 지운다", () => {
    let t = 0;
    const rl = new RateLimiter({ limit: 1, windowMs: 1000, maxKeys: 100 }, () => t);
    rl.hit("a");
    t = 500;
    rl.hit("b");
    t = 1000;
    rl.sweep();
    expect(rl.size).toBe(1);
  });

  it("키 수 상한에 닿으면 가장 오래된 키를 버리고 새 키를 받는다 (새 사용자를 막지 않음)", () => {
    const rl = new RateLimiter({ limit: 5, windowMs: 1000, maxKeys: 2 }, () => 0);
    rl.hit("a");
    rl.hit("b");
    expect(rl.hit("c").ok).toBe(true);
    expect(rl.size).toBe(2);
  });
});

describe("rateLimitKey / clientKey", () => {
  it("IPv4-mapped는 IPv4로, IPv6는 /56으로 묶는다", () => {
    expect(rateLimitKey("::ffff:1.2.3.4")).toBe("1.2.3.4");
    expect(rateLimitKey("2001:db8:aa:bb:1::5")).toBe("2001:0db8:00aa:0000::/56");
    expect(rateLimitKey("2001:db8:aa:ff:1::5")).toBe("2001:0db8:00aa:0000::/56"); // 같은 /56
    expect(rateLimitKey("2001:db8:aa:1ff::")).toBe("2001:0db8:00aa:0100::/56");
    expect(rateLimitKey("::1")).toBe("0000:0000:0000:0000::/56");
    expect(rateLimitKey("not-an-ip")).toBeNull();
  });

  it("프록시 홉 수만큼 오른쪽에서 고르고, 이상한 값이면 소켓 주소로 폴백", () => {
    expect(clientKey("10.0.0.1", "6.6.6.6", 0)).toBe("10.0.0.1"); // 신뢰 안 함
    expect(clientKey("10.0.0.1", "1.1.1.1, 6.6.6.6", 1)).toBe("6.6.6.6");
    expect(clientKey("10.0.0.1", "1.1.1.1, 6.6.6.6, 172.16.0.9", 2)).toBe("6.6.6.6");
    expect(clientKey("10.0.0.1", ["1.1.1.1", "6.6.6.6"], 1)).toBe("6.6.6.6");
    expect(clientKey("10.0.0.1", "garbage", 1)).toBe("10.0.0.1");
    expect(clientKey("10.0.0.1", "6.6.6.6", 3)).toBe("10.0.0.1"); // 값이 부족
  });
});

describe("relay HTTP 레이트 리밋", () => {
  const server = createRelayServer(new RelayStore(), {
    pairingLimiter: new RateLimiter({ limit: 3, windowMs: 60_000, maxKeys: 100 }),
    trustedProxyHops: 1,
  });
  let base = "";
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const join = (code: string, xff: string, publicKey: string) =>
    fetch(`${base}/v1/pairings/${code}/join`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": xff },
      body: JSON.stringify({ publicKey }),
    });

  it("같은 IP의 join 시도가 한도를 넘으면 429 + retry-after(초)", async () => {
    const pk = await exportPublicKey((await generateKeyPair()).publicKey);
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await join("ABCDEFGH", "6.6.6.6", pk)).status);
    expect(statuses).toEqual([404, 404, 404, 429]);
    const res = await join("ABCDEFGH", "6.6.6.6", pk);
    expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
  });

  it("XFF 왼쪽 값을 바꿔도 우회할 수 없다", async () => {
    const pk = await exportPublicKey((await generateKeyPair()).publicKey);
    for (let i = 0; i < 3; i++) await join("ABCDEFGH", `1.1.1.${i}, 7.7.7.7`, pk);
    expect((await join("ABCDEFGH", "9.9.9.9, 7.7.7.7", pk)).status).toBe(429);
    expect((await join("ABCDEFGH", "9.9.9.9, 8.8.8.8", pk)).status).toBe(404);
  });

  it("join 한도와 페어링 생성 한도는 서로 깎지 않는다", async () => {
    const pk = await exportPublicKey((await generateKeyPair()).publicKey);
    for (let i = 0; i < 3; i++) await join("ABCDEFGH", "5.5.5.5", pk);
    const created = await fetch(`${base}/v1/pairings`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "5.5.5.5" },
      body: JSON.stringify({ commitment: "c".repeat(43) }),
    });
    expect(created.status).toBe(201);
  });
});
