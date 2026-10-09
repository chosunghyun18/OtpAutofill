/** offscreen 문서 — 서비스 워커에는 navigator.clipboard가 없어 여기서 복사한다 (reason CLIPBOARD) */
import type { ExtMessage } from "./messages.js";

chrome.runtime.onMessage.addListener((msg: ExtMessage, _sender, sendResponse) => {
  if (msg.type !== "offscreen:copy") return;
  const ta = document.createElement("textarea");
  ta.value = msg.text;
  document.body.append(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  sendResponse({ ok });
});
