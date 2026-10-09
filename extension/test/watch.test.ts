import { describe, expect, it } from "vitest";
import {
  actionsFor,
  matchSession,
  notificationText,
  planFill,
  pruneSessions,
  supersededBy,
  sweepItems,
  upsertSession,
  WATCH_MS,
  type Item,
  type Sessions,
} from "../src/watch.js";

const T0 = 1_700_000_000_000;

function sessionsWith(...ts: Array<{ tabId: number; url: string; hid: string; now: number }>): Sessions {
  let s: Sessions = {};
  for (const t of ts) s = upsertSession(s, { tabId: t.tabId, frameUrl: t.url, historyId: t.hid, now: t.now })!.sessions;
  return s;
}

describe("upsertSession", () => {
  it("https 사이트만, 재트리거는 연장하고 시작 historyId 유지, 프레임 사이트 추가", () => {
    const a = upsertSession({}, { tabId: 1, frameUrl: "https://www.acme.test/signup", historyId: "100", now: T0 })!;
    expect(a.created).toBe(true);
    const b = upsertSession(a.sessions, { tabId: 1, frameUrl: "https://login.vendor.test/", historyId: "150", now: T0 + 1000 })!;
    expect(b.created).toBe(false);
    expect(b.sessions[1]).toMatchObject({ sites: ["acme.test", "vendor.test"], startHistoryId: "100", startedAt: T0, expiresAt: T0 + 1000 + WATCH_MS });
    expect(upsertSession({}, { tabId: 1, frameUrl: "http://www.acme.test/", historyId: "1", now: T0 })).toBeNull();
    expect(upsertSession({}, { tabId: 1, frameUrl: "https://127.0.0.1/", historyId: "1", now: T0 })).toBeNull();
  });
  it("사용자 활성화 없는 트리거: 새 세션 없음, 기존 세션은 연장만 (사이트 추가 안 함)", () => {
    expect(upsertSession({}, { tabId: 1, frameUrl: "https://www.acme.test/", historyId: "1", now: T0, activated: false })).toBeNull();
    const s = sessionsWith({ tabId: 1, url: "https://www.acme.test", hid: "100", now: T0 });
    const r = upsertSession(s, { tabId: 1, frameUrl: "https://ads.evil.test/", historyId: "150", now: T0 + 1000, activated: false })!;
    expect(r.sessions[1]).toMatchObject({ sites: ["acme.test"], expiresAt: T0 + 1000 + WATCH_MS });
  });
  it("만료된 세션은 새로 시작", () => {
    const s = sessionsWith({ tabId: 1, url: "https://acme.test", hid: "100", now: T0 });
    const r = upsertSession(s, { tabId: 1, frameUrl: "https://acme.test", historyId: "200", now: T0 + WATCH_MS + 1 })!;
    expect(r.created).toBe(true);
    expect(r.sessions[1]!.startHistoryId).toBe("200");
    expect(pruneSessions(s, T0 + WATCH_MS)).toEqual({});
  });
});

describe("matchSession", () => {
  const s = sessionsWith(
    { tabId: 1, url: "https://www.acme.test", hid: "100", now: T0 },
    { tabId: 2, url: "https://shop.acme.test", hid: "110", now: T0 + 5000 },
    { tabId: 3, url: "https://other.test", hid: "120", now: T0 + 6000 },
  );
  it("사이트 일치 + 트리거 이후 + 가장 최근 트리거 탭", () => {
    expect(matchSession(s, "acme.test", { historyId: "111" }, T0 + 7000)?.tabId).toBe(2);
    expect(matchSession(s, "acme.test", { historyId: "105" }, T0 + 7000)?.tabId).toBe(1);
  });
  it("트리거 이전 메일·무관 사이트·만료는 null", () => {
    expect(matchSession(s, "acme.test", { historyId: "100" }, T0 + 7000)).toBeNull();
    expect(matchSession(s, "evil.test", { historyId: "999" }, T0 + 7000)).toBeNull();
    expect(matchSession(s, null, { historyId: "999" }, T0 + 7000)).toBeNull();
    expect(matchSession(s, "acme.test", { historyId: "999" }, T0 + 5000 + WATCH_MS)).toBeNull();
  });
  it("되돌아보기: 세션 시작 2분 전까지", () => {
    expect(matchSession(s, "other.test", { internalDate: String(T0 + 6000 - 60_000) }, T0 + 7000)?.tabId).toBe(3);
    expect(matchSession(s, "other.test", { internalDate: String(T0 + 6000 - 180_000) }, T0 + 7000)).toBeNull();
  });
});

