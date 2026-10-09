import { describe, expect, it, vi } from "vitest";
import {
  decodeMimeWords,
  extractBodies,
  GmailClient,
  GmailError,
  historyAfter,
  newMessagesFromHistory,
  subjectOf,
  withinLookback,
} from "../src/gmail.js";

const b64url = (s: string, enc: "utf8" | "latin1" = "utf8") => Buffer.from(s, enc).toString("base64url");

describe("history", () => {
  it("messagesAdded만, SENT·DRAFT 제외, 중복 제거, 레코드 historyId 유지", () => {
    const r = newMessagesFromHistory({
      history: [
        { id: "101", messagesAdded: [{ message: { id: "a", labelIds: ["INBOX", "UNREAD"] } }] },
        { id: "102", messagesAdded: [{ message: { id: "b", labelIds: ["SENT"] } }, { message: { id: "a" } }] },
        { id: "103", messagesAdded: [{ message: { id: "c", labelIds: ["SPAM"] } }] },
        { id: "104" },
      ],
      historyId: "104",
    });
    expect(r).toEqual([
      { id: "a", historyId: "101" },
      { id: "c", historyId: "103" },
    ]);
  });
  it("historyId는 64비트 문자열 비교", () => {
    expect(historyAfter("18446744073709551615", "18446744073709551614")).toBe(true);
    expect(historyAfter("9007199254740993", "9007199254740992")).toBe(true);
    expect(historyAfter("5", "5")).toBe(false);
    expect(historyAfter("x", "5")).toBe(false);
  });
  it("되돌아보기 창", () => {
    expect(withinLookback(String(1_000_000 - 60_000), 1_000_000)).toBe(true);
    expect(withinLookback(String(1_000_000 - 180_000), 1_000_000)).toBe(false);
    expect(withinLookback(undefined, 1_000_000)).toBe(false);
  });
});

describe("본문 디코딩", () => {
  it("multipart에서 text·html 첫 번째, 첨부 제외, charset 반영", () => {

    const payload = {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/plain", headers: [{ name: "Content-Type", value: 'text/plain; charset="UTF-8"' }], body: { data: b64url("인증번호 123456") } },
            { mimeType: "text/html", body: { data: b64url("<b>123456</b>") } },
          ],
        },
        { mimeType: "text/plain", filename: "a.txt", body: { attachmentId: "x" } },
      ],
    };
    expect(extractBodies(payload)).toEqual({ text: "인증번호 123456", html: "<b>123456</b>" });
  });
  it("latin1 charset", () => {
    const p = { mimeType: "text/plain", headers: [{ name: "Content-Type", value: "text/plain; charset=iso-8859-1" }], body: { data: b64url("café 1234", "latin1") } };
    expect(extractBodies(p).text).toBe("café 1234");
  });
  it("RFC 2047 제목", () => {
    expect(decodeMimeWords("=?UTF-8?B?" + Buffer.from("[에이크미] 인증번호").toString("base64") + "?= 482913")).toBe("[에이크미] 인증번호 482913");
    expect(decodeMimeWords("=?utf-8?Q?Your_code_=E2=80=94_1234?=")).toBe("Your code — 1234");
    expect(subjectOf({ id: "m", payload: { headers: [{ name: "Subject", value: "plain" }] } })).toBe("plain");
  });
});

describe("GmailClient", () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

  it("401이면 토큰을 버리고 한 번만 재시도", async () => {
    const tokens = ["old", "new"];
    const dropToken = vi.fn(async () => undefined);
    const fetch = vi.fn(async (_url: string, init?: RequestInit) =>
      (init!.headers as Record<string, string>).authorization === "Bearer new" ? json(200, { historyId: "7" }) : json(401, {}),
    );
    const c = new GmailClient({ fetch: fetch as unknown as typeof globalThis.fetch, base: "https://g", getToken: async () => tokens.shift()!, dropToken });
    expect(await c.historyId()).toBe("7");
    expect(dropToken).toHaveBeenCalledWith("old");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("두 번째도 401이면 GmailError(401)", async () => {
    const c = new GmailClient({ fetch: (async () => json(401, {})) as unknown as typeof fetch, base: "https://g", getToken: async () => "t", dropToken: async () => undefined });
    await expect(c.historyId()).rejects.toMatchObject({ status: 401 });
    await expect(c.historyId()).rejects.toBeInstanceOf(GmailError);
  });

  it("history 페이징과 커서 전진, metadata 파라미터", async () => {
    const urls: string[] = [];
    const fetch = (async (url: string) => {
      urls.push(url);
      if (url.includes("/history") && !url.includes("pageToken")) return json(200, { history: [{ id: "11", messagesAdded: [{ message: { id: "a" } }] }], nextPageToken: "p2", historyId: "12" });
      if (url.includes("/history")) return json(200, { history: [{ id: "12", messagesAdded: [{ message: { id: "b" } }] }], historyId: "13" });
      return json(200, { id: "a" });
    }) as unknown as typeof globalThis.fetch;
    const c = new GmailClient({ fetch, base: "https://g", getToken: async () => "t", dropToken: async () => undefined });
    expect(await c.newMessages("10")).toEqual({ messages: [{ id: "a", historyId: "11" }, { id: "b", historyId: "12" }], historyId: "13" });
    await c.metadata("a");
    const meta = new URL(urls.at(-1)!);
    expect(meta.searchParams.get("format")).toBe("metadata");
    expect(meta.searchParams.getAll("metadataHeaders")).toEqual(["From", "Subject", "Authentication-Results"]);
  });

  it("페이지 상한에 걸리면 커서는 읽은 마지막 레코드까지만", async () => {
    let n = 0;
    const fetch = (async () => {
      n++;
      return json(200, { history: [{ id: String(100 + n), messagesAdded: [{ message: { id: `m${n}` } }] }], nextPageToken: `p${n}`, historyId: "999" });
    }) as unknown as typeof globalThis.fetch;
    const c = new GmailClient({ fetch, base: "https://g", getToken: async () => "t", dropToken: async () => undefined });
    const r = await c.newMessages("100");
    expect(r.messages).toHaveLength(5);
    expect(r.historyId).toBe("105");
  });
});
