import { describe, expect, it } from "vitest";
import { decodeEntities, findVerifyLink, htmlToText, parseEmail, trimSnippet } from "../src/index.js";

describe("parseEmail — 제목·본문 코드", () => {
  it("제목에 코드가 있으면 제목에서", () => {
    expect(parseEmail({ subject: "[Acme] 인증번호 482913", text: "문의 02-123-4567" })).toEqual({ kind: "code", code: "482913" });
    expect(parseEmail({ subject: "482913 is your Slack confirmation code" })).toEqual({ kind: "code", code: "482913" });
  });

  it("본문 텍스트", () => {
    const text = "안녕하세요.\n회원가입을 위한 이메일 인증번호는 [730215] 입니다.\n유효시간 10분\n(주)에이크미 서울시 강남구 테헤란로 123";
    expect(parseEmail({ subject: "Acme 회원가입 안내", text })).toEqual({ kind: "code", code: "730215" });
  });

  it("HTML 표 안의 단독 코드 (인증 문구 있을 때만)", () => {
    const html = `<html><head><style>.c{font-size:32px}</style></head><body>
      <table><tr><td>Verify your email address</td></tr>
      <tr><td>Enter the following to finish signing up:</td></tr>
      <tr><td class=c><b>5 1 8 2 7 4</b></td></tr><tr><td class=c>518274</td></tr>
      <tr><td>© 2026 Acme Inc. 1 Market St, San Francisco 94105</td></tr></table></body></html>`;
    expect(parseEmail({ subject: "Confirm your account", html })).toEqual({ kind: "code", code: "518274" });
  });

  it("인증 문구가 없는 메일의 단독 숫자는 받지 않는다", () => {
    expect(parseEmail({ subject: "주간 소식", text: "이번 주 방문자\n48213\n감사합니다" })).toBeNull();
  });

  it("금액·전화번호·날짜·연도는 코드가 아니다", () => {
    expect(parseEmail({ subject: "주문 안내", text: "결제금액 12000원, 문의 1588-1234, 2026.10.09" })).toBeNull();
    expect(parseEmail({ subject: "Verify your email", text: "Thanks!\n2026\n" })).toBeNull();
  });

  it("코드와 링크가 다 있으면 코드 우선", () => {
    const html = `<p>인증번호: <b>662019</b></p><a href="https://acme.test/verify?t=abc">이메일 인증하기</a>`;
    expect(parseEmail({ subject: "이메일 인증", html })).toEqual({ kind: "code", code: "662019" });
  });

  it("HTML 엔티티", () => {
    expect(parseEmail({ subject: "Your code&#58; 120934", text: "" })).toEqual({ kind: "code", code: "120934" });
  });
});

describe("parseEmail — 인증 링크", () => {
  it("앵커 텍스트로 인증 링크를 고르고 수신거부·약관은 뺀다", () => {
    const html = `<a href="https://acme.test/terms">약관</a>
      <a href="https://click.mailer.test/ls/click?upn=x&amp;y=1">이메일 인증하기</a>
      <a href="https://acme.test/unsubscribe?u=1">수신거부</a>`;
    expect(parseEmail({ subject: "Acme 가입을 환영합니다", html })).toEqual({
      kind: "link",
      url: "https://click.mailer.test/ls/click?upn=x&y=1",
    });
  });

  it("http 링크는 받지 않는다", () => {
    expect(findVerifyLink({ html: `<a href="http://acme.test/verify">Verify email</a>` })).toBeNull();
  });

  it("텍스트 본문의 링크", () => {
    const text = "Please confirm your email:\nhttps://acme.test/confirm/abc123\nUnsubscribe: https://acme.test/unsubscribe";
    expect(parseEmail({ subject: "Welcome", text })).toEqual({ kind: "link", url: "https://acme.test/confirm/abc123" });
  });

  it("인증과 무관한 링크만 있으면 null", () => {
    expect(parseEmail({ subject: "뉴스레터", html: `<a href="https://acme.test/blog">블로그</a>` })).toBeNull();
  });
});

describe("유틸", () => {
  it("htmlToText는 블록을 줄로 나누고 head/style/script를 버린다", () => {
    expect(htmlToText("<head><title>x 999999</title></head><div>a</div><script>var c=123456</script><p>b&nbsp;c</p>")).toBe("a\nb c");
  });
  it("decodeEntities", () => {
    expect(decodeEntities("&lt;a&gt; &amp; &#x41;&#66; &unknown;")).toBe("<a> & AB &unknown;");
  });
  it("trimSnippet은 잘린 마지막 토큰을 버린다", () => {
    const long = "인증번호 안내 ".repeat(20) + "코드 48291";
    expect(trimSnippet(long).endsWith("48291")).toBe(false);
    expect(trimSnippet("인증번호 482913")).toBe("인증번호 482913");
  });
});
