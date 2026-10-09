/**
 * Gmail REST 클라이언트 (users.getProfile · users.history.list · users.messages.get) + 디코딩 순수 함수.
 *
 * - 메일함 검색 없이 트리거 이후 새로 온 메일만 본다: getProfile의 historyId → history.list(messageAdded).
 * - 본문 읽기 최소화: metadata(From·Subject·Authentication-Results + snippet) 먼저, 필요할 때만 full.
 * - fetch·토큰은 주입한다 (테스트·e2e 빌드에서 목 서버로 바꾸기 위해).
 */
import type { MailHeader } from "./mailpolicy.js";

export const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
export const METADATA_HEADERS = ["From", "Subject", "Authentication-Results"] as const;

export interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: MailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
}

export interface HistoryResponse {
  history?: Array<{
    id: string;
    messagesAdded?: Array<{ message: { id: string; labelIds?: string[] } }>;
  }>;
  historyId?: string;
  nextPageToken?: string;
}

export interface NewMessage {
  id: string;
  /** 이 메일을 추가한 history 레코드 ID — 감시 시작 historyId와 비교한다 */
  historyId: string;
}

/** 내가 보낸 메일·임시보관함은 인증 메일이 아니다 */
const SKIP_LABELS = new Set(["SENT", "DRAFT", "CHAT"]);

export function newMessagesFromHistory(resp: HistoryResponse): NewMessage[] {
  const out: NewMessage[] = [];
  const seen = new Set<string>();
  for (const rec of resp.history ?? []) {
    for (const added of rec.messagesAdded ?? []) {
      const m = added.message;
      if (seen.has(m.id) || (m.labelIds ?? []).some((l) => SKIP_LABELS.has(l))) continue;
      seen.add(m.id);
      out.push({ id: m.id, historyId: rec.id });
    }
  }
  return out;
}

/** historyId는 부호 없는 64비트 정수 문자열 — 숫자로 바꾸면 정밀도를 잃으므로 BigInt로 비교 */
export function historyAfter(a: string, b: string): boolean {
  try {
    return BigInt(a) > BigInt(b);
  } catch {
    return false;
  }
}

