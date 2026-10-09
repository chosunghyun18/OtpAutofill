import type { ExtMessage, LatestOtp, PairState } from "./messages.js";
import { pairPhase } from "./pairing.js";

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
  $("meta").textContent = `${latest.service?.name ?? latest.sender ?? "알 수 없는 발신자"} · ${left}초 후 만료${
    latest.boundOrigin ? ` · ${latest.boundOrigin} 전용` : ""
  }`;
  copy.disabled = false;
  copy.onclick = () => navigator.clipboard.writeText(latest.code);
}

async function renderPair() {
  const s = await send<PairState>({ type: "pair:status" });
  const phase = pairPhase(s);
  const status = $("pairStatus");
  $("unpair").hidden = phase !== "active";
  $("pair").hidden = phase === "active" || phase === "needs-verify";
  $("verify").hidden = phase !== "needs-verify";
  const relay = $<HTMLInputElement>("relay");
  if (s.relayUrl && document.activeElement !== relay) relay.value = s.relayUrl;
  if (phase === "active") {
    status.innerHTML = "";
    status.append(`페어링됨 · 안전번호 `, Object.assign(document.createElement("b"), { textContent: s.safetyNumber ?? "" }));
  } else if (phase === "needs-verify") {
    status.textContent = "";
    $("sn").textContent = s.safetyNumber ?? "";
    // 버튼은 화면에 띄운 바로 그 채널·안전번호를 확인한다
    const confirm = async (match: boolean) => {
      await send({ type: "pair:confirm", match, channelId: s.channelId ?? "", safetyNumber: s.safetyNumber ?? "" });
      $("notice").textContent = match
        ? ""
        : "안전번호가 달라 페어링을 해제했습니다. 릴레이가 중간에서 키를 바꿨을 수 있습니다. 다른 네트워크나 릴레이에서 다시 페어링하세요.";
      await renderPair();
    };
    $("match").onclick = () => void confirm(true);
    $("mismatch").onclick = () => void confirm(false);
  } else if (phase === "waiting-phone") {
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
  $("notice").textContent = "";
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
