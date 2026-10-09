/** content 공용 DOM 헬퍼 — 입력칸 찾기 (판단은 detect.ts 순수 함수) */
import { findSplitGroups, isOtpInput, type InputLike } from "./detect.js";

export type Target = { kind: "single"; el: HTMLInputElement } | { kind: "split"; els: HTMLInputElement[] };

export function toInputLike(el: HTMLInputElement): InputLike {
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

export function findTarget(): Target | null {
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
