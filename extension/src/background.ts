/**
 * MV3 서비스 워커 (v2) — 얇은 어댑터. 판단은 watch.ts·mailpolicy.ts·otp-parser 순수 함수가 한다.
 *
 * - 감시: content 트리거 → 탭별 세션(10분) → history.list 폴링 → 세션과 맞는 메일만 metadata → 필요 시 full → 파싱
 * - 알림: 본문 클릭이 기본 동작. 클릭 시점에 탭의 프레임들을 probe해 정책을 통과한 프레임 하나에만 입력
 * - 데이터: 코드·세션은 chrome.storage.session(메모리)에만, 10분 TTL·사용 후 삭제. 메일 원문은 저장하지 않는다
 *
 * 서비스 워커는 언제든 종료된다. 감시 중에는 틱마다 storage API를 불러 유휴 타이머를 리셋하고,
 * 종료되면 30초 alarm 또는 content의 다음 메시지로 재개한다. 알림 리스너는 최상위에 등록한다.
 */
import { parseEmail, trimSnippet } from "@otp-autofill/otp-parser";
import { extractBodies, GmailClient, GmailError, historyAfter, messageHeaders, subjectOf } from "./gmail.js";
import { decideMail, senderInfo } from "./mailpolicy.js";
import type { ExtMessage, PopupState } from "./messages.js";
import {
  actionsFor,
  ITEM_TTL_MS,
  liveSessions,
  matchSession,
  notificationText,
  planFill,
  pruneSessions,
  supersededBy,
  sweepItems,
  upsertSession,
  WARNING_TEXT,
  type FrameProbe,
  type Item,
  type Items,
  type Sessions,
  type TriggerReason,
} from "./watch.js";

const SWEEP_ALARM = "sweep";
const PROBE_WAIT_MS = 300;
const RECENT_LOOKBACK_COUNT = 5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- 테스트 훅 (e2e 빌드에만 포함) ----------

const hooks = {
  notifs: new Map<string, chrome.notifications.NotificationOptions<true>>(),
  lastCopy: "",
};

// ---------- 토큰·Gmail ----------

async function getToken(interactive = false): Promise<string> {
  if (__E2E__) return "e2e-token";
  // 권한 철회 등으로 비대화형 발급이 실패하면 일반 Error가 난다 → 재연결 필요(401)로 통일
  const r = await chrome.identity.getAuthToken({ interactive }).catch((e: Error) => {
    throw new GmailError(401, `token: ${e.message}`);
  });
  if (!r?.token) throw new GmailError(401, "no token");
  return r.token;
}

const gmail = new GmailClient({
  fetch: (...a) => fetch(...a),
  base: __GMAIL_BASE__,
  getToken: () => getToken(false),
  dropToken: async (token) => {
    if (!__E2E__) await chrome.identity.removeCachedAuthToken({ token });
  },
});

const isAuthError = (e: unknown) => e instanceof GmailError && e.status === 401;

// ---------- 상태 (storage.session = 메모리, 디스크 미기록) ----------

async function getSessions(): Promise<Sessions> {
  return ((await chrome.storage.session.get("sessions")).sessions as Sessions | undefined) ?? {};
}
async function getItems(): Promise<Items> {
  return ((await chrome.storage.session.get("items")).items as Items | undefined) ?? {};
}
async function isConnected(): Promise<boolean> {
  return ((await chrome.storage.local.get("connected")).connected as boolean | undefined) === true;
}

/** storage를 읽고 고치는 작업은 한 줄로 세운다 (폴링 틱·트리거·alarm이 겹쳐도 덮어쓰지 않게). 중첩 호출 금지 */
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn);
  chain = p.catch(() => undefined);
  return p;
}

async function updateBadge() {
  const { authError } = await chrome.storage.session.get("authError");
  const items = await getItems();
  const text = authError ? "!" : Object.keys(items).length ? "OTP" : "";
  await chrome.action.setBadgeText({ text });
}

async function setAuthError(on: boolean) {
  await chrome.storage.session.set({ authError: on });
  await updateBadge();
}

// ---------- 감시 ----------

