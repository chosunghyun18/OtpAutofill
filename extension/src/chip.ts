/**
 * 입력칸 옆 "인증번호 입력" 칩 — 알림과 같은 동작을 하는 보조 진입점.
 * 코드 숫자는 표시하지 않고(●), closed shadow DOM에 그리며, isTrusted 클릭만 받는다.
 */
import type { Target } from "./dom.js";

let chipHost: HTMLElement | null = null;

export function removeChip() {
  chipHost?.remove();
  chipHost = null;
}

export function showChip(target: Target, length: number, onClick: () => void) {
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
  btn.addEventListener("click", (ev) => {
    if (!ev.isTrusted) return; // 페이지 스크립트의 합성 클릭 무시
    onClick();
  });
  root.append(btn);
  document.documentElement.append(chipHost);
}
