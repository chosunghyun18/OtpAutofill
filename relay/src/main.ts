import { createRelayServer } from "./server.js";
import { RelayStore } from "./store.js";

const port = Number(process.env.PORT ?? 8787);
const store = new RelayStore();
setInterval(() => store.sweep(), 30_000).unref();

createRelayServer(store).listen(port, () => {
  console.log(`[relay] listening on :${port} (in-memory, no persistence)`);
});