/** content 트리거. 사용자 활성화가 없으면 이미 있는 세션의 만료 연장만 한다 (watch.ts upsertSession) */
async function watchStart(sender: chrome.runtime.MessageSender, reason: TriggerReason, activated: boolean) {
  const tabId = sender.tab?.id;
  if (tabId === undefined || !sender.url || !(await isConnected())) return { ok: false };
  const result = await serial(async () => {
    const now = Date.now();
    const sessions = pruneSessions(await getSessions(), now);
    const existing = sessions[tabId];
    if (!existing && !activated) return { ok: false };
    // 탭이 닫히는 중에 온 트리거가 onRemoved 뒤에 처리되면 닫힌 탭 세션이 남는다
    if (!(await chrome.tabs.get(tabId).catch(() => null))) return { ok: false };
    const historyId = existing ? existing.startHistoryId : await gmail.historyId();
    const r = upsertSession(sessions, { tabId, frameUrl: sender.url!, historyId, now, activated });
    if (!r) return { ok: false };
    await chrome.storage.session.set({ sessions: r.sessions });
    if (r.created) {
      // 늦은 트리거(입력칸 등장·문구) 대비: 최근 2분 안에 온 메일도 이 세션 후보로 본다
      const only: Sessions = { [tabId]: r.sessions[tabId]! };
      for (const id of await gmail.recentMessageIds(RECENT_LOOKBACK_COUNT)) {
        await processMessage(id, { lookback: true }, only, now).catch((e: unknown) => {
          if (isAuthError(e)) throw e;
          console.warn("[otp] lookback", (e as Error).message); // 한 메일 실패가 세션 시작을 막지 않게
        });
      }
    }
    return { ok: true };
  }).catch(onGmailError);
  if (result?.ok) {
    if (reason === "focus" || reason === "manual") void serial(tick).catch(onGmailError); // 즉시 1회 조회
    void loop();
  }
  return result ?? { ok: false };
}

async function onGmailError(e: unknown): Promise<undefined> {
  if (isAuthError(e)) await setAuthError(true);
  else console.warn("[otp] gmail", (e as Error).message);
  return undefined;
}

let looping = false;
const MAX_BACKOFF_MS = 60_000;

async function loop() {
  if (looping) return;
  looping = true;
  let errors = 0;
  try {
    for (;;) {
      const r = await serial(tick);
      if (r === "stop") return;
      errors = r === "error" ? errors + 1 : 0;
      await chrome.storage.session.set({ tick: Date.now() }); // 확장 API 호출 = 워커 유휴 타이머 리셋
      // 429·5xx·네트워크 오류는 간격을 늘려 다시 (최대 60초)
      await sleep(Math.min(__POLL_MS__ * 2 ** errors, MAX_BACKOFF_MS));
    }
  } catch (e) {
    await onGmailError(e);
  } finally {
    looping = false;
  }
}

/** 같은 메일이 계속 실패하면 몇 번까지 커서를 붙잡아 둘지 (그 뒤에는 건너뛴다) */
const MAX_MESSAGE_TRIES = 3;
const messageFailures = new Map<string, number>();

/** 폴링 한 번. 감시 중인 세션이 없거나 재연결이 필요하면 "stop" */
async function tick(): Promise<"ok" | "error" | "stop"> {
  const now = Date.now();
  const sessions = pruneSessions(await getSessions(), now);
  await chrome.storage.session.set({ sessions });
  const live = liveSessions(sessions, now);
  if (live.length === 0) {
    await chrome.storage.session.remove("cursor");
    return "stop";
  }
  let { cursor } = (await chrome.storage.session.get("cursor")) as { cursor?: string };
  // 커서가 없을 때만 가장 이른 세션 시작점에서 시작한다 (이후 세션은 지금 시점 historyId라 커서보다 뒤)
  if (!cursor) for (const s of live) if (!cursor || historyAfter(cursor, s.startHistoryId)) cursor = s.startHistoryId;
  try {
    const r = await gmail.newMessages(cursor!);
    let next = r.historyId;
    for (const m of r.messages) {
      try {
        await processMessage(m.id, { historyId: m.historyId }, sessions, now);
        messageFailures.delete(m.id);
      } catch (e) {
        if (isAuthError(e)) throw e;
        if (e instanceof GmailError && e.status === 404) continue; // 그 사이 삭제된 메일
        const n = (messageFailures.get(m.id) ?? 0) + 1;
        messageFailures.set(m.id, n);
        if (n < MAX_MESSAGE_TRIES) {
          // 이 메일 직전까지만 전진해 다음 틱에 다시 시도한다 (일시 오류로 인증번호를 잃지 않게)
          next = (BigInt(m.historyId) - 1n).toString();
          console.warn("[otp] message retry", (e as Error).message);
          break;
        }
        console.warn("[otp] message skipped", (e as Error).message);
        messageFailures.delete(m.id);
      }
    }
    await chrome.storage.session.set({ cursor: next });
  } catch (e) {
    if (isAuthError(e)) {
      await setAuthError(true);
      return "stop";
    }
    if (e instanceof GmailError && e.status === 404) {
      // history 커서가 너무 오래됨(드묾) — 지금부터 다시 본다
      console.warn("[otp] history cursor expired");
      await chrome.storage.session.set({ cursor: await gmail.historyId() });
      return "ok";
    }
    console.warn("[otp] poll", (e as Error).message);
    return "error";
  }
  if ((await chrome.storage.session.get("authError")).authError) await setAuthError(false);
  return "ok";
}

