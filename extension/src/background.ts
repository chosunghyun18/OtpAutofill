/**
 * MV3 서비스 워커.
 * - 페어링: ECDH 키 생성 → 릴레이에 공개키 등록 → 폰 합류 대기 → 채널 키 유도
 * - 수신: 릴레이 long-poll → 복호화 → otp-parser → 최근 코드(chrome.storage.session, 디스크 미기록)
 * - 정책: 코드는 사용자 클릭(otp:take) 시점에만, origin 정책을 통과한 프레임에만 전달
 *
 * 서비스 워커는 언제든 종료되므로 chrome.alarms(30초)로 폴링 루프를 되살린다.
 */
import { parseOtp } from "@otp-autofill/otp-parser";
import {
  deriveChannelKey,
  exportPublicKey,
  generateKeyPair,
  importPublicKey,
  openEnvelope,
  safetyNumber,
  type Envelope,
} from "@otp-autofill/protocol";
import { keystore } from "./keystore.js";
import { OTP_TTL_MS, type ExtMessage, type LatestOtp, type PairState, type QueryResponse } from "./messages.js";
import { decideFill } from "./origin.js";

const POLL_ALARM = "relay-poll";
const LONG_POLL_MS = 25_000;

async function getPair(): Promise<PairState> {
  const { pair } = await chrome.storage.local.get("pair");
  return (pair as PairState | undefined) ?? { paired: false };
}
const setPair = (pair: PairState) => chrome.storage.local.set({ pair });

async function getLatest(): Promise<LatestOtp | undefined> {
  const { latest } = await chrome.storage.session.get("latest");
  const l = latest as LatestOtp | undefined;
  if (l && Date.now() >= l.expiresAt) {
    await clearLatest();
    return undefined;
  }
  return l;
}
async function clearLatest() {
  await chrome.storage.session.remove("latest");
  await chrome.action.setBadgeText({ text: "" });
}

// ---------- 페어링 ----------

