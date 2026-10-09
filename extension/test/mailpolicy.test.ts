import { describe, expect, it } from "vitest";
import { decideMail, fromDomain, parseAuthResults, senderInfo, siteOf, type MailHeader } from "../src/mailpolicy.js";

const GMAIL_AR =
  "mx.google.com; dkim=pass header.i=@acme.test header.s=s1 header.b=AbC; " +
  "spf=pass (google.com: domain of bounce@sendgrid.test designates 1.2.3.4 as permitted sender) smtp.mailfrom=bounce@sendgrid.test; " +
  "dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=acme.test";

const h = (...pairs: Array<[string, string]>): MailHeader[] => pairs.map(([name, value]) => ({ name, value }));

describe("siteOf", () => {
  it("eTLD+1, co.kr, private 도메인, 알 수 없는 TLD", () => {
    expect(siteOf("www.acme.com")).toBe("acme.com");
    expect(siteOf("nid.naver.co.kr")).toBe("naver.co.kr");
    expect(siteOf("alice.github.io")).toBe("alice.github.io");
    expect(siteOf("bob.github.io")).not.toBe(siteOf("alice.github.io"));
    expect(siteOf("login.acme.test")).toBe("acme.test");
  });
  it("IP·localhost는 null", () => {
    expect(siteOf("127.0.0.1")).toBeNull();
    expect(siteOf("localhost")).toBeNull();
  });
});

describe("fromDomain", () => {
  it("표시 이름에 주소를 넣은 위장은 꺾쇠 안 주소를 쓴다", () => {
    expect(fromDomain('"no-reply@acme.test" <evil@evil.test>')).toBe("evil.test");
    expect(fromDomain("Acme <No-Reply@Mail.Acme.Test>")).toBe("mail.acme.test");
    expect(fromDomain("no-reply@acme.test")).toBe("acme.test");
  });
  it("여러 주소·형식 오류는 null", () => {
    expect(fromDomain("a@acme.test, b@evil.test")).toBeNull();
    expect(fromDomain("<a@acme.test> <b@evil.test>")).toBeNull();
    expect(fromDomain("nobody")).toBeNull();
  });
});

describe("parseAuthResults", () => {
  it("주석을 지우고 메서드·결과·속성을 읽는다", () => {
    const r = parseAuthResults(GMAIL_AR);
    expect(r.authservId).toBe("mx.google.com");
    expect(r.results.map((x) => `${x.method}=${x.result}`)).toEqual(["dkim=pass", "spf=pass", "dmarc=pass"]);
    expect(r.results[2]!.props["header.from"]).toBe("acme.test");
  });
});