/** 내가 보낸 메일·임시보관함은 인증 메일이 아니다 (되돌아보기 경로는 history 라벨 필터를 거치지 않음) */
const SKIP_LABELS = ["SENT", "DRAFT", "CHAT"];

/**
 * 메일 하나 처리. 세션과 맞지 않으면 본문을 읽지 않고 버린다(무알림). serial 안에서만 부른다.
 * seen은 처리가 끝난 뒤에 기록한다 — 중간에 일시 오류가 나면 다음 틱에 다시 시도된다.
 */
async function processMessage(id: string, when: { historyId: string } | { lookback: true }, sessions: Sessions, now: number) {
  const { seen = [] } = (await chrome.storage.session.get("seen")) as { seen?: string[] };
  if (seen.includes(id)) return;
  const meta = await gmail.metadata(id);
  if ((meta.labelIds ?? []).some((l) => SKIP_LABELS.includes(l))) return;
  const info = senderInfo(messageHeaders(meta));
  const session = matchSession(sessions, info.claimedSite, "historyId" in when ? when : { internalDate: meta.internalDate }, now);
  if (!session || !info.claimedSite) return;

  const subject = subjectOf(meta);
  // snippet은 잘려 있어 링크는 믿지 않는다 — 코드만 받고, 없으면 본문을 읽는다
  let parsed = parseEmail({ subject, text: trimSnippet(meta.snippet ?? "") });
  if (parsed?.kind !== "code") {
    const body = extractBodies((await gmail.full(id)).payload);
    parsed = parseEmail({ subject, text: body.text, html: body.html });
  }
  await chrome.storage.session.set({ seen: [...seen.slice(-199), id] });
  if (!parsed) return;

  const item: Item = {
    id: `otp-${id}`,
    kind: parsed.kind,
    value: parsed.kind === "code" ? parsed.code : parsed.url,
    claimedSite: info.claimedSite,
    authSite: info.authSite,
    tabId: session.tabId,
    createdAt: now,
    expiresAt: now + ITEM_TTL_MS,
  };
  const items = await getItems();
  for (const old of supersededBy(items, item)) {
    delete items[old];
    await clearNotification(old);
    await clearNotification(`${old}:warn`);
  }
  items[item.id] = item;
  await chrome.storage.session.set({ items });
  await updateBadge();
  await notify(item);
  chrome.tabs.sendMessage(item.tabId, { type: "otp:available" } satisfies ExtMessage).catch(() => undefined);
}

// ---------- 알림 ----------

// @types/chrome의 notifications는 콜백형만 있어 Promise로 감싼다
function createNotification(id: string, opts: chrome.notifications.NotificationOptions<true>): Promise<void> {
  return new Promise((resolve) =>
    chrome.notifications.create(id, opts, () => {
      if (chrome.runtime.lastError) console.warn("[otp] notify", chrome.runtime.lastError.message);
      resolve();
    }),
  );
}

async function notify(item: Item) {
  const { mask = false } = (await chrome.storage.local.get("mask")) as { mask?: boolean };
  const t = notificationText(item, { mask });
  const opts: chrome.notifications.NotificationOptions<true> = {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icon128.png"),
    title: t.title,
    message: t.message,
    contextMessage: t.contextMessage,
    buttons: t.buttons.map((title) => ({ title })),
    requireInteraction: true,
    priority: 2,
  };
  if (__E2E__) hooks.notifs.set(item.id, opts);
  await createNotification(item.id, opts);
}

