/**
 * Content script (v2) — 감시 트리거 감지, 입력칸 probe, background 지시에 따른 입력, 칩.
 *
 * 보안 원칙
 * - 입력 허용 판단은 background가 sender.url로 한다. 여기서는 지시받은 origin과 지금 문서가 같을 때만 입력한다.
 * - 클릭 전 페이지 DOM에 코드를 넣지 않는다. 칩은 ●만 표시하고 isTrusted 클릭만 받는다.
 * - 사용자 활성화가 없는 트리거는 기존 세션 연장만 한다(페이지가 감시를 마음대로 켜지 못하게) — background가 판단.
 */
import { splitCode } from "./detect.js";
import { findTarget, type Target } from "./dom.js";
import { fillSingle, fillSplit } from "./fill.js";
import { removeChip, showChip } from "./chip.js";
import type { ExtMessage } from "./messages.js";
import { hasVerifySentText, isEmailField, shouldSend } from "./triggers.js";
import type { TriggerReason } from "./watch.js";

const send = <T>(msg: ExtMessage) => chrome.runtime.sendMessage(msg) as Promise<T>;

function fill(target: Target, code: string): boolean {
  quietUntil = Date.now() + 60_000;
  if (target.kind === "single") {
    fillSingle(target.el, code);
    return true;
  }
  const digits = splitCode(code, target.els.length);
  if (!digits) return false;
  fillSplit(target.els, digits);
  return true;
}

// ---------- 트리거 ----------

const lastSent: Partial<Record<TriggerReason, number>> = {};
/** 입력 직후에는 트리거하지 않는다 (입력하며 생긴 포커스·DOM 변화로 감시가 다시 켜지지 않게) */
let quietUntil = 0;

function trigger(reason: TriggerReason) {
  const now = Date.now();
  if (now < quietUntil && reason !== "manual") return;
  if (reason !== "manual" && !shouldSend(lastSent, reason, now)) return;
  lastSent[reason] = now;
  const activated = reason === "manual" || (navigator.userActivation?.hasBeenActive ?? false);
  send({ type: "watch:start", reason, activated }).catch(() => undefined);
}

function hasEmailField(root: ParentNode, filledOnly = false): boolean {
  return Array.from(root.querySelectorAll<HTMLInputElement>("input")).some(
    (el) =>
      (!filledOnly || el.value.includes("@")) &&
      isEmailField({
        type: el.type,
        name: el.name,
        id: el.id,
        autocomplete: el.getAttribute("autocomplete") ?? "",
        placeholder: el.placeholder,
      }),
  );
}

// 이메일 입력칸이 있는 폼 제출
document.addEventListener(
  "submit",
  (e) => {
    if (e.target instanceof HTMLFormElement && hasEmailField(e.target)) trigger("form");
  },
  true,
);
// submit 이벤트 없이 버튼으로 보내는 SPA — 버튼이 속한 폼에 이메일 칸이 있거나, 폼이 없으면 값이 채워진 이메일 칸이 있을 때
document.addEventListener(
  "click",
  (e) => {
    if (!e.isTrusted || !(e.target instanceof Element)) return;
    const btn = e.target.closest("button, input[type=submit], [role=button]");
    if (!btn) return;
    const form = btn.closest("form");
    if (form ? hasEmailField(form) : hasEmailField(document, true)) trigger("form");
  },
  true,
);

// 인증번호 입력칸 등장 · "인증 메일을 보냈습니다" 문구 — DOM 변화를 묶어서 본다
let scanTimer: ReturnType<typeof setTimeout> | undefined;
function scan() {
  scanTimer = undefined;
  if (findTarget()) trigger("input");
  const text = document.body?.innerText?.slice(0, 50_000) ?? "";
  if (hasVerifySentText(text)) trigger("text");
}
new MutationObserver(() => {
  scanTimer ??= setTimeout(scan, 500);
}).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
scan();

// ---------- 칩 ----------

async function chipIfReady() {
  const target = findTarget();
  if (!target) return removeChip();
  const res = await send<{ length?: number } | null>({ type: "otp:query" }).catch(() => null);
  if (!res?.length) return removeChip();
  showChipFor(target, res.length);
}

function showChipFor(target: Target, length: number) {
  showChip(target, length, async () => {
    const res = await send<{ code?: string }>({ type: "otp:take" }).catch(() => null);
    removeChip();
    if (res?.code) fill(target, res.code);
  });
}

document.addEventListener("focusin", (e) => {
  if (!(e.target instanceof HTMLInputElement) || !e.isTrusted) return;
  const target = findTarget();
  if (!target) return;
  const els = target.kind === "single" ? [target.el] : target.els;
  if (!els.includes(e.target)) return;
  // 입력칸 포커스: 감시 시작/연장 + 즉시 1회 조회, 대기 코드가 있으면 칩
  trigger("focus");
  void chipIfReady();
});

// ---------- background 지시 ----------

chrome.runtime.onMessage.addListener((msg: ExtMessage, _sender, sendResponse) => {
  switch (msg.type) {
    case "fill:probe":
      send({ type: "fill:probe-reply", nonce: msg.nonce, hasInput: findTarget() !== null }).catch(() => undefined);
      return;
    case "fill:code": {
      // 확인 이후 프레임이 다른 문서로 바뀌었으면 입력하지 않는다
      const target = location.origin === msg.origin ? findTarget() : null;
      const filled = target ? fill(target, msg.code) : false;
      if (filled) removeChip();
      sendResponse({ filled });
      return;
    }
    case "chip:show": {
      const target = findTarget();
      if (target) showChipFor(target, msg.length);
      return;
    }
    case "otp:available":
      void chipIfReady();
      return;
    case "watch:ask":
      if (window === window.top) trigger("manual");
      return;
  }
});
