/**
 * 감시 세션·메일 매칭·아이템·알림 문구·입력 프레임 선택 — 순수 함수 (Design Spec v2 §3 감시 세션과 대상 선택, 알림).
 *
 * - 세션은 탭별이다. 트리거한 프레임의 eTLD+1을 sites에 모은다.
 * - 메일은 From(주장) eTLD+1이 sites에 있는 세션에만 연결한다. 여럿이면 가장 최근 트리거 탭.
 *   어느 세션과도 맞지 않으면 알림을 띄우지 않는다(공격자가 피해자 이메일로 가입시킨 진짜 인증 메일 반사 클릭 방지).
 * - 트리거 이후 메일만 본다: history 레코드 ID > 세션 시작 historyId. 세션 시작 때 1회만 최근 2분 메일도 본다(늦은 트리거).
 */
import { historyAfter, withinLookback } from "./gmail.js";
import { decideMail, siteOf, type MailDecision, type MailWarning } from "./mailpolicy.js";

export const WATCH_MS = 10 * 60_000;
export const ITEM_TTL_MS = 10 * 60_000;

export interface WatchSession {
  tabId: number;
  /** 트리거한 프레임들의 eTLD+1 */
  sites: string[];
  /** 트리거한 프레임 호스트 (알림 표시용) */
  host: string;
  startHistoryId: string;
  startedAt: number;
  lastTriggerAt: number;
  expiresAt: number;
}

export type Sessions = Record<string, WatchSession>;

export type TriggerReason = "form" | "input" | "text" | "focus" | "manual";

/**
 * 세션 시작 또는 연장. 시작 historyId·시각은 처음 값을 유지한다(그 뒤로 온 메일 전부가 후보).
 * 사용자 활성화가 없는 트리거(activated=false)는 기존 세션의 만료만 늘린다 — 새 세션도, 새 사이트 추가도 없다
 * (가입 탭 안의 광고 iframe 등이 자기 사이트를 감시 대상으로 끼워 넣지 못하게).
 */
export function upsertSession(
  sessions: Sessions,
  t: { tabId: number; frameUrl: string; historyId: string; now: number; activated?: boolean },
): { sessions: Sessions; created: boolean } | null {
  const activated = t.activated ?? true;
  let url: URL;
  try {
    url = new URL(t.frameUrl);
  } catch {
    return null;
  }
  const site = siteOf(url.hostname);
  if (url.protocol !== "https:" || !site) return null;
  const cur = sessions[t.tabId];
  const live = cur && cur.expiresAt > t.now;
  if (!live && !activated) return null;
  const next: WatchSession = live
    ? {
        ...cur,
        sites: cur.sites.includes(site) || !activated ? cur.sites : [...cur.sites, site],
        lastTriggerAt: t.now,
        expiresAt: t.now + WATCH_MS,
      }
    : {
        tabId: t.tabId,
        sites: [site],
        host: url.hostname,
        startHistoryId: t.historyId,
        startedAt: t.now,
        lastTriggerAt: t.now,
        expiresAt: t.now + WATCH_MS,
      };
  return { sessions: { ...sessions, [t.tabId]: next }, created: !live };
}

export function liveSessions(sessions: Sessions, now: number): WatchSession[] {
  return Object.values(sessions).filter((s) => s.expiresAt > now);
}

export function pruneSessions(sessions: Sessions, now: number): Sessions {
  return Object.fromEntries(Object.entries(sessions).filter(([, s]) => s.expiresAt > now));
}

/**
 * 메일이 연결될 세션. 트리거 이후 메일인지는 둘 중 하나로 본다.
 * - history 경로: 레코드 historyId > 세션 시작 historyId (노트북 시계와 무관)
 * - 되돌아보기 경로(세션 시작 1회): internalDate ≥ 세션 시작 - 2분
 */
export function matchSession(
  sessions: Sessions,
  claimedSite: string | null,
  when: { historyId: string } | { internalDate?: string },
  now: number,
): WatchSession | null {
  if (!claimedSite) return null;
  let best: WatchSession | null = null;
  for (const s of liveSessions(sessions, now)) {
    if (!s.sites.includes(claimedSite)) continue;
    const after = "historyId" in when ? historyAfter(when.historyId, s.startHistoryId) : withinLookback(when.internalDate, s.startedAt);
    if (!after) continue;
    if (!best || s.lastTriggerAt > best.lastTriggerAt) best = s;
  }
  return best;
}

// ---------- 아이템 ----------