async function warnNotification(item: Item, text: string) {
  const id = `${item.id}:warn`;
  const opts: chrome.notifications.NotificationOptions<true> = {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icon128.png"),
    title: `⚠ ${item.claimedSite}`,
    message: text, // 경고 알림에는 코드를 넣지 않는다 (알림 센터에 남아도 노출 없음)
    priority: 1,
  };
  if (__E2E__) hooks.notifs.set(id, opts);
  await createNotification(id, opts);
}

async function clearNotification(id: string) {
  if (__E2E__) hooks.notifs.delete(id);
  await new Promise<void>((resolve) => chrome.notifications.clear(id, () => (void chrome.runtime.lastError, resolve())));
}

/** 사용 완료 — 아이템·알림 삭제, 그 탭 감시 종료. 이미 쓰였으면 false (칩 두 번 클릭 등 동시 사용 방지) */
async function consume(item: Item): Promise<boolean> {
  const ok = await serial(async () => {
    const items = await getItems();
    if (!items[item.id]) return false;
    delete items[item.id];
    const sessions = await getSessions();
    delete sessions[item.tabId];
    await chrome.storage.session.set({ items, sessions });
    return true;
  });
  await clearNotification(item.id);
  await clearNotification(`${item.id}:warn`);
  await updateBadge();
  return ok;
}

async function onNotificationClick(notifId: string, buttonIndex?: number) {
  if (notifId.endsWith(":warn")) return clearNotification(notifId);
  const item = (await getItems())[notifId];
  if (!item || item.expiresAt <= Date.now()) return clearNotification(notifId);
  const action = actionsFor(item)[buttonIndex ?? 0] ?? "copy";
  if (action === "copy") {
    await copyText(item.value);
    await clearNotification(item.id); // 아이템은 팝업 최근 항목에 남긴다
    if (!item.authSite) await warnNotification(item, WARNING_TEXT.unauthenticated);
    return;
  }
  if (action === "open") {
    const d = decideMail({ kind: "link", authSite: item.authSite, targetUrl: item.value, expiresAt: item.expiresAt, now: Date.now() });
    if (d.action === "open") {
      const tab = await chrome.tabs.get(item.tabId).catch(() => undefined);
      const opened = await chrome.tabs.create({ url: item.value, openerTabId: tab?.id, index: tab ? tab.index + 1 : undefined, windowId: tab?.windowId });
      await chrome.windows.update(opened.windowId, { focused: true }).catch(() => undefined);
      await consume(item);
    } else if (d.action === "copy") {
      await copyText(item.value);
      await clearNotification(item.id);
      if (d.warning) await warnNotification(item, WARNING_TEXT[d.warning]);
    }
    return;
  }
  await fillFromItem(item);
}

async function focusTab(tab: chrome.tabs.Tab) {
  await chrome.tabs.update(tab.id!, { active: true }).catch(() => undefined);
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
}

/** probe 회신 수집 — 프레임 URL·ID는 브라우저가 채운 sender 값만 쓴다 */
const probes = new Map<string, { tabId: number; list: FrameProbe[] }>();

async function probeFrames(tabId: number): Promise<FrameProbe[]> {
  const nonce = crypto.randomUUID();
  const entry = { tabId, list: [] as FrameProbe[] };
  probes.set(nonce, entry);
  // frameId를 안 주면 탭의 모든 프레임에 간다. 각 프레임은 runtime 메시지로 회신한다
  chrome.tabs.sendMessage(tabId, { type: "fill:probe", nonce } satisfies ExtMessage).catch(() => undefined);
  await sleep(PROBE_WAIT_MS);
  probes.delete(nonce);
  return entry.list;
}

