import type { ExtMessage, LatestOtp, PairState } from "./messages.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const send = <T>(msg: ExtMessage) => chrome.runtime.sendMessage(msg) as Promise<T>;

async function renderLatest() {
  const latest = await send<LatestOtp | null>({ type: "otp:peek" });
  const copy = $<HTMLButtonElement>("copy");
  if (!latest) {
    $("code").textContent = "—";
    $("meta").textContent = "";
    copy.disabled = true;
    return;
  }
  $("code").textContent = latest.code;
  const left = Math.max(0, Math.round((latest.expiresAt - Date.now()) / 1000));
  $("meta").textContent = `${latest.sender ?? "알 수 없는 발신자"} · ${left}초 후 만료${
    latest.boundOrigin ? ` · ${latest.boundOrigin} 전용` : ""
  }`;
  copy.disabled = false;
  copy.onclick = () => navigator.clipboard.writeText(latest.code);
}

async function renderPair() {
  const s = await send<PairState>({ type: "pair:status" });
  const status = $("pairStatus");
  $("unpair").hidden = !s.paired;
  $("pair").hidden = s.paired;
  if (s.relayUrl) $<HTMLInputElement>("relay").value = s.relayUrl;
  if (s.paired) {
    status.innerHTML = "";
    status.append(`페어링됨 · 안전번호 `, Object.assign(document.createElement("b"), { textContent: s.safetyNumber ?? "" }));
  } else if (s.pairingCode) {
    status.textContent = `폰 앱에 페어링 코드 입력: ${s.pairingCode}`;
  } else {
    status.textContent = "페어링되지 않음";
  }
}

$("pair").onclick = async () => {
  const relayUrl = $<HTMLInputElement>("relay").value.replace(/\/$/, "");
  // localhost 외 릴레이는 optional_host_permissions에서 사용자 동의를 받아 해당 origin만 허용
  const origin = new URL(relayUrl).origin;
  if (!origin.startsWith("http://localhost")) {
    const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
    if (!granted) return;
  }
  await send({ type: "pair:start", relayUrl });
  await renderPair();
};
$("unpair").onclick = async () => {
  await send({ type: "pair:revoke" });
  await renderPair();
  await renderLatest();
};

void renderLatest();
void renderPair();
setInterval(() => void (renderLatest(), renderPair()), 2000);
