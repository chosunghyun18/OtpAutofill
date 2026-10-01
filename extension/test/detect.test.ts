import { describe, expect, it } from "vitest";
import { findSplitGroups, isOtpInput, scoreOtpInput, splitCode, type InputLike } from "../src/detect.js";

const input = (over: Partial<InputLike> = {}): InputLike => ({
  type: "text",
  autocomplete: "",
  name: "",
  id: "",
  className: "",
  placeholder: "",
  ariaLabel: "",
  inputMode: "",
  maxLength: -1,
  ...over,
});

describe("scoreOtpInput", () => {
  it("autocomplete=one-time-code는 확정", () => {
    expect(scoreOtpInput(input({ autocomplete: "one-time-code" }))).toBe(100);
  });

  it.each([
    { name: "otp" },
    { id: "verificationCode" },
    { placeholder: "인증번호 6자리" },
    { ariaLabel: "SMS code" },
    { name: "phoneVerifyCode", maxLength: 6 }, // phone이 있어도 인증 힌트가 있으면 OTP
  ])("이름/라벨 힌트로 탐지: %o", (over) => {
    expect(isOtpInput(input(over))).toBe(true);
  });

  it.each([
    { name: "phone", type: "tel", maxLength: 11 },
    { name: "email", type: "email" },
    { name: "cardNumber", inputMode: "numeric", maxLength: 16 },
    { placeholder: "휴대폰 번호" },
    { name: "zipcode", maxLength: 5 },
    { name: "username" },
    { type: "hidden", name: "otp" },
  ])("OTP가 아닌 칸은 제외: %o", (over) => {
    expect(isOtpInput(input(over))).toBe(false);
  });

  it("힌트 없이 maxLength·numeric만으로는 부족", () => {
    expect(isOtpInput(input({ maxLength: 6, inputMode: "numeric" }))).toBe(false);
  });
});

describe("findSplitGroups", () => {
  const cell = (groupKey: string, maxLength = 1, type = "text") => ({ groupKey, maxLength, type });

  it("같은 부모의 한 글자 칸 6개를 한 그룹으로", () => {
    const inputs = [cell("a", 30), ...Array.from({ length: 6 }, () => cell("b")), cell("c", 20)];
    expect(findSplitGroups(inputs)).toEqual([[1, 2, 3, 4, 5, 6]]);
  });

  it("3개 이하·9개 이상은 그룹이 아니다", () => {
    expect(findSplitGroups(Array.from({ length: 3 }, () => cell("x")))).toEqual([]);
    expect(findSplitGroups(Array.from({ length: 9 }, () => cell("x")))).toEqual([]);
  });

  it("부모가 다르면 끊는다", () => {
    const inputs = [...Array.from({ length: 4 }, () => cell("a")), ...Array.from({ length: 2 }, () => cell("b"))];
    expect(findSplitGroups(inputs)).toEqual([[0, 1, 2, 3]]);
  });
});

describe("splitCode", () => {
  it("칸 수와 길이가 같을 때만 분할", () => {
    expect(splitCode("123456", 6)).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(splitCode("1234", 6)).toBeNull();
  });
});