async function fillFromItem(item: Item) {
  const tab = await chrome.tabs.get(item.tabId).catch(() => undefined);
  if (!tab?.id) {
    // 탭이 닫힘 → 복사하고 팝업 최근 항목에 남긴다
    await copyText(item.value);
    await clearNotification(item.id);
    return;
  }
  await focusTab(tab);
  const plan = planFill(item, await probeFrames(tab.id), Date.now());
  if (plan.kind === "fill") {
    const res = (await chrome.tabs
      .sendMessage(
        tab.id,
        { type: "fill:code", code: item.value, origin: new URL(plan.frame.url).origin } satisfies ExtMessage,
        { frameId: plan.frame.frameId, ...(plan.frame.documentId ? { documentId: plan.frame.documentId } : {}) },
      )
      .catch(() => null)) as { filled?: boolean } | null;
    if (res?.filled) {
      await consume(item);
      return;
    }
    await copyText(item.value);
    await clearNotification(item.id);
    return;
  }
  if (plan.kind === "chip") {
    // 어느 입력칸인지 확실하지 않으면 사용자가 칩으로 고른다
    for (const f of plan.frames) {
      chrome.tabs
        .sendMessage(tab.id, { type: "chip:show", length: item.value.length } satisfies ExtMessage, {
          frameId: f.frameId,
          ...(f.documentId ? { documentId: f.documentId } : {}),
        })
        .catch(() => undefined);
    }
    await clearNotification(item.id);
    return;
  }
  if (plan.warning === "expired") {
    await consume(item);
    return;
  }
  await copyText(item.value);
  await clearNotification(item.id);
  if (plan.warning) await warnNotification(item, WARNING_TEXT[plan.warning]);
}

// ---------- 복사 (offscreen) ----------

let copying: Promise<unknown> = Promise.resolve();

function copyText(text: string): Promise<void> {
  if (__E2E__) hooks.lastCopy = text;
  const run = async () => {
    const has = (await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] })).length > 0;
    if (!has) {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: [chrome.offscreen.Reason.CLIPBOARD],
        justification: "알림에서 인증번호를 클립보드에 복사",
      });
    }
    await chrome.runtime.sendMessage({ type: "offscreen:copy", text } satisfies ExtMessage);
    await chrome.offscreen.closeDocument().catch(() => undefined);
  };
  const p = copying.then(run, run).catch((e: Error) => console.warn("[otp] copy", e.message));
  copying = p;
  return p;
}

// ---------- 칩 경로 (content) ----------

async function pendingCodeFor(sender: chrome.runtime.MessageSender): Promise<Item | null> {
  const tabId = sender.tab?.id;
  if (tabId === undefined || !sender.url) return null;
  const now = Date.now();
  const item = Object.values(await getItems()).find((it) => it.tabId === tabId && it.kind === "code" && it.expiresAt > now);
  if (!item) return null;
  // 판단 기준은 content가 보낸 값이 아니라 브라우저가 알려준 sender.url
  const d = decideMail({ kind: "code", authSite: item.authSite, targetUrl: sender.url, expiresAt: item.expiresAt, now });
  return d.action === "fill" ? item : null;
}

// ---------- 팝업 ----------

async function popupState(): Promise<PopupState> {
  const now = Date.now();
  const items = Object.values(await getItems())
    .filter((it) => it.expiresAt > now)
    .sort((a, b) => b.createdAt - a.createdAt);
  const { mask = false } = (await chrome.storage.local.get("mask")) as { mask?: boolean };
  const { authError = false } = (await chrome.storage.session.get("authError")) as { authError?: boolean };
  return {
    connected: await isConnected(),
    authError,
    watching: liveSessions(await getSessions(), now).length,
    mask,
    items: items.map((it) => ({
      id: it.id,
      kind: it.kind,
      value: it.value,
      site: it.claimedSite,
      authenticated: it.authSite !== null,
      expiresAt: it.expiresAt,
    })),
  };
}

async function connect() {
  await getToken(true);
  await chrome.storage.local.set({ connected: true });
  await setAuthError(false);
  return { ok: true };
}

/** 연결 해제 — 토큰 폐기, 남은 코드·세션 삭제. 먼저 연결 끊김으로 표시해 그 사이 트리거가 세션을 만들지 못하게 한다 */
async function disconnect() {
  await chrome.storage.local.set({ connected: false });
  if (!__E2E__) {
    const token = await getToken(false).catch(() => null);
    if (token) {
      await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `token=${encodeURIComponent(token)}`,
      }).catch(() => undefined);
      await chrome.identity.removeCachedAuthToken({ token }).catch(() => undefined);
    }
    await chrome.identity.clearAllCachedAuthTokens().catch(() => undefined);
  }
  const items = await serial(async () => {
    const items = await getItems();
    await chrome.storage.session.remove(["items", "sessions", "cursor", "seen", "authError"]);
    return items;
  });
  for (const id of Object.keys(items)) {
    await clearNotification(id);
    await clearNotification(`${id}:warn`);
  }
  await updateBadge();
  return { ok: true };
}

