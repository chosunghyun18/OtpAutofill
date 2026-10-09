/**
 * 폰 시뮬레이터 (Phase 1 개발용) — companion 앱 대신 폰 역할을 한다.
 *
 *   npm run fake-phone -- <페어링코드> [--relay http://localhost:8787] [--sender 이름]
 *
 * 1. 페어링 코드로 join → 브라우저 공개키 커밋 수신 → 브라우저가 공개한 키를 커밋과 대조 → 채널 키 유도 → 안전번호 출력
 * 2. 크롬 팝업의 안전번호와 같으면 `y` 입력 (다르면 중단 = 릴레이 MITM 의심)
 * 3. 표준입력 한 줄 = 문자 한 통. 암호화해서 릴레이로 보낸다. 전송 시각(ms)을 출력해 지연 실측에 쓴다.
 */
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import {
  deriveChannelKey,
  exportPublicKey,
  generateKeyPair,
  importPublicKey,
  randomId,
  safetyNumber,
  sealPayload,
  verifyCommitment,
  type OtpPayload,
} from "@otp-autofill/protocol";

export interface PhoneSession {
  relayUrl: string;
  channelId: string;
  phoneToken: string;
  key: CryptoKey;
  safetyNumber: string;
}

export class CommitmentMismatch extends Error {}

export async function joinAsPhone(
  relayUrl: string,
  pairingCode: string,
  opts: { pollMs?: number; timeoutMs?: number } = {},
): Promise<PhoneSession> {
  const { pollMs = 1000, timeoutMs = 5 * 60_000 } = opts;
  const kp = await generateKeyPair();
  const myPub = await exportPublicKey(kp.publicKey);
  const res = await fetch(`${relayUrl}/v1/pairings/${encodeURIComponent(pairingCode)}/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ publicKey: myPub }),
  });
  if (!res.ok) throw new Error(`join 실패: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { channelId: string; phoneToken: string; commitment: string };

  // 브라우저가 내 공개키를 받은 뒤 자기 키를 공개할 때까지 기다린다
  const deadline = Date.now() + timeoutMs;
  let browserPub: string | undefined;
  while (!browserPub) {
    if (Date.now() > deadline) throw new Error("브라우저 공개키 대기 시간 초과");
    const r = await fetch(`${relayUrl}/v1/pairings/${encodeURIComponent(pairingCode)}/reveal`, {
      headers: { authorization: `Bearer ${body.phoneToken}` },
    });
    if (!r.ok) throw new Error(`공개키 조회 실패: ${r.status} ${await r.text()}`);
    const rb = (await r.json()) as { status: string; peerPublicKey?: string };
    if (rb.status === "revealed") browserPub = rb.peerPublicKey;
    else await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  // 릴레이가 키를 바꿔치기했으면 여기서 걸린다
  if (!(await verifyCommitment(browserPub, body.commitment))) {
    throw new CommitmentMismatch("브라우저 공개키가 커밋과 다름 — 릴레이 MITM 의심, 페어링 중단");
  }
  return {
    relayUrl,
    channelId: body.channelId,
    phoneToken: body.phoneToken,
    key: await deriveChannelKey(kp.privateKey, await importPublicKey(browserPub), body.channelId),
    safetyNumber: await safetyNumber(myPub, browserPub),
  };
}

export async function sendSms(s: PhoneSession, text: string, sender?: string): Promise<OtpPayload> {
  const payload: OtpPayload = { v: 1, msgId: randomId(), text, sender, receivedAt: Date.now() };
  const res = await fetch(`${s.relayUrl}/v1/channels/${s.channelId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${s.phoneToken}` },
    body: JSON.stringify(await sealPayload(s.key, s.channelId, payload)),
  });
  if (!res.ok) throw new Error(`전송 실패: ${res.status} ${await res.text()}`);
  return payload;
}

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(args: string[]) {
  const code = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
  if (!code) {
    console.error("사용법: npm run fake-phone -- <페어링코드> [--relay URL] [--sender 이름]");
    process.exit(2);
  }
  const relayUrl = (argValue(args, "--relay") ?? "http://localhost:8787").replace(/\/$/, "");
  const sender = argValue(args, "--sender");
  const host = new URL(relayUrl).hostname;
  if (relayUrl.startsWith("http:") && host !== "localhost" && host !== "127.0.0.1") {
    console.warn("경고: https가 아닌 원격 릴레이입니다. 개발용으로만 쓰세요.");
  }

  console.log("페어링 중… 크롬 팝업이 열려 있어야 합니다.");
  const s = await joinAsPhone(relayUrl, code);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`안전번호: ${s.safetyNumber}`);
  const ok = await rl.question("크롬 팝업의 안전번호와 같습니까? (y/N) ");
  if (ok.trim().toLowerCase() !== "y") {
    console.log("중단합니다. 크롬 팝업에서 [다름 · 취소]를 눌러 페어링을 해제하세요.");
    rl.close();
    return;
  }
  console.log("문자 본문을 한 줄씩 입력하세요 (Ctrl+D 종료).");
  for await (const line of rl) {
    if (!line.trim()) continue;
    const p = await sendSms(s, line, sender);
    console.log(`전송 ${p.receivedAt} (msgId ${p.msgId.slice(0, 6)}…)`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e: Error) => {
    console.error(e.message);
    process.exit(1);
  });
}