const item = (o: Partial<Item> = {}): Item => ({
  id: "i1",
  kind: "code",
  value: "482913",
  claimedSite: "acme.test",
  authSite: "acme.test",
  tabId: 1,
  createdAt: T0,
  expiresAt: T0 + 600_000,
  ...o,
});

describe("아이템", () => {
  it("TTL 정리", () => {
    const r = sweepItems({ a: item({ id: "a" }), b: item({ id: "b", expiresAt: T0 }) }, T0);
    expect(Object.keys(r.items)).toEqual(["a"]);
    expect(r.expired).toEqual(["b"]);
  });
  it("같은 탭·종류의 이전 아이템을 대체", () => {
    const items = {
      a: item({ id: "a" }),
      b: item({ id: "b", kind: "link" }),
      c: item({ id: "c", tabId: 2 }),
      d: item({ id: "d", claimedSite: "evil.test" }),
    };
    expect(supersededBy(items, item({ id: "n" }))).toEqual(["a"]);
  });
});

describe("알림 문구·버튼", () => {
  it("인증된 코드형: [입력][복사], 마스킹 옵션", () => {
    expect(notificationText(item(), { mask: false })).toMatchObject({ title: "acme.test · 인증번호", message: "482913", buttons: ["입력", "복사"] });
    expect(notificationText(item(), { mask: true }).message).toBe("●●●●●●");
  });
  it("미인증: 경고 + 복사만", () => {
    const n = notificationText(item({ authSite: null }), { mask: false });
    expect(n.title.startsWith("⚠")).toBe(true);
    expect(n.buttons).toEqual(["복사"]);
    expect(actionsFor(item({ authSite: null, kind: "link" }))).toEqual(["copy"]);
  });
  it("링크형: 링크 도메인 표시, [열기][링크 복사]", () => {
    expect(notificationText(item({ kind: "link", value: "https://click.mailer.test/x" }), { mask: false })).toMatchObject({
      message: "링크: click.mailer.test",
      buttons: ["열기", "링크 복사"],
    });
  });
});

describe("planFill", () => {
  const now = T0 + 1000;
  const p = (frameId: number, url: string, hasInput = true) => ({ frameId, url, hasInput });
  it("정책 통과 프레임이 정확히 하나면 그 프레임 (크로스 오리진 같은 사이트 iframe)", () => {
    const r = planFill(item(), [p(0, "https://www.acme.test/", false), p(5, "https://login.acme.test/otp")], now);
    expect(r).toMatchObject({ kind: "fill", frame: { frameId: 5 } });
  });
  it("입력칸 있는 다른 사이트 프레임은 제외", () => {
    expect(planFill(item(), [p(0, "https://www.acme.test/"), p(3, "https://ads.evil.test/")], now)).toMatchObject({ kind: "fill", frame: { frameId: 0 } });
  });
  it("둘 이상 → 칩", () => {
    expect(planFill(item(), [p(0, "https://www.acme.test/"), p(3, "https://login.acme.test/")], now).kind).toBe("chip");
  });
  it("입력칸 있지만 사이트 불일치 → 복사 + 경고", () => {
    expect(planFill(item(), [p(0, "https://evil.test/")], now)).toMatchObject({ kind: "copy", warning: "site-mismatch" });
  });
  it("입력칸 없음 → 경고 없는 복사, 미인증 → unauthenticated", () => {
    expect(planFill(item(), [p(0, "https://www.acme.test/", false)], now)).toEqual({ kind: "copy" });
    expect(planFill(item({ authSite: null }), [p(0, "https://www.acme.test/")], now)).toMatchObject({ kind: "copy", warning: "unauthenticated" });
  });
  it("만료", () => {
    expect(planFill(item(), [p(0, "https://www.acme.test/")], T0 + 600_000)).toMatchObject({ kind: "copy", warning: "expired" });
  });
});