export interface Item {
  id: string;
  kind: "code" | "link";
  /** 코드 또는 링크 URL */
  value: string;
  claimedSite: string;
  authSite: string | null;
  tabId: number;
  createdAt: number;
  expiresAt: number;
}

export type Items = Record<string, Item>;

export function sweepItems(items: Items, now: number): { items: Items; expired: string[] } {
  const keep: Items = {};
  const expired: string[] = [];
  for (const [id, it] of Object.entries(items)) {
    if (it.expiresAt > now) keep[id] = it;
    else expired.push(id);
  }
  return { items: keep, expired };
}

/** 같은 탭·같은 사이트·같은 종류의 이전 아이템 (새 메일이 오면 대체한다 — 최신 메일 기준, E5) */
export function supersededBy(items: Items, next: Item): string[] {
  return Object.values(items)
    .filter((it) => it.id !== next.id && it.tabId === next.tabId && it.kind === next.kind && it.claimedSite === next.claimedSite)
    .map((it) => it.id);
}

// ---------- 알림 ----------

export type ItemAction = "fill" | "open" | "copy";

/** 알림 버튼 순서. 첫 번째가 본문 클릭 기본 동작 */
export function actionsFor(item: Item): ItemAction[] {
  if (!item.authSite) return ["copy"];
  return item.kind === "code" ? ["fill", "copy"] : ["open", "copy"];
}

const ACTION_LABEL: Record<"code" | "link", Record<ItemAction, string>> = {
  code: { fill: "입력", open: "열기", copy: "복사" },
  link: { fill: "입력", open: "열기", copy: "링크 복사" },
};

export interface NotificationText {
  title: string;
  message: string;
  contextMessage: string;
  buttons: string[];
}

export function notificationText(item: Item, opts: { mask: boolean }): NotificationText {
  const warn = !item.authSite;
  const title = `${warn ? "⚠ " : ""}${item.claimedSite} · ${item.kind === "code" ? "인증번호" : "이메일 인증 링크"}`;
  let message: string;
  if (item.kind === "code") message = opts.mask ? "●".repeat(item.value.length) : item.value;
  else message = `링크: ${safeHost(item.value)}`;
  const contextMessage = warn
    ? "발신자 인증 실패 또는 공용 메일 주소 — 복사만 가능"
    : item.kind === "code"
      ? "클릭하면 입력"
      : "클릭하면 새 탭에서 열기";
  return { title, message, contextMessage, buttons: actionsFor(item).map((a) => ACTION_LABEL[item.kind][a]) };
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "?";
  }
}

export const WARNING_TEXT: Record<MailWarning, string> = {
  unauthenticated: "발신자를 확인할 수 없어 복사만 했습니다.",
  "site-mismatch": "지금 탭이 메일을 보낸 사이트가 아니어서 복사만 했습니다. 주소를 확인하세요.",
  insecure: "https 페이지가 아니어서 복사만 했습니다.",
  expired: "만료된 인증번호입니다.",
};

// ---------- 입력 프레임 선택 ----------

export interface FrameProbe {
  frameId: number;
  documentId?: string;
  /** 브라우저가 알려준 프레임 URL (sender.url) */
  url: string;
  hasInput: boolean;
}

export type FillPlan =
  | { kind: "fill"; frame: FrameProbe }
  | { kind: "chip"; frames: FrameProbe[] }
  | { kind: "copy"; warning?: MailWarning; decision?: MailDecision };

/**
 * 클릭 시점에 입력칸이 있는 프레임 중 정책을 통과한 것이 정확히 하나면 그 프레임에만 입력한다.
 * 둘 이상이면 칩(사용자가 직접 고름), 없으면 복사 — 입력칸이 있는데 정책 실패면 경고를 붙인다.
 */
export function planFill(item: Item, probes: FrameProbe[], now: number): FillPlan {
  const withInput = probes.filter((p) => p.hasInput);
  const decided = withInput.map((p) => ({
    p,
    d: decideMail({ kind: "code", authSite: item.authSite, targetUrl: p.url, expiresAt: item.expiresAt, now }),
  }));
  const ok = decided.filter((x) => x.d.action === "fill").map((x) => x.p);
  if (ok.length === 1) return { kind: "fill", frame: ok[0]! };
  if (ok.length > 1) return { kind: "chip", frames: ok };
  const failed = decided[0]?.d;
  if (failed?.action === "none") return { kind: "copy", warning: "expired", decision: failed };
  if (!item.authSite) return { kind: "copy", warning: "unauthenticated" };
  return failed ? { kind: "copy", warning: failed.warning, decision: failed } : { kind: "copy" };
}