export function decodeBase64Url(data: string): Uint8Array {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function header(headers: MailHeader[] | undefined, name: string): string | undefined {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

function charsetOf(part: GmailPart): string {
  const m = /charset\s*=\s*"?([\w.:-]+)"?/i.exec(header(part.headers, "Content-Type") ?? "");
  return m?.[1]?.toLowerCase() ?? "utf-8";
}

function decodeText(data: string, charset: string): string {
  const bytes = decodeBase64Url(data);
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** 메일 본문(text/plain·text/html 첫 번째 것). 첨부는 제외 */
export function extractBodies(payload: GmailPart | undefined): { text?: string; html?: string } {
  const out: { text?: string; html?: string } = {};
  const walk = (p: GmailPart | undefined, depth: number) => {
    if (!p || depth > 10) return;
    const type = (p.mimeType ?? "").toLowerCase();
    const isAttachment = !!p.filename || /attachment/i.test(header(p.headers, "Content-Disposition") ?? "");
    if (!isAttachment && p.body?.data) {
      if (type === "text/plain" && out.text === undefined) out.text = decodeText(p.body.data, charsetOf(p));
      if (type === "text/html" && out.html === undefined) out.html = decodeText(p.body.data, charsetOf(p));
    }
    for (const c of p.parts ?? []) walk(c, depth + 1);
  };
  walk(payload, 0);
  return out;
}

export function messageHeaders(msg: GmailMessage): MailHeader[] {
  return msg.payload?.headers ?? [];
}

export function subjectOf(msg: GmailMessage): string {
  return decodeMimeWords(header(msg.payload?.headers, "Subject") ?? "");
}

/** RFC 2047 인코딩 단어(=?UTF-8?B?…?=, =?EUC-KR?Q?…?=). Gmail은 보통 풀어서 주지만 남은 경우 대비 */
export function decodeMimeWords(s: string): string {
  return s
    .replace(/(\?=)\s+(=\?)/g, "$1$2") // 인접한 인코딩 단어 사이 공백은 버린다
    .replace(/=\?([\w.:-]+)\?([bq])\?([^?]*)\?=/gi, (m, charset: string, enc: string, data: string) => {
      try {
        let bytes: Uint8Array;
        if (enc.toLowerCase() === "b") bytes = decodeBase64Url(data.replace(/\+/g, "-").replace(/\//g, "_"));
        else {
          const q = data.replace(/_/g, " ");
          const arr: number[] = [];
          for (let i = 0; i < q.length; i++) {
            if (q[i] === "=" && /^[0-9a-f]{2}$/i.test(q.slice(i + 1, i + 3))) {
              arr.push(parseInt(q.slice(i + 1, i + 3), 16));
              i += 2;
            } else arr.push(q.charCodeAt(i));
          }
          bytes = Uint8Array.from(arr);
        }
        return new TextDecoder(charset.toLowerCase()).decode(bytes);
      } catch {
        return m;
      }
    });
}

/** 늦은 트리거 보완용 되돌아보기 창 — 이 시간 안에 도착한 최근 메일도 후보로 본다 */
export const LOOKBACK_MS = 2 * 60_000;

/** internalDate(ms 문자열)가 기준 시각 - LOOKBACK_MS 이후인가 */
export function withinLookback(internalDate: string | undefined, since: number): boolean {
  const t = Number(internalDate);
  return Number.isFinite(t) && t >= since - LOOKBACK_MS;
}

// ---------- REST ----------

export const MAX_HISTORY_PAGES = 5;
/** 네트워크가 멈춰도 폴링 잠금(serial)이 풀리도록 */
export const REQUEST_TIMEOUT_MS = 10_000;

export class GmailError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface GmailDeps {
  fetch: typeof fetch;
  base: string;
  /** 토큰을 받는다. 연결 안 됨이면 throw */
  getToken(): Promise<string>;
  /** 401일 때 캐시된 토큰을 버린다 */
  dropToken(token: string): Promise<void>;
}

export class GmailClient {
  constructor(private readonly deps: GmailDeps) {}

  private async get<T>(path: string, params: Array<[string, string]> = []): Promise<T> {
    const qs = params.length ? "?" + new URLSearchParams(params).toString() : "";
    for (let attempt = 0; ; attempt++) {
      const token = await this.deps.getToken();
      const res = await this.deps.fetch(`${this.deps.base}${path}${qs}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 401 && attempt === 0) {
        await this.deps.dropToken(token); // 만료 토큰 → 한 번만 새로 받아 재시도
        continue;
      }
      if (!res.ok) throw new GmailError(res.status, `gmail ${path.split("/")[1] ?? path} ${res.status}`);
      return (await res.json()) as T;
    }
  }

  async historyId(): Promise<string> {
    return (await this.get<{ historyId: string }>("/profile")).historyId;
  }

  /** startHistoryId 이후 새로 추가된 메일. 404(오래된 historyId)는 GmailError(404)로 던진다 */
  async newMessages(startHistoryId: string): Promise<{ messages: NewMessage[]; historyId: string }> {
    const messages: NewMessage[] = [];
    let historyId = startHistoryId;
    let lastRecord: string | undefined;
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
      const params: Array<[string, string]> = [
        ["startHistoryId", startHistoryId],
        ["historyTypes", "messageAdded"],
        ["maxResults", "100"],
      ];
      if (pageToken) params.push(["pageToken", pageToken]);
      const resp = await this.get<HistoryResponse>("/history", params);
      messages.push(...newMessagesFromHistory(resp));
      lastRecord = resp.history?.at(-1)?.id ?? lastRecord;
      if (resp.historyId) historyId = resp.historyId;
      pageToken = resp.nextPageToken;
      if (!pageToken) break;
    }
    // 페이지 상한에 걸리면 최신 historyId로 건너뛰지 않고 읽은 마지막 레코드까지만 전진한다 (다음 틱에 이어서)
    if (pageToken && lastRecord) historyId = lastRecord;
    return { messages, historyId };
  }

  /** 최근 메일 ID 몇 개 (세션 시작 때 1회 — 트리거보다 먼저 도착한 메일 대비) */
  async recentMessageIds(max = 5): Promise<string[]> {
    const r = await this.get<{ messages?: Array<{ id: string }> }>("/messages", [["maxResults", String(max)]]);
    return (r.messages ?? []).map((m) => m.id);
  }

  metadata(id: string): Promise<GmailMessage> {
    return this.get<GmailMessage>(`/messages/${encodeURIComponent(id)}`, [
      ["format", "metadata"],
      ...METADATA_HEADERS.map((h): [string, string] => ["metadataHeaders", h]),
    ]);
  }

  full(id: string): Promise<GmailMessage> {
    return this.get<GmailMessage>(`/messages/${encodeURIComponent(id)}`, [["format", "full"]]);
  }
}
