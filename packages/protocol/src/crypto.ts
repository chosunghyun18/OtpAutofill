/**
 * 종단간 암호화 — WebCrypto만 사용 (브라우저·Node 20·Android WebView 공통).
 *
 * 1. 각 기기가 ECDH P-256 키쌍 생성, 공개키만 릴레이를 통해 교환
 * 2. ECDH 공유 비밀 → HKDF-SHA256(salt=channelId, info=HKDF_INFO) → AES-GCM-256 키
 * 3. 메시지마다 랜덤 12바이트 IV, AAD = channelId (다른 채널로 옮겨 붙이기 방지)
 * 4. 페어링 시 양쪽 화면에 safety number를 띄워 사용자가 일치 여부를 확인 (릴레이 MITM 방어)
 */
import type { Envelope, OtpPayload } from "./types.js";
import { PAYLOAD_MAX_AGE_MS } from "./types.js";
import { fromBase64Url, toBase64Url } from "./encoding.js";

const HKDF_INFO = new TextEncoder().encode("otp-autofill/v1/aes-gcm");
const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;

export async function generateKeyPair(): Promise<CryptoKeyPair> {
  // 개인키는 extractable=false — 내보낼 수 없다 (IndexedDB에 CryptoKey 그대로 저장)
  return crypto.subtle.generateKey(ECDH, false, ["deriveBits"]);
}

export async function exportPublicKey(key: CryptoKey): Promise<string> {
  return toBase64Url(await crypto.subtle.exportKey("raw", key));
}

export async function importPublicKey(raw: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromBase64Url(raw), ECDH, true, []);
}

export async function deriveChannelKey(
  privateKey: CryptoKey,
  peerPublicKey: CryptoKey,
  channelId: string,
): Promise<CryptoKey> {
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: peerPublicKey }, privateKey, 256);
  const hkdfKey = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode(channelId), info: HKDF_INFO },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function sealPayload(key: CryptoKey, channelId: string, payload: OtpPayload): Promise<Envelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(channelId) },
    key,
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  return { v: 1, iv: toBase64Url(iv), ct: toBase64Url(ct) };
}

export class PayloadRejected extends Error {}

/**
 * 복호화 + 신선도 검사. 변조/다른 채널/오래된 메시지는 PayloadRejected.
 * 재전송(msgId 중복) 검사는 호출자가 seen 집합으로 수행한다.
 */
export async function openEnvelope(
  key: CryptoKey,
  channelId: string,
  env: Envelope,
  now: number = Date.now(),
): Promise<OtpPayload> {
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64Url(env.iv), additionalData: new TextEncoder().encode(channelId) },
      key,
      fromBase64Url(env.ct),
    );
  } catch {
    throw new PayloadRejected("복호화 실패 (키 불일치 또는 변조)");
  }
  const payload = JSON.parse(new TextDecoder().decode(plain)) as OtpPayload;
  if (payload.v !== 1) throw new PayloadRejected("지원하지 않는 버전");
  if (now - payload.receivedAt > PAYLOAD_MAX_AGE_MS) throw new PayloadRejected("만료된 메시지");
  if (payload.receivedAt - now > 60_000) throw new PayloadRejected("미래 시각 메시지");
  return payload;
}

/**
 * Safety number — 두 공개키(순서 무관)의 SHA-256에서 뽑은 "XXXX-XXXX" 16진 문자열.
 * OTP 숫자와 헷갈리지 않도록 숫자 6자리가 아닌 16진 그룹으로 표시한다.
 */
export async function safetyNumber(pubA: string, pubB: string): Promise<string> {
  const [x, y] = [pubA, pubB].sort();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${x}|${y}`)));
  const hex = Array.from(digest.slice(0, 4), (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}`;
}
