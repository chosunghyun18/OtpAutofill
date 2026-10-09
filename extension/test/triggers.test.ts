import { describe, expect, it } from "vitest";
import { hasVerifySentText, isEmailField, shouldSend } from "../src/triggers.js";

const f = (o: Partial<{ type: string; name: string; id: string; autocomplete: string; placeholder: string }>) => ({
  type: "text",
  name: "",
  id: "",
  autocomplete: "",
  placeholder: "",
  ...o,
});

describe("isEmailField", () => {
  it("type·autocomplete·이름 힌트", () => {
    expect(isEmailField(f({ type: "email" }))).toBe(true);
    expect(isEmailField(f({ autocomplete: "username email" }))).toBe(true);
    expect(isEmailField(f({ name: "userEmail" }))).toBe(true);
    expect(isEmailField(f({ placeholder: "이메일 주소" }))).toBe(true);
    expect(isEmailField(f({ name: "nickname" }))).toBe(false);
    expect(isEmailField(f({ type: "hidden", name: "email" }))).toBe(false);
  });
});

describe("hasVerifySentText", () => {
  it.each([
    "입력하신 이메일로 인증 메일을 발송했습니다.",
    "인증번호를 메일로 보냈습니다",
    "이메일로 인증 링크를 보내 드렸습니다. 메일함을 확인해 주세요",
    "Verify your email",
    "Check your inbox",
    "We've sent a 6-digit code to a***@example.com",
    "A verification code has been sent to your email.",
  ])("감지: %s", (t) => expect(hasVerifySentText(t)).toBe(true));
  it.each(["회원가입", "비밀번호를 입력하세요", "Sign in to continue", "메일 주소를 입력하세요"])("무시: %s", (t) =>
    expect(hasVerifySentText(t)).toBe(false),
  );
});

describe("shouldSend", () => {
  it("이유별 30초 쿨다운", () => {
    expect(shouldSend({}, "form", 0)).toBe(true);
    expect(shouldSend({ form: 0 }, "form", 29_999)).toBe(false);
    expect(shouldSend({ form: 0 }, "form", 30_000)).toBe(true);
    expect(shouldSend({ form: 0 }, "text", 1)).toBe(true);
  });
});