async function watchNow() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id === undefined) return { ok: false };
  // 탭 URL은 tabs 권한 없이는 못 보므로 그 탭의 최상위 content가 watch:start로 다시 보낸다 (sender.url 확보)
  await chrome.tabs.sendMessage(tab.id, { type: "watch:ask" } satisfies ExtMessage, { frameId: 0 }).catch(() => undefined);
  return { ok: true };
}

// ---------- 정리 ----------

async function sweep(now = Date.now()) {
  const expired = await serial(async () => {
    const r = sweepItems(await getItems(), now);
    await chrome.storage.session.set({ items: r.items, sessions: pruneSessions(await getSessions(), now) });
    return r.expired;
  });
  for (const id of expired) {
    await clearNotification(id);
    await clearNotification(`${id}:warn`);
  }
  await updateBadge();
}

// ---------- 메시지 라우팅 ----------

async function handle(msg: ExtMessage, sender: chrome.runtime.MessageSender): Promise<unknown> {
  // content script의 sender.url은 항상 웹 페이지 주소라 확장 페이지 주소로 팝업을 구별할 수 있다
  const fromPopup = sender.id === chrome.runtime.id && (sender.url?.startsWith(chrome.runtime.getURL("popup.html")) ?? false);
  switch (msg.type) {
    case "watch:start":
      return watchStart(sender, msg.reason, msg.activated);
    case "fill:probe-reply": {
      const entry = probes.get(msg.nonce);
      if (entry && sender.tab?.id === entry.tabId && sender.url && sender.frameId !== undefined) {
        entry.list.push({ frameId: sender.frameId, documentId: sender.documentId, url: sender.url, hasInput: msg.hasInput });
      }
      return null;
    }
    case "otp:query": {
      const item = await pendingCodeFor(sender);
      return item ? { length: item.value.length } : null;
    }
    case "otp:take": {
      const item = await pendingCodeFor(sender);
      if (!item || !(await consume(item))) return null;
      return { code: item.value };
    }
    case "popup:state":
      return fromPopup ? popupState() : null;
    case "gmail:connect":
      return fromPopup ? connect() : null;
    case "gmail:disconnect":
      return fromPopup ? disconnect() : null;
    case "watch:now":
      return fromPopup ? watchNow() : null;
    case "settings:set":
      return fromPopup ? chrome.storage.local.set({ mask: msg.mask }) : null;
    default:
      return undefined;
  }
}

chrome.runtime.onMessage.addListener((msg: ExtMessage, sender, sendResponse) => {
  if (msg.type === "offscreen:copy") return; // offscreen 문서가 처리
  handle(msg, sender).then(sendResponse, (e: Error) => sendResponse({ error: e.message }));
  return true; // 비동기 응답
});

// 워커 재시작 뒤의 클릭도 처리하도록 최상위에서 등록
chrome.notifications.onClicked.addListener((id) => void onNotificationClick(id));
chrome.notifications.onButtonClicked.addListener((id, index) => void onNotificationClick(id, index));

// 탭이 닫히면 그 탭 감시를 끝낸다 (받은 코드는 팝업 최근 항목에 TTL까지 남긴다)
chrome.tabs.onRemoved.addListener((tabId) => {
  void serial(async () => {
    const sessions = await getSessions();
    if (!sessions[tabId]) return;
    delete sessions[tabId];
    await chrome.storage.session.set({ sessions });
  });
});

// 알람은 브라우저 재시작 뒤 사라질 수 있어 워커가 뜰 때마다 확인한다
chrome.alarms.get(SWEEP_ALARM, (a) => {
  if (!a) void chrome.alarms.create(SWEEP_ALARM, { periodInMinutes: 0.5 });
});
async function resume() {
  await sweep();
  if (liveSessions(await getSessions(), Date.now()).length) void loop();
}
chrome.runtime.onStartup.addListener(() => void resume());
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === SWEEP_ALARM) void resume();
});

if (__E2E__) {
  (globalThis as unknown as { __e2e: unknown }).__e2e = {
    ...hooks,
    get lastCopy() {
      return hooks.lastCopy;
    },
    click: onNotificationClick,
    sweep: (now: number) => sweep(now),
    state: async () => ({ sessions: await getSessions(), items: await getItems() }),
  };
}
