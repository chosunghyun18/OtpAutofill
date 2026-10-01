import { describe, expect, it } from "vitest";
import { decideFill, hostMatches } from "../src/origin.js";

const now = 1_000_000;
const live = { expiresAt: now + 60_000, now };

describe("hostMatches", () => {
  it("정확히 같거나 하위 도메인만 일치", () => {
    expect(hostMatches("example.com", "example.com")).toBe(true);
    expect(hostMatches("login.example.com", "example.com")).toBe(true);
    expect(hostMatches("example.com.evil.io", "example.com")).toBe(false);
    expect(hostMatches("notexample.com", "example.com")).toBe(false);
  });
});

describe("decideFill", () => {
  it("origin-bound 코드는 일치하는 사이트에서만 허용", () => {
    expect(decideFill({ pageUrl: "https://www.example.com/login", boundOrigin: "example.com", ...live })).toMatchObject({
      allow: true,
      reason: "origin-match",
    });
    expect(decideFill({ pageUrl: "https://examp1e.com/login", boundOrigin: "example.com", ...live })).toEqual({
      allow: false,
      reason: "origin-mismatch",
    });
  });

  it("origin 정보가 없으면 클릭 필수로 허용", () => {
    expect(decideFill({ pageUrl: "https://nid.naver.com", ...live })).toEqual({
      allow: true,
      requiresClick: true,
      reason: "no-origin-hint",
    });
  });

  it("http 페이지는 거부, localhost는 개발용으로 허용", () => {
    expect(decideFill({ pageUrl: "http://example.com", ...live })).toMatchObject({ allow: false, reason: "insecure-context" });
    expect(decideFill({ pageUrl: "http://localhost:3000", ...live }).allow).toBe(true);
  });

  it("만료된 코드는 거부", () => {
    expect(decideFill({ pageUrl: "https://a.com", expiresAt: now, now })).toEqual({ allow: false, reason: "expired" });
  });
});