describe("senderInfo", () => {
  it("DMARC pass + header.from 일치 → 인증", () => {
    expect(senderInfo(h(["Authentication-Results", GMAIL_AR], ["From", "Acme <no-reply@acme.test>"]))).toEqual({
      claimedSite: "acme.test",
      authSite: "acme.test",
    });
  });

  it("DMARC 없이 From과 정렬된 DKIM pass → 인증 (하위 도메인 발신)", () => {
    const ar = "mx.google.com; dkim=pass header.d=acme.test header.s=k1";
    expect(senderInfo(h(["Authentication-Results", ar], ["From", "x@mail.acme.test"])).authSite).toBe("acme.test");
  });

  it("SPF 단독 pass는 인증 아님", () => {
    const ar = "mx.google.com; spf=pass smtp.mailfrom=acme.test";
    expect(senderInfo(h(["Authentication-Results", ar], ["From", "x@acme.test"])).authSite).toBeNull();
  });

  it("DKIM이 대행사 도메인이면(정렬 안 됨) 인증 아님", () => {
    const ar = "mx.google.com; dkim=pass header.i=@sendgrid.test; dmarc=fail header.from=acme.test";
    expect(senderInfo(h(["Authentication-Results", ar], ["From", "x@acme.test"]))).toEqual({
      claimedSite: "acme.test",
      authSite: null,
    });
  });

  it("dmarc pass라도 header.from이 From과 다르면 인증 아님", () => {
    const ar = "mx.google.com; dmarc=pass header.from=evil.test";
    expect(senderInfo(h(["Authentication-Results", ar], ["From", "x@acme.test"])).authSite).toBeNull();
  });

  it("위조: 맨 위가 fail이면 아래쪽에 넣은 가짜 pass 헤더는 무시", () => {
    const headers = h(
      ["Authentication-Results", "mx.google.com; dkim=none; spf=softfail smtp.mailfrom=evil.test; dmarc=fail header.from=acme.test"],
      ["From", "x@acme.test"],
      ["Authentication-Results", GMAIL_AR],
    );
    expect(senderInfo(headers).authSite).toBeNull();
  });

  it("위조: 맨 위 authserv-id가 mx.google.com이 아니면 미인증", () => {
    const fake = GMAIL_AR.replace("mx.google.com", "mx.google.com.evil.test");
    expect(senderInfo(h(["Authentication-Results", fake], ["From", "x@acme.test"])).authSite).toBeNull();
    expect(senderInfo(h(["From", "x@acme.test"])).authSite).toBeNull();
  });

  it("위조: 순서가 뒤집혀도(가짜 pass가 위) 다른 mx.google.com 결과가 fail이면 미인증", () => {
    const headers = h(
      ["Authentication-Results", GMAIL_AR],
      ["From", "x@acme.test"],
      ["Authentication-Results", "mx.google.com; dkim=none; dmarc=fail header.from=acme.test"],
    );
    expect(senderInfo(headers).authSite).toBeNull();
  });

  it("다른 서버의 결과는 판정에 섞지 않는다", () => {
    const headers = h(["Authentication-Results", GMAIL_AR], ["Authentication-Results", "mx.other.test; dmarc=fail"], ["From", "x@acme.test"]);
    expect(senderInfo(headers).authSite).toBe("acme.test");
  });

  it("무료 메일 도메인은 DMARC pass여도 입력 불가", () => {
    const ar = "mx.google.com; dkim=pass header.i=@gmail.com; dmarc=pass header.from=gmail.com";
    expect(senderInfo(h(["Authentication-Results", ar], ["From", "anyone@gmail.com"]))).toEqual({
      claimedSite: "gmail.com",
      authSite: null,
    });
  });

  it("From 헤더가 둘이면 미인증·무매칭", () => {
    expect(senderInfo(h(["Authentication-Results", GMAIL_AR], ["From", "x@acme.test"], ["From", "y@evil.test"]))).toEqual({
      claimedSite: null,
      authSite: null,
    });
  });
});

describe("decideMail", () => {
  const live = { now: 1000, expiresAt: 2000 };
  it("코드: 인증된 From 사이트 == 프레임 사이트 && https → fill", () => {
    expect(decideMail({ kind: "code", authSite: "acme.test", targetUrl: "https://login.acme.test/x", ...live })).toEqual({ action: "fill" });
  });
  it("코드: 사이트 불일치·http·미인증 → copy + 경고", () => {
    expect(decideMail({ kind: "code", authSite: "acme.test", targetUrl: "https://acme-login.test/", ...live })).toEqual({
      action: "copy",
      warning: "site-mismatch",
    });
    expect(decideMail({ kind: "code", authSite: "acme.test", targetUrl: "http://www.acme.test/", ...live })).toEqual({
      action: "copy",
      warning: "insecure",
    });
    expect(decideMail({ kind: "code", authSite: null, targetUrl: "https://www.acme.test/", ...live })).toEqual({
      action: "copy",
      warning: "unauthenticated",
    });
  });
  it("코드: 대상 없음 → copy", () => {
    expect(decideMail({ kind: "code", authSite: "acme.test", ...live }).action).toBe("copy");
  });
  it("링크: 인증된 From이면 추적 도메인 링크도 open, http면 copy", () => {
    expect(decideMail({ kind: "link", authSite: "acme.test", targetUrl: "https://click.sendgrid.test/a", ...live })).toEqual({ action: "open" });
    expect(decideMail({ kind: "link", authSite: "acme.test", targetUrl: "http://acme.test/v", ...live }).action).toBe("copy");
    expect(decideMail({ kind: "link", authSite: null, targetUrl: "https://acme.test/v", ...live }).action).toBe("copy");
  });
  it("만료 → none", () => {
    expect(decideMail({ kind: "code", authSite: "acme.test", targetUrl: "https://acme.test", now: 2000, expiresAt: 2000 })).toEqual({
      action: "none",
      warning: "expired",
    });
  });
});
