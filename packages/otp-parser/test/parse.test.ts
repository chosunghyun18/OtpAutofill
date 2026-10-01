import { describe, expect, it } from "vitest";
import { parseOriginBound, parseOtp } from "../src/index.js";

describe("parseOtp — 한국어 SMS", () => {
  const cases: Array<[string, string]> = [
    ["[Web발신] 인증번호 [123456]를 입력해주세요", "123456"],
    ["[Web발신]\n[네이버] 인증번호 [384920]를 입력해주세요.", "384920"],
    ["[카카오] 인증번호는 7731 입니다. 타인에게 절대 알려주지 마세요.", "7731"],
    ["본인확인 인증번호(918273)입력시 정상처리 됩니다.", "918273"],
    ["[토스] 인증번호 482913 (유효시간 3분)", "482913"],
    ["482913은 쿠팡 로그인 인증번호입니다.", "482913"],
    ["[KB국민은행] 인증번호[5521]를 입력해 주세요. 문의 1588-9999", "5521"],
    ["[Web발신] 승인번호 20481934 결제 진행", "20481934"],
  ];
  it.each(cases)("%s → %s", (text, expected) => {
    expect(parseOtp(text)?.code).toBe(expected);
  });
});

describe("parseOtp — 영어 SMS", () => {
  const cases: Array<[string, string]> = [
    ["Your verification code is 482913", "482913"],
    ["G-529384 is your Google verification code.", "529384"],
    ["Use 1234 as your login code for Example. Don't share it.", "1234"],
    ["Your one-time passcode: 70921833. It expires in 10 minutes.", "70921833"],
    ["Amazon: Your OTP is 661204. Do not share it with anyone.", "661204"],
  ];
  it.each(cases)("%s → %s", (text, expected) => {
    expect(parseOtp(text)?.code).toBe(expected);
  });
});

describe("parseOtp — 코드가 아닌 숫자 제외", () => {
  it("금액은 무시한다", () => {
    expect(parseOtp("[Web발신] 인증번호 [604213] 결제금액 15000원")?.code).toBe("604213");
    expect(parseOtp("Your code is 3829. Charged $1500 today.")?.code).toBe("3829");
  });

  it("천단위 구분 금액을 코드로 보지 않는다", () => {
    expect(parseOtp("인증번호 발송: 결제금액 12,000원")).toBeNull();
  });

  it("전화번호를 코드로 보지 않는다", () => {
    expect(parseOtp("인증번호 문의는 010-1234-5678 또는 1588-1234로 연락주세요")).toBeNull();
    expect(parseOtp("인증번호 [887766] 발신번호 01012345678")?.code).toBe("887766");
  });

  it("날짜·시각을 코드로 보지 않는다", () => {
    expect(parseOtp("인증번호 유효기간 2026-10-01 12:30")).toBeNull();
    expect(parseOtp("2026.10.01 인증번호 [445566] 발송")?.code).toBe("445566");
  });

  it("카드 끝자리를 코드로 보지 않는다", () => {
    expect(parseOtp("[신한카드] 승인번호 77881234 신한카드(1234) 12,000원 일시불")?.code).toBe("77881234");
  });

  it("유효시간 등 단위가 붙은 숫자를 무시한다", () => {
    expect(parseOtp("인증번호는 5분 이내 1000회까지 유효")).toBeNull();
  });
});

describe("parseOtp — 키워드 없는 문자", () => {
  it("인증 키워드가 없으면 null (광고·배송 문자 오탐 방지)", () => {
    expect(parseOtp("[Web발신] 주문하신 상품 123456 이 배송 시작되었습니다")).toBeNull();
    expect(parseOtp("오늘 저녁 7시 1234호 회의실")).toBeNull();
    expect(parseOtp("")).toBeNull();
  });
});

describe("parseOriginBound — WebOTP 형식", () => {
  it("마지막 줄의 @origin #code를 우선한다", () => {
    const sms = "Your Example code is 123456.\n\n@example.com #123456";
    expect(parseOriginBound(sms)).toEqual({ origin: "example.com", code: "123456" });
    expect(parseOtp(sms)).toMatchObject({ code: "123456", origin: "example.com" });
  });

  it("임베드 형식(@top #code @iframe)도 허용한다", () => {
    expect(parseOriginBound("code\n@shop.example.com #9911 @pay.example.net")).toEqual({
      origin: "shop.example.com",
      code: "9911",
    });
  });

  it("형식이 아니면 null", () => {
    expect(parseOriginBound("email me @ example #123")).toBeNull();
  });
});
