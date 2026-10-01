/**
 * Content script — OTP 입력칸을 찾고, 코드가 있으면 입력칸 옆에 "인증번호 입력" 칩을 띄운다.
 *
 * 보안 원칙
 * - 칩에는 코드 숫자를 표시하지 않는다(●●●●●●). 클릭 전에는 페이지 DOM에 코드가 존재하지 않는다.
 * - 클릭(isTrusted) 시에만 background에 코드를 요청(otp:take). 허용 여부는 background가 sender.url로 판단.
 * - 칩은 closed shadow DOM에 그린다.
 */
import { findSplitGroups, isOtpInput, splitCode, type InputLike } from "./detect.js";
import { fillSingle, fillSplit } from "./fill.js";
import type { ExtMessage, QueryResponse } from "./messages.js";

type Target = { kind: "single"; el: HTMLInputElement } | { kind: "split"; els: HTMLInputElement[] };

function toInputLike(el: HTMLInputElement): InputLike {
  return {
    type: el.type,
    autocomplete: el.getAttribute("autocomplete") ?? "",
    name: el.name,
    id: el.id,
    className: typeof el.className === "string" ? el.className : "",
    placeholder: el.placeholder,
    ariaLabel: el.getAttribute("aria-label") ?? "",
    inputMode: el.inputMode,
    maxLength: el.maxLength,
  };
}

const parentKeys = new WeakMap<Element, string>();
let keySeq = 0;
function groupKeyOf(el: HTMLInputElement): string {
  // 분할 입력칸은 보통 2단계 이내의 공통 조상 아래에 있다
  const anchor = el.parentElement?.parentElement ?? el.parentElement ?? document.body;
  let k = parentKeys.get(anchor);
  if (!k) parentKeys.set(anchor, (k = String(keySeq++)));
  return k;
}

function isVisible(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
}

function findTarget(): Target | null {
  const inputs = Array.from(document.querySelectorAll<HTMLInputElement>("input")).filter(
    (el) => !el.disabled && !el.readOnly && isVisible(el),
  );
  const single = inputs.find((el) => isOtpInput(toInputLike(el)));
  if (single) return { kind: "single", el: single };
  const groups = findSplitGroups(
    inputs.map((el) => ({ maxLength: el.maxLength, type: el.type, groupKey: groupKeyOf(el) })),
  );
  const g = groups[0];
  return g ? { kind: "split", els: g.map((i) => inputs[i]!) } : null;
}

const send = <T>(msg: ExtMessage) => chrome.runtime.sendMessage(msg) as Promise<T>;

let chipHost: HTMLElement | null = null;
function removeChip() {
  chipHost?.remove();
  chipHost = null;
}

function showChip(target: Target, length: number) {
  removeChip();
  const anchor = target.kind === "single" ? target.el : target.els[0]!;
  const rect = anchor.getBoundingClientRect();
  chipHost = document.createElement("div");
  Object.assign(chipHost.style, {
    position: "fixed",
    top: `${Math.max(0, rect.top - 34)}px`,
    left: `${rect.left}px`,
    zIndex: "2147483647",
  });
  const root = chipHost.attachShadow({ mode: "closed" });
  const btn = document.createElement("button");
  btn.textContent = `인증번호 입력 (${"●".repeat(length)}) · ${location.hostname}`;
  btn.setAttribute(
    "style",
    "font:12px system-ui;padding:4px 10px;border-radius:14px;border:1px solid #888;background:#fff;color:#111;cursor:pointer",
  );
  btn.addEventListener("click", async (ev) => {
    if (!ev.isTrusted) return; // 페이지 스크립트의 합성 클릭 무시
    const res = await send<QueryResponse & { code?: string }>({ type: "otp:take" });
    removeChip();
    if (!res.code) return;
    if (target.kind === "single") fillSingle(target.el, res.code);
    else {
      const digits = splitCode(res.code, target.els.length);
      if (digits) fillSplit(target.els, digits);
    }
  });
  root.append(btn);
  document.documentElement.append(chipHost);
}

async function refresh() {
  const target = findTarget();
  if (!target) return removeChip();
  const res = await send<QueryResponse>({ type: "otp:query" });
  if (!res?.decision?.allow || !res.length) {
    if (res?.decision && !res.decision.allow && res.decision.reason === "origin-mismatch") {
      console.warn("[OTP Autofill] 이 사이트는 문자에 명시된 도메인과 다릅니다. 입력을 차단했습니다.");
    }
    return removeChip();
  }
  showChip(target, res.length);
}

chrome.runtime.onMessage.addListener((msg: ExtMessage) => {
  if (msg.type === "otp:available") void refresh();
});
document.addEventListener("focusin", (e) => {
  if (e.target instanceof HTMLInputElement) void refresh();
});
void refresh();
