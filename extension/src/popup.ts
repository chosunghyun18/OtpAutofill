/** 팝업 (v2) — Gmail 연결·해제, 최근 항목·복사, 지금 확인, 알림 안내, 마스킹 옵션 */
import type { ExtMessage, PopupState } from "./messages.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const send = <T>(msg: ExtMessage) => chrome.runtime.sendMessage(msg) as Promise<T>;

async function render() {
  const s = await send<PopupState>({ type: "popup:state" });
  const status = $("status");
  status.className = s.authError ? "warn" : "muted";
  status.textContent = !s.connected
    ? "Gmail이 연결되지 않았습니다."
    : s.authError
      ? "Gmail 권한이 만료됐습니다. 다시 연결하세요."
      : `Gmail 연결됨${s.watching ? ` · ${s.watching}개 탭 감시 중` : ""}`;
  $("connect").hidden = s.connected && !s.authError;
  $("disconnect").hidden = !s.connected;
  $("check").hidden = !s.connected;
  $<HTMLInputElement>("mask").checked = s.mask;

  const ul = $("items");
  ul.replaceChildren(
    ...s.items.map((it) => {
      const li = document.createElement("li");
      li.dataset.id = it.id;
      const head = document.createElement("div");
      const left = Math.max(0, Math.round((it.expiresAt - Date.now()) / 1000));
      head.className = it.authenticated ? "muted" : "warn";
      head.textContent = `${it.authenticated ? "" : "⚠ 발신 미확인 · "}${it.site} · ${Math.ceil(left / 60)}분 남음`;
      const body = document.createElement("div");
      body.className = it.kind === "code" ? "code" : "link";
      // 마스킹 옵션이면 팝업에서도 코드를 가린다 (복사는 그대로)
      body.textContent = it.kind === "code" && s.mask ? "●".repeat(it.value.length) : it.value;
      const copy = document.createElement("button");
      copy.textContent = it.kind === "code" ? "복사" : "링크 복사";
      copy.onclick = () => void navigator.clipboard.writeText(it.value);
      li.append(head, body, copy);
      return li;
    }),
  );
  $("empty").hidden = s.items.length > 0;
}

$("connect").onclick = async () => {
  const r = await send<{ ok?: boolean; error?: string }>({ type: "gmail:connect" });
  if (r?.error) $("status").textContent = `연결 실패: ${r.error}`;
  else await render();
};
$("disconnect").onclick = async () => {
  await send({ type: "gmail:disconnect" });
  await render();
};
$("check").onclick = async () => {
  await send({ type: "watch:now" });
  await render();
};
$<HTMLInputElement>("mask").onchange = (e) => void send({ type: "settings:set", mask: (e.target as HTMLInputElement).checked });

chrome.notifications.getPermissionLevel((level) => {
  if (level === "denied") {
    $("notifHint").className = "warn";
    $("notifHint").textContent = "크롬 알림이 꺼져 있습니다. 입력칸을 누르면 나오는 칩으로 입력할 수 있습니다.";
  }
});

void render();
setInterval(() => void render(), 2000);
