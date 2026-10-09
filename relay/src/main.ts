import { RateLimiter } from "./ratelimit.js";
import { createRelayServer } from "./server.js";
import { RelayStore } from "./store.js";

const port = Number(process.env.PORT ?? 8787);
const store = new RelayStore();
const pairingLimiter = new RateLimiter();
setInterval(() => {
  store.sweep();
  pairingLimiter.sweep();
}, 30_000).unref();

// TRUST_PROXY=<앞단 프록시 수> — 예: Fly.io 단독이면 1, Cloudflare→Fly면 2
const trustedProxyHops = Number(process.env.TRUST_PROXY ?? 0) || 0;
createRelayServer(store, { pairingLimiter, trustedProxyHops }).listen(port, () => {
  console.log(`[relay] listening on :${port} (in-memory, no persistence)`);
});
