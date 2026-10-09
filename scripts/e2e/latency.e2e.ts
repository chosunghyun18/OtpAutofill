// 수신 → 칩 표시 지연 실측. 활성 / 유휴(IDLE_SEC, 기본 120) / 서비스 워커 강제 종료 후(입력칸 포커스로 재개).
// 실행: npm run e2e:latency
// 주의: Playwright가 디버거로 붙어 있어 유휴 시 워커 자동 종료가 실제 크롬과 다를 수 있다.
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page, type BrowserContext } from "playwright";
import { joinAsPhone, sendSms } from "../fake-phone.js";
import { createRelayServer } from "../../relay/src/server.js";

// 스크린샷은 저장소 밖(OS 임시 폴더)에 남긴다
const OUT = mkdtempSync(join(tmpdir(), "otp-e2e-shots-")) + "/";
const EXT = new URL("../../extension/dist", import.meta.url).pathname;
const RELAY = "http://localhost:8787";
const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- 테스트 페이지 ----------
const PAGES: Record<string, string> = {
  "/single": `<!doctype html><meta charset=utf-8><title>single</title>
    <h3>로그인 2단계 인증</h3><label>인증번호 <input id=otp autocomplete="one-time-code" inputmode=numeric maxlength=6></label>`,
  "/split": `<!doctype html><meta charset=utf-8><title>split</title>
    <h3>분할 입력칸</h3><div><div id=boxes>${Array.from({ length: 6 }, (_, i) => `<input class=d${i} maxlength=1 size=1>`).join("")}</div></div>`,
  "/react": `<!doctype html><meta charset=utf-8><title>react</title>
    <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
    <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
    <div id=root></div><script>
      const e = React.createElement;
      function App(){ const [v,setV]=React.useState(""); return e("div",null,
        e("input",{id:"otp",name:"verificationCode",placeholder:"인증번호 6자리",maxLength:6,value:v,onChange:ev=>setV(ev.target.value)}),
        e("p",{id:"state"},"state="+v)); }
      ReactDOM.createRoot(document.getElementById("root")).render(e(App));
    </script>`,
};
const pageServer = createServer((req, res) => {
  const html = PAGES[req.url ?? ""];
  res.writeHead(html ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
  res.end(html ?? "nf");
});

async function chipBox(page: Page) {
  // 칩은 closed shadow DOM → 호스트 div 위치만 본다
  return page.evaluate(() => {
    const host = Array.from(document.documentElement.children).find(
      (el) => el instanceof HTMLDivElement && el.style.zIndex === "2147483647",
    ) as HTMLElement | undefined;
    if (!host) return null;
    const r = host.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
}

async function chipText(page: Page): Promise<string | null> {
  // closed shadow 안의 버튼 이름은 접근성 트리(CDP)로 읽는다
  const cdp = await page.context().newCDPSession(page);
  const { nodes } = (await cdp.send("Accessibility.getFullAXTree")) as { nodes: any[] };
  await cdp.detach();
  const btn = nodes.find((n) => n.role?.value === "button" && String(n.name?.value ?? "").includes("인증번호 입력"));
  return btn ? String(btn.name.value) : null;
}

async function waitChip(page: Page, timeoutMs: number) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const b = await chipBox(page);
    if (b && b.w > 0) return { box: b, ms: Date.now() - t0 };
    await sleep(50);
  }
  return null;
}

async function clickChip(page: Page, box: { x: number; y: number; w: number; h: number }) {
  await page.mouse.click(box.x + box.w / 2, box.y + box.h / 2); // 실제 입력 이벤트 → isTrusted
}


async function setup() {
  const relay = createRelayServer();
  await new Promise<void>((r) => relay.listen(8787, "localhost", r));
  await new Promise<void>((r) => pageServer.listen(5173, "localhost", r));
  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "otp-lat-")), {
    channel: "chromium", headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker");
  const extId = sw.url().split("/")[2];
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.click("#pair");
  await popup.waitForFunction(() => /페어링 코드 입력: \w{8}/.test(document.getElementById("pairStatus")!.textContent!));
  const code = (await popup.textContent("#pairStatus"))!.match(/(\w{8})$/)![1]!;
  const phone = await joinAsPhone(RELAY, code, { pollMs: 200 });
  await popup.waitForSelector("#verify:not([hidden])");
  await popup.click("#match");
  await popup.close(); // 팝업이 열려 있으면 워커가 계속 살아 있으므로 닫는다
  const page = await ctx.newPage();
  await page.goto("http://localhost:5173/single");
  await page.bringToFront();
  await page.click("#otp");
  return { relay, ctx, phone, page };
}

async function measure(label: string, page: Page, phone: any, focusAfterMs = -1) {
  await page.fill("#otp", "");
  if (focusAfterMs >= 0) await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  const code = String(100000 + Math.floor(Math.random() * 899999));
  const t0 = Date.now();
  await sendSms(phone, `[Web발신] 인증번호 [${code}]`);
  if (focusAfterMs >= 0) { await sleep(focusAfterMs); await page.click("#otp"); }
  const chip = await waitChip(page, 60_000);
  const ms = chip ? Date.now() - t0 : -1;
  console.log(`${label}: ${chip ? ms + "ms" : "60초 내 칩 없음"}`);
  if (chip) {
    await clickChip(page, chip.box);
    await page.waitForFunction(() => (document.getElementById("otp") as HTMLInputElement).value !== "", null, { timeout: 5000 }).catch(() => {});
  }
  return ms;
}

async function main() {
  const { relay, ctx, phone, page } = await setup();
  const swAlive = () => ctx.serviceWorkers().length;
  try {
    const warm: number[] = [];
    for (let i = 0; i < 5; i++) { warm.push(await measure(`활성 #${i + 1}`, page, phone)); await sleep(500); }
    const idleSec = Number(process.env.IDLE_SEC ?? 120);
    console.log(`유휴 ${idleSec}초 대기…`);
    await sleep(idleSec * 1000);
    console.log(`유휴 후 서비스 워커 수: ${swAlive()}`);
    const idle = await measure(`유휴 ${idleSec}s 후`, page, phone);

    // 강제 종료: CDP로 서비스 워커 중지
    const browserCdp = await ctx.browser()?.newBrowserCDPSession?.();
    const cdp = browserCdp ?? (await ctx.newCDPSession(page));
    const forced: number[] = [];
    for (let i = 0; i < 3; i++) {
      const { targetInfos } = (await cdp.send("Target.getTargets")) as any;
      const swT = targetInfos.find((t: any) => t.type === "service_worker" && t.url.startsWith("chrome-extension://"));
      if (swT) await cdp.send("Target.closeTarget", { targetId: swT.targetId }).catch((e: any) => console.log("closeTarget", e.message));
      await sleep(1000);
      const { targetInfos: after } = (await cdp.send("Target.getTargets")) as any;
      console.log(`강제 종료 후 SW 타깃: ${after.filter((t: any) => t.type === "service_worker").length}`);
      forced.push(await measure(`강제 종료 후 #${i + 1} (문자 1초 뒤 입력칸 포커스)`, page, phone, 1000));
    }
    console.log(JSON.stringify({ warm, idle, forced }));
  } finally {
    await ctx.close(); relay.close(); pageServer.close();
  }
}
main().catch((e) => { console.error(e); process.exit(2); });
