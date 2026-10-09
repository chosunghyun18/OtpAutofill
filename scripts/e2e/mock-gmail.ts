// 목 Gmail API — users.getProfile · history.list · messages.list · messages.get(metadata/full) 만 흉내 낸다.
// E2E가 addMail로 메일을 넣으면 historyId가 1씩 오르고 messageAdded 레코드가 생긴다.
import { createServer, type Server } from "node:http";

export const E2E_TOKEN = "e2e-token";

export interface MockMail {
  from: string;
  subject: string;
  /** Authentication-Results 헤더들 (원문 순서, 위가 먼저) */
  authResults: string[];
  text?: string;
  html?: string;
  /** Gmail snippet. 없으면 본문 앞부분 */
  snippet?: string;
  /** 도착 시각(ms). 없으면 지금 */
  internalDate?: number;
  labelIds?: string[];
}

interface Stored extends MockMail {
  id: string;
  historyId: number;
  /** 도착 후 삭제됨 — history에는 남고 messages.get은 404 */
  deleted?: boolean;
}

const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");

export class MockGmail {
  historyId = 5000;
  private mails: Stored[] = [];
  /** 요청 기록 — "무관 메일은 본문을 안 읽는다" 같은 검증에 쓴다 */
  log: Array<{ path: string; format?: string; id?: string }> = [];
  server: Server;

  constructor() {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.headers.authorization !== `Bearer ${E2E_TOKEN}`) return send(401, { error: "unauthorized" });
      const p = url.pathname.replace(/^\/gmail\/v1\/users\/me/, "");
      const m = /^\/messages\/([^/]+)$/.exec(p);
      this.log.push({ path: p, format: url.searchParams.get("format") ?? undefined, id: m?.[1] });

      if (p === "/profile") return send(200, { emailAddress: "me@example.test", historyId: String(this.historyId) });
      if (p === "/history") {
        const start = Number(url.searchParams.get("startHistoryId"));
        const history = this.mails
          .filter((x) => x.historyId > start)
          .map((x) => ({ id: String(x.historyId), messagesAdded: [{ message: { id: x.id, labelIds: x.labelIds ?? ["INBOX", "UNREAD"] } }] }));
        return send(200, { history, historyId: String(this.historyId) });
      }
      if (p === "/messages") {
        const max = Number(url.searchParams.get("maxResults") ?? 100);
        const latest = this.mails.filter((x) => !x.deleted).sort((a, b) => b.historyId - a.historyId).slice(0, max);
        return send(200, { messages: latest.map((x) => ({ id: x.id, threadId: x.id })) });
      }
      if (m) {
        const mail = this.mails.find((x) => x.id === m[1] && !x.deleted);
        if (!mail) return send(404, { error: "not found" });
        return send(200, this.render(mail, url));
      }
      send(404, { error: "unknown" });
    });
  }

  listen(port: number) {
    return new Promise<void>((r) => this.server.listen(port, "localhost", r));
  }
  close() {
    this.server.close();
  }

  addMail(mail: MockMail): string {
    this.historyId += 1;
    const id = `m${this.historyId}`;
    this.mails.push({ ...mail, id, historyId: this.historyId });
    return id;
  }

  deleteMail(id: string) {
    const m = this.mails.find((x) => x.id === id);
    if (m) m.deleted = true;
  }

  /** 이 메일의 본문(format=full)을 읽은 횟수 */
  fullReads(id: string) {
    return this.log.filter((l) => l.id === id && l.format === "full").length;
  }
  metadataReads(id: string) {
    return this.log.filter((l) => l.id === id && l.format === "metadata").length;
  }

  private render(mail: Stored, url: URL) {
    const headers = [
      { name: "Delivered-To", value: "me@example.test" },
      { name: "Received", value: "by 2002:a05:6a10:abcd with SMTP id x; Thu, 9 Oct 2026 12:00:00 -0700" },
      ...mail.authResults.slice(0, 1).map((value) => ({ name: "Authentication-Results", value })),
      { name: "From", value: mail.from },
      { name: "Subject", value: mail.subject },
      // 보낸 사람이 써 넣은 헤더는 아래쪽에 온다
      ...mail.authResults.slice(1).map((value) => ({ name: "Authentication-Results", value })),
      { name: "Content-Type", value: "multipart/alternative; boundary=x" },
    ];
    const textForSnippet = mail.text ?? (mail.html ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const base = {
      id: mail.id,
      threadId: mail.id,
      labelIds: mail.labelIds ?? ["INBOX", "UNREAD"],
      snippet: (mail.snippet ?? textForSnippet).slice(0, 200),
      internalDate: String(mail.internalDate ?? Date.now()),
    };
    if (url.searchParams.get("format") === "metadata") {
      const wanted = new Set(url.searchParams.getAll("metadataHeaders").map((h) => h.toLowerCase()));
      return { ...base, payload: { mimeType: "multipart/alternative", headers: headers.filter((h) => wanted.has(h.name.toLowerCase())) } };
    }
    const parts = [];
    if (mail.text !== undefined)
      parts.push({ mimeType: "text/plain", headers: [{ name: "Content-Type", value: "text/plain; charset=UTF-8" }], body: { data: b64url(mail.text) } });
    if (mail.html !== undefined)
      parts.push({ mimeType: "text/html", headers: [{ name: "Content-Type", value: 'text/html; charset="utf-8"' }], body: { data: b64url(mail.html) } });
    return { ...base, payload: { mimeType: "multipart/alternative", headers, parts } };
  }
}

/** Gmail이 붙이는 형태의 통과 결과 (DKIM은 From 도메인, SPF는 발송 대행사) */
export function passAR(domain: string) {
  return (
    `mx.google.com; dkim=pass header.i=@${domain} header.s=s1 header.b=AbCd; ` +
    `spf=pass (google.com: domain of bounce@sendgrid.test designates 1.2.3.4 as permitted sender) smtp.mailfrom=bounce@sendgrid.test; ` +
    `dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=${domain}`
  );
}

export function failAR(domain: string) {
  return `mx.google.com; dkim=none; spf=softfail smtp.mailfrom=evil.test; dmarc=fail (p=NONE) header.from=${domain}`;
}
