import { describe, expect, it } from "vitest";
import { detectService } from "../../src/v1/service.js";

describe("detectService", () => {
  it("국내 [Web발신] [서비스] 형식", () => {
    expect(detectService("[Web발신]\n[네이버] 인증번호 [123456]를 입력해주세요.")).toEqual({
      name: "네이버",
      domains: ["naver.com"],
    });
    expect(detectService("[Web발신] [카카오톡] 인증번호 123456")?.domains).toContain("kakao.com");
    expect(detectService("[국외발신] [Toss] 인증번호 123456")?.domains).toContain("toss.im");
  });

  it("영문 브랜드는 '<브랜드> verification code' 형태에서만 찾는다", () => {
    expect(detectService("G-123456 is your Google verification code.")?.domains).toContain("google.com");
    expect(detectService("Use 123456 as Microsoft account security code")?.domains).toContain("microsoftonline.com");
    expect(detectService("[Web발신] Apple Pay 결제 인증번호 123456")).toBeNull();
  });

  it("계열사 라벨·본인인증 문자·모르는 서비스는 null (정확히 일치만)", () => {
    expect(detectService("[Web발신] [카카오뱅크] 인증번호 [123456]")).toBeNull();
    expect(detectService("[Web발신] [네이버페이] 인증번호 [123456]")).toBeNull();
    expect(detectService("[Web발신] [SKT] 본인확인 인증번호 [123456]")).toBeNull();
    expect(detectService("Your Googleplex code is 123456")).toBeNull();
    expect(detectService("[Web발신] [모르는은행] 인증번호 [123456]")).toBeNull();
  });

  it("인증번호를 감싼 대괄호는 서비스로 보지 않는다", () => {
    expect(detectService("[Web발신] 인증번호 [482913] [쿠팡]")?.name).toBe("쿠팡");
  });
});