async function startPairing(relayUrl: string): Promise<PairState> {
  const kp = await generateKeyPair();
  await keystore.put("device", kp);
  const res = await fetch(`${relayUrl}/v1/pairings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ publicKey: await exportPublicKey(kp.publicKey) }),
  });
  if (!res.ok) throw new Error(`relay ${res.status}`);
  const body = (await res.json()) as {
    pairingCode: string;
    channelId: string;
    browserToken: string;
    expiresAt: number;
  };
  const state: PairState = {
    relayUrl,
    channelId: body.channelId,
    browserToken: body.browserToken,
    pairingCode: body.pairingCode,
    pairingExpiresAt: body.expiresAt,
    paired: false,
  };
  await setPair(state);
  void waitForPhone();
  return state;
}

async function waitForPhone() {
  for (;;) {
    const s = await getPair();
    if (s.paired || !s.pairingCode || !s.relayUrl || Date.now() > (s.pairingExpiresAt ?? 0)) return;
    const res = await fetch(`${s.relayUrl}/v1/pairings/${s.pairingCode}`, {
      headers: { authorization: `Bearer ${s.browserToken}` },
    });
    if (res.ok) {
      const body = (await res.json()) as { status: string; peerPublicKey?: string };
      if (body.status === "joined" && body.peerPublicKey) {
        const kp = (await keystore.get("device")) as CryptoKeyPair;
        const peer = await importPublicKey(body.peerPublicKey);
        await keystore.put("channel", await deriveChannelKey(kp.privateKey, peer, s.channelId!));
        const sn = await safetyNumber(await exportPublicKey(kp.publicKey), body.peerPublicKey);
        await setPair({ ...s, pairingCode: undefined, pairingExpiresAt: undefined, safetyNumber: sn, paired: true });
        void pollLoop();
        return;
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function revoke() {
  const s = await getPair();
  if (s.relayUrl && s.channelId && s.browserToken) {
    await fetch(`${s.relayUrl}/v1/channels/${s.channelId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${s.browserToken}` },
    }).catch(() => undefined);
  }
  await keystore.clear();
  await clearLatest();
  await setPair({ paired: false });
}

// ---------- 수신 ----------

let polling = false;

async function pollLoop() {
  if (polling) return;
  polling = true;
  try {
    for (;;) {
      const s = await getPair();
      if (!s.paired) return;
      const res = await fetch(`${s.relayUrl}/v1/channels/${s.channelId}/messages?waitMs=${LONG_POLL_MS}`, {
        headers: { authorization: `Bearer ${s.browserToken}` },
      });
      if (res.status === 401) {
        // 채널이 사라짐 (릴레이 재시작/해제) → 재페어링 필요
        await setPair({ paired: false });
        return;
      }
      if (!res.ok) return;
      const { messages } = (await res.json()) as { messages: Envelope[] };
      for (const env of messages) await handleEnvelope(s.channelId!, env);
    }
  } catch (e) {
    console.warn("[otp] poll error", (e as Error).message);
  } finally {
    polling = false;
  }
}

async function handleEnvelope(channelId: string, env: Envelope) {
  const key = (await keystore.get("channel")) as CryptoKey | undefined;
  if (!key) return;
  let payload;
  try {
    payload = await openEnvelope(key, channelId, env);
  } catch (e) {
    console.warn("[otp] envelope rejected", (e as Error).message);
    return;
  }
  const { seen = [] } = (await chrome.storage.session.get("seen")) as { seen?: string[] };
  if (seen.includes(payload.msgId)) return; // 재전송
  await chrome.storage.session.set({ seen: [...seen.slice(-50), payload.msgId] });

  const parsed = parseOtp(payload.text);
  if (!parsed) return;
  const latest: LatestOtp = {
    code: parsed.code,
    boundOrigin: parsed.origin,
    sender: payload.sender,
    receivedAt: payload.receivedAt,
    expiresAt: payload.receivedAt + OTP_TTL_MS,
  };
  await chrome.storage.session.set({ latest });
  await chrome.action.setBadgeText({ text: "OTP" });

  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id !== undefined) {
    chrome.tabs.sendMessage(tab.id, { type: "otp:available" } satisfies ExtMessage).catch(() => undefined);
  }
}

// ---------- 메시지 라우팅 ----------

async function handle(msg: ExtMessage, sender: chrome.runtime.MessageSender): Promise<unknown> {
  const fromPopup = sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(""));
  switch (msg.type) {
    case "otp:query":
    case "otp:take": {
      const latest = await getLatest();
      if (!latest || !sender.url) return { decision: null } satisfies QueryResponse;
      // 판단 기준은 content가 보낸 값이 아니라 브라우저가 알려준 sender.url
      const decision = decideFill({ pageUrl: sender.url, boundOrigin: latest.boundOrigin, expiresAt: latest.expiresAt });
      if (msg.type === "otp:query") return { decision, length: latest.code.length } satisfies QueryResponse;
      if (!decision.allow) return { decision };
      await clearLatest(); // 1회 사용
      return { decision, code: latest.code };
    }
    case "otp:peek":
      return fromPopup ? ((await getLatest()) ?? null) : null;
    case "pair:start":
      return fromPopup ? startPairing(msg.relayUrl) : null;
    case "pair:status":
      return fromPopup ? getPair() : null;
    case "pair:revoke":
      return fromPopup ? revoke() : null;
    default:
      return null;
  }
}

chrome.runtime.onMessage.addListener((msg: ExtMessage, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse, (e: Error) => sendResponse({ error: e.message }));
  return true; // 비동기 응답
});

chrome.runtime.onInstalled.addListener(() => {
  void chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }); // content script 접근 차단
  void chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.5 });
});
chrome.runtime.onStartup.addListener(() => void pollLoop());
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === POLL_ALARM) void pollLoop();
});
