/**
 * MV3 서비스 워커.
 * - 페어링: ECDH 키 생성 → 릴레이에 공개키 등록 → 폰 합류 대기 → 채널 키 유도 → 사용자 안전번호 확인
 * - 수신: 릴레이 long-poll → 복호화 → otp-parser → 최근 코드(chrome.storage.session, 디스크 미기록)
 * - 정책: 코드는 사용자 클릭(otp:take) 시점에만, origin 정책을 통과한 프레임에만 전달
 *
 * 서비스 워커는 언제든 종료되므로 chrome.alarms(30초)로 폴링 루프를 되살린다.
 */
import { parseOtp } from "@otp-autofill/otp-parser";
import {
  commitPublicKey,
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
import { badgeText, pairPhase, pinPeerKey } from "./pairing.js";
import { detectService } from "./service.js";

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
  await updateBadge();
}

/** 배지는 페어링 단계와 최근 코드 유무로 계산한다 (확인 대기 "?"가 코드 소진으로 지워지지 않게) */
async function updateBadge() {
  const { latest } = await chrome.storage.session.get("latest");
  await chrome.action.setBadgeText({ text: badgeText(pairPhase(await getPair()), latest !== undefined) });
}

// ---------- 페어링 ----------

async function startPairing(relayUrl: string): Promise<PairState> {
  const kp = await generateKeyPair();
  const res = await fetch(`${relayUrl}/v1/pairings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // 커밋-공개: 지금은 공개키 해시만 올리고, 폰 공개키를 받은 뒤에 공개한다 (protocol/crypto.ts 참고)
    body: JSON.stringify({ commitment: await commitPublicKey(await exportPublicKey(kp.publicKey)) }),
  });
  if (!res.ok) throw new Error(`relay ${res.status}`);
  const body = (await res.json()) as {
    pairingCode: string;
    channelId: string;
    browserToken: string;
    expiresAt: number;
  };
  // 이전 시도의 키는 버린다 (진행 중이던 이전 대기 루프는 키가 없어 중단된다). 키 이름에 채널을 넣어 섞이지 않게 한다
  await keystore.clear();
  await keystore.put(`device:${body.channelId}`, kp);
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

let waiting = false;

async function waitForPhone() {
  if (waiting) return;
  waiting = true;
  try {
    await waitForPhoneLoop();
  } catch (e) {
    console.warn("[otp] pairing poll error", (e as Error).message);
  } finally {
    waiting = false;
  }
}

async function waitForPhoneLoop() {
  for (;;) {
    const s = await getPair();
    if (pairPhase(s) !== "waiting-phone" || !s.relayUrl || !s.channelId) return;
    const res = await fetch(`${s.relayUrl}/v1/pairings/${s.pairingCode}`, {
      headers: { authorization: `Bearer ${s.browserToken}` },
    });
    if (res.ok) {
      const body = (await res.json()) as { status: string; peerPublicKey?: string };
      if (body.status === "joined" && body.peerPublicKey) {
        // 처음 받은 폰 공개키를 공개(reveal) 전에 고정한다. 재시도 때 릴레이가 다른 키를 주면
        // (브라우저 키를 본 뒤 안전번호를 맞춘 가짜 키) 커밋-공개가 무력화되므로 페어링을 버린다
        const pin = pinPeerKey(s.peerPublicKey, body.peerPublicKey);
        if (pin === "mismatch") {
          console.warn("[otp] 폰 공개키가 바뀜 — 릴레이 MITM 의심, 페어링 중단");
          await revoke();
          return;
        }
        if (pin === "pin") {
          if (!(await updateIfSameChannel(s.channelId, { peerPublicKey: body.peerPublicKey }))) return;
        }
        const kp = (await keystore.get(`device:${s.channelId}`)) as CryptoKeyPair | undefined;
        if (!kp) return; // 새 페어링이 시작됨
        const myPub = await exportPublicKey(kp.publicKey);
        const peer = await importPublicKey(body.peerPublicKey);
        await keystore.put("channel", await deriveChannelKey(kp.privateKey, peer, s.channelId!));
        const sn = await safetyNumber(myPub, body.peerPublicKey);
        // 폰 공개키를 받았으니 이제 내 공개키를 공개한다. 409(이미 공개됨)는 워커 재시작 후 재시도라 정상
        const revealed = await fetch(`${s.relayUrl}/v1/pairings/${s.pairingCode}/reveal`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${s.browserToken}` },
          body: JSON.stringify({ publicKey: myPub }),
        });
        if (!revealed.ok && revealed.status !== 409) throw new Error(`reveal ${revealed.status}`);
        // 사용자가 팝업에서 안전번호 일치를 확인하기 전까지는 수신하지 않는다 (T2)
        await updateIfSameChannel(s.channelId, {
          pairingCode: undefined,
          pairingExpiresAt: undefined,
          safetyNumber: sn,
          paired: true,
          verified: false,
        });
        await updateBadge();
        return;
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/** 그 사이 새 페어링이 시작되지 않았을 때만 상태를 고친다 (이전 대기 루프가 새 상태를 덮어쓰지 않게) */
async function updateIfSameChannel(channelId: string, patch: Partial<PairState>): Promise<boolean> {
  const cur = await getPair();
  if (cur.channelId !== channelId || pairPhase(cur) !== "waiting-phone") return false;
  await setPair({ ...cur, ...patch });
  return true;
}

