/**
 * 채널 키 보관 — IndexedDB에 CryptoKey 객체를 그대로 저장 (extractable=false 유지).
 * chrome.storage에는 JSON만 들어가므로 키를 내보내야 해서 쓰지 않는다.
 */
const DB = "otp-autofill";
const STORE = "keys";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const keystore = {
  get: (name: string) => tx<CryptoKey | CryptoKeyPair | undefined>("readonly", (s) => s.get(name)),
  put: (name: string, key: CryptoKey | CryptoKeyPair) => tx("readwrite", (s) => s.put(key, name)),
  clear: () => tx("readwrite", (s) => s.clear()),
};
