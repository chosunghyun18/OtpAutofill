import { describe, expect, it } from "vitest";
import { badgeText, pairPhase, pinPeerKey } from "../src/pairing.js";

describe("pairPhase", () => {
  const now = 1_000;
  it("안전번호 확인 전에는 수신 단계(active)가 아니다", () => {
    expect(pairPhase({ paired: true, safetyNumber: "ABCD-1234" }, now)).toBe("needs-verify");
    expect(pairPhase({ paired: true, verified: false }, now)).toBe("needs-verify");
    expect(pairPhase({ paired: true, verified: true }, now)).toBe("active");
  });

  it("페어링 코드는 만료 전까지만 대기 상태", () => {
    expect(pairPhase({ paired: false, pairingCode: "ABCDEFGH", pairingExpiresAt: now + 1 }, now)).toBe("waiting-phone");
    expect(pairPhase({ paired: false, pairingCode: "ABCDEFGH", pairingExpiresAt: now }, now)).toBe("unpaired");
    expect(pairPhase({ paired: false }, now)).toBe("unpaired");
  });
});

describe("badgeText", () => {
  it("확인 대기 표시는 코드 유무에 덮이지 않는다", () => {
    expect(badgeText("needs-verify", true)).toBe("?");
    expect(badgeText("active", true)).toBe("OTP");
    expect(badgeText("active", false)).toBe("");
  });
});

describe("pinPeerKey", () => {
  it("처음 받은 폰 키를 고정하고, 재시도 때 다른 키면 거부", () => {
    expect(pinPeerKey(undefined, "P1")).toBe("pin");
    expect(pinPeerKey("P1", "P1")).toBe("same");
    expect(pinPeerKey("P1", "P2")).toBe("mismatch");
  });
});