/** 로컬 페어링 상태·키·코드를 모두 지운다 (해제·불일치·채널 소멸 공통 경로) */
async function resetLocal() {
  await keystore.clear();
  await chrome.storage.session.remove(["latest", "seen"]);
  await setPair({ paired: false });
  await updateBadge();
}

async function revoke() {
  const s = await getPair();
  if (s.relayUrl && s.channelId && s.browserToken) {
    await fetch(`${s.relayUrl}/v1/channels/${s.channelId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${s.browserToken}` },
    }).catch(() => undefined);
  }
  await resetLocal();
}

/**
 * 안전번호 비교 결과. 팝업이 화면에 띄웠던 channelId·안전번호를 함께 보내고,
 * 지금 확인 대기 중인 페어링과 둘 다 같을 때만 확인 처리한다 (재페어링 직후 다른 채널을 확인하는 경합 방지).
 */
async function confirmPairing(msg: { match: boolean; channelId: string; safetyNumber: string }) {
  const s = await getPair();
  if (pairPhase(s) !== "needs-verify" || s.channelId !== msg.channelId || s.safetyNumber !== msg.safetyNumber) {
    return { ok: false };
  }
  if (!msg.match) {
    await revoke(); // 안전번호 불일치 = 릴레이 MITM 의심
    return { ok: true };
  }
  await setPair({ ...s, verified: true });
  await updateBadge();
  void pollLoop();
  return { ok: true };
}

// ---------- 수신 ----------

let polling = false;

async function pollLoop() {
  if (polling) return;
  polling = true;
  try {
    for (;;) {
      const s = await getPair();
      if (pairPhase(s) !== "active") return;
      const res = await fetch(`${s.relayUrl}/v1/channels/${s.channelId}/messages?waitMs=${LONG_POLL_MS}`, {
        headers: { authorization: `Bearer ${s.browserToken}` },
      });
      if (res.status === 401) {
        // 채널이 사라짐 (릴레이 재시작/해제) → 재페어링 필요
        await resetLocal();
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
    service: detectService(payload.text) ?? (payload.sender ? detectService(`[${payload.sender}]`) : null) ?? undefined,
    receivedAt: payload.receivedAt,
    expiresAt: payload.receivedAt + OTP_TTL_MS,
  };
  await chrome.storage.session.set({ latest });
  await updateBadge();

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
      // 사용자가 OTP 입력칸에 포커스하면 content가 조회한다 — 워커가 종료됐다 깨어난 경우라도
      // 30초 alarm을 기다리지 않고 바로 수신을 재개한다 (수신 대기 중인 문자를 즉시 가져옴)
      void resume();
    // fallthrough
    case "otp:take": {
      const latest = await getLatest();
      if (!latest || !sender.url) return { decision: null } satisfies QueryResponse;
      // 판단 기준은 content가 보낸 값이 아니라 브라우저가 알려준 sender.url
      const decision = decideFill({
        pageUrl: sender.url,
        boundOrigin: latest.boundOrigin,
        service: latest.service,
        expiresAt: latest.expiresAt,
      });
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
    case "pair:confirm":
      return fromPopup ? confirmPairing(msg) : null;
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
// 서비스 워커가 페어링 대기·수신 중에 종료돼도 다음 기동 때 단계에 맞춰 이어서 한다
async function resume() {
  const phase = pairPhase(await getPair());
  if (phase === "waiting-phone") void waitForPhone();
  if (phase === "active") void pollLoop();
  await updateBadge();
}
chrome.runtime.onStartup.addListener(() => void resume());
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === POLL_ALARM) void resume();
});
