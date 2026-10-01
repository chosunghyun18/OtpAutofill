/** 실제 DOM 입력 — React/Vue 등 프레임워크가 감지하도록 네이티브 setter + 이벤트 발생 */
const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;

export function setInputValue(el: HTMLInputElement, value: string) {
  el.focus();
  nativeSetter ? nativeSetter.call(el, value) : (el.value = value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

export function fillSingle(el: HTMLInputElement, code: string) {
  setInputValue(el, code);
}

export function fillSplit(els: HTMLInputElement[], digits: string[]) {
  els.forEach((el, i) => setInputValue(el, digits[i] ?? ""));
  els[els.length - 1]?.blur();
}
