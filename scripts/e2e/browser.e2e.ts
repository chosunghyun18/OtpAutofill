// 브라우저 E2E — 실제 Chromium에 확장을 올리고, 실제 릴레이와 fake-phone으로 페어링~입력까지 검증한다.
// 실행: npm run e2e  (최초 1회 `npx playwright install chromium`, 포트 8787·5173 사용)
// 칩은 closed shadow DOM이라 호스트 위치를 실제 마우스로 클릭하고(isTrusted), 문구는 접근성 트리(CDP)로 읽는다.
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

async function main() {
  const relay = createRelayServer();
  await new Promise<void>((r) => relay.listen(8787, "localhost", r));
  await new Promise<void>((r) => pageServer.listen(5173, "localhost", r));
  const site = "http://localhost:5173";

  const ctx: BrowserContext = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "otp-e2e-")), {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    viewport: { width: 900, height: 600 },
  });
  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent("serviceworker");
    const extId = sw.url().split("/")[2];
    check("확장 로드 (MV3 서비스 워커 기동)", !!extId, extId);
    const badge = () => sw.evaluate(() => chrome.action.getBadgeText({}));

    // ---------- 페어링 ----------
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    check("팝업 초기 상태", (await popup.textContent("#pairStatus")) === "페어링되지 않음");
    await popup.click("#pair");
    await popup.waitForFunction(() => /페어링 코드 입력: \w{8}/.test(document.getElementById("pairStatus")!.textContent!));
    const code = (await popup.textContent("#pairStatus"))!.match(/(\w{8})$/)![1]!;
    check("페어링 코드 표시", /^[A-Z2-9]{8}$/.test(code), code);
    await popup.screenshot({ path: OUT + "1-popup-code.png" });

    const phone = await joinAsPhone(RELAY, code, { pollMs: 200 });
    await popup.waitForSelector("#verify:not([hidden])", { timeout: 10_000 });
    const sn = await popup.textContent("#sn");
    check("안전번호 양쪽 일치 (커밋-공개 경유)", sn === phone.safetyNumber, `${sn} / phone ${phone.safetyNumber}`);
    check("확인 대기 배지 '?'", (await badge()) === "?");
    await popup.screenshot({ path: OUT + "2-popup-verify.png" });

    // 확인 전에는 수신하지 않는다: 지금 보낸 문자는 릴레이에 남아 있어야 한다
    await sendSms(phone, "[Web발신] 인증번호 [999999] 확인 전 문자", "테스트");
    await sleep(1500);
    const stats1 = await (await fetch(`${RELAY}/healthz`)).json();
    check("확인 전에는 릴레이에서 가져가지 않음", stats1.queued === 1, JSON.stringify(stats1));

    await popup.click("#match");
    await popup.waitForFunction(() => document.getElementById("pairStatus")!.textContent!.startsWith("페어링됨"));
    check("일치함 → 페어링 완료", true, await popup.textContent("#pairStatus") ?? "");
    await popup.screenshot({ path: OUT + "3-popup-paired.png" });
    await sleep(1500);
    const stats2 = await (await fetch(`${RELAY}/healthz`)).json();
    check("확인 후 대기 문자 수신 (큐 비움)", stats2.queued === 0, JSON.stringify(stats2));
    // 확인 전 문자 코드는 수신됐지만 다음 테스트에 섞이지 않게 팝업에서 확인만
    const peek0 = await popup.evaluate(() => chrome.runtime.sendMessage({ type: "otp:peek" }));
    check("팝업 최근 코드 표시(확인 전 보낸 문자)", peek0?.code === "999999");

    // ---------- 단일 입력칸 ----------
    const page = await ctx.newPage();
    await page.goto(site + "/single");
    await page.bringToFront();
    await page.click("#otp"); // focusin → 콘텐츠가 조회
    let chip = await waitChip(page, 3000);
    // 999999가 아직 유효하니 칩이 이미 떠 있을 수 있다 → 그걸로 먼저 입력 검증
    if (chip) {
      await clickChip(page, chip.box);
      await page.waitForFunction(() => (document.getElementById("otp") as HTMLInputElement).value !== "");
      check("기존 코드 칩 클릭 → 입력", (await page.inputValue("#otp")) === "999999");
      await page.fill("#otp", "");
    }

    const t0 = Date.now();
    await sendSms(phone, "[Web발신]\n인증번호 [482913]를 입력해주세요. 타인 노출 금지", "알림");
    chip = await waitChip(page, 10_000);
    check("문자 → 칩 표시", !!chip, chip ? `fake-phone 전송~칩 ${Date.now() - t0}ms` : "칩 없음");
    if (chip) {
      const text = await chipText(page);
      check("칩에 코드 숫자 미노출(●) + 호스트 표시", !!text && !/482913/.test(text) && /●{6}/.test(text) && text.includes("localhost"), text ?? "");
      check("서비스명 없는 문자 → 경고 없음", !!text && !text.includes("⚠"));
      const domHasCode = await page.evaluate(() => document.documentElement.outerHTML.includes("482913"));
      check("클릭 전 페이지 DOM에 코드 없음", !domHasCode);
      await page.screenshot({ path: OUT + "4-single-chip.png" });

      // 페이지 스크립트의 합성 클릭은 무시돼야 한다 — closed shadow라 버튼에 접근 자체가 안 됨을 확인
      const reachable = await page.evaluate(() => {
        const host = Array.from(document.documentElement.children).find(
          (el) => (el as HTMLElement).style?.zIndex === "2147483647",
        ) as HTMLElement;
        return host.shadowRoot !== null;
      });
      check("칩 shadowRoot 페이지에서 접근 불가(closed)", !reachable);

      await clickChip(page, chip.box);
      await page.waitForFunction(() => (document.getElementById("otp") as HTMLInputElement).value !== "", null, { timeout: 5000 });
      check("칩 클릭 → 단일 입력칸 입력", (await page.inputValue("#otp")) === "482913");
      check("입력 후 칩 제거", (await chipBox(page)) === null);
      const peek = await popup.evaluate(() => chrome.runtime.sendMessage({ type: "otp:peek" }));
      check("1회 사용 후 코드 삭제", peek === null);
      check("사용 후 배지 비움", (await badge()) === "");
      await page.screenshot({ path: OUT + "5-single-filled.png" });
    }

    // ---------- 서비스명 경고 ----------
    await page.fill("#otp", "");
    await sendSms(phone, "[Web발신]\n[네이버] 인증번호 [135790]를 입력해주세요.", "네이버");
    chip = await waitChip(page, 10_000);
    const warnText = chip ? await chipText(page) : null;
    check("[네이버] 문자 on localhost → 경고 칩", !!warnText && warnText.includes("⚠") && warnText.includes("네이버"), warnText ?? "칩 없음");
    await page.screenshot({ path: OUT + "6-warning-chip.png" });
    if (chip) {
      await clickChip(page, chip.box);
      await page.waitForFunction(() => (document.getElementById("otp") as HTMLInputElement).value !== "", null, { timeout: 5000 });
      check("경고 칩도 클릭하면 입력(차단 아님)", (await page.inputValue("#otp")) === "135790");
    }

    // ---------- 분할 입력칸 ----------
    const split = await ctx.newPage();
    await split.goto(site + "/split");
    await split.bringToFront();
    await split.click(".d0");
    await sendSms(phone, "Your verification code is 246801", "Test");
    chip = await waitChip(split, 10_000);
    check("분할 입력칸에 칩 표시", !!chip);
    if (chip) {
      await clickChip(split, chip.box);
      await split.waitForFunction(() => (document.querySelector(".d5") as HTMLInputElement).value !== "", null, { timeout: 5000 });
      const v = await split.evaluate(() => Array.from(document.querySelectorAll("#boxes input"), (i) => (i as HTMLInputElement).value).join(""));
      check("분할 6칸에 한 자리씩 입력", v === "246801", v);
      await split.screenshot({ path: OUT + "7-split-filled.png" });
    }

    // ---------- React 제어 입력 ----------
    const react = await ctx.newPage();
    await react.goto(site + "/react");
    const reactLoaded = await react.waitForSelector("#otp", { timeout: 10_000 }).then(() => true, () => false);
    if (!reactLoaded) check("React 페이지 로드", false, "CDN 접근 실패");
    else {
      await react.bringToFront();
      await react.click("#otp");
      await sendSms(phone, "[Web발신] 본인확인 인증번호(864213)입력시 정상처리 됩니다.", "Test");
      chip = await waitChip(react, 10_000);
      check("React 입력칸(name=verificationCode)에 칩 표시", !!chip);
      if (chip) {
        await clickChip(react, chip.box);
        await react.waitForFunction(() => document.getElementById("state")!.textContent === "state=864213", null, { timeout: 5000 }).catch(() => undefined);
        check("React state까지 반영", (await react.textContent("#state")) === "state=864213", (await react.textContent("#state")) ?? "");
        await react.screenshot({ path: OUT + "8-react-filled.png" });
      }
    }

    // ---------- 피싱: origin-bound 불일치 ----------
    await page.bringToFront();
    await page.fill("#otp", "");
    await page.click("#otp");
    await sendSms(phone, "인증번호 112233\n\n@bank.example.com #112233", "Bank");
    chip = await waitChip(page, 4000);
    check("WebOTP 도메인 불일치(bank.example.com ≠ localhost) → 칩 없음", chip === null);
    const peekBound = await popup.evaluate(() => chrome.runtime.sendMessage({ type: "otp:peek" }));
    check("팝업에는 도메인 전용 코드로 표시", peekBound?.boundOrigin === "bank.example.com");
    // ---------- 해제 ----------
    await popup.bringToFront();
    await popup.click("#unpair");
    await popup.waitForFunction(() => document.getElementById("pairStatus")!.textContent === "페어링되지 않음");
    const sendAfter = await sendSms(phone, "인증번호 000000").then(() => "sent", (e: Error) => e.message);
    check("해제 후 폰 전송 거부(401)", /401/.test(sendAfter), sendAfter);

    // ---------- 안전번호 불일치 경로 ----------
    await popup.click("#pair");
    await popup.waitForFunction(() => /페어링 코드 입력: \w{8}/.test(document.getElementById("pairStatus")!.textContent!));
    const code2 = (await popup.textContent("#pairStatus"))!.match(/(\w{8})$/)![1]!;
    const phone2 = await joinAsPhone(RELAY, code2, { pollMs: 200 });
    await popup.waitForSelector("#verify:not([hidden])");
    await popup.click("#mismatch");
    await popup.waitForFunction(() => document.getElementById("pairStatus")!.textContent === "페어링되지 않음");
    const notice = await popup.textContent("#notice");
    check("다름 → 해제 + MITM 안내", !!notice?.includes("릴레이"), notice ?? "");
    await popup.screenshot({ path: OUT + "9-popup-mismatch.png" });
    const sendAfter2 = await sendSms(phone2, "인증번호 000000").then(() => "sent", (e: Error) => e.message);
    check("다름 후 그 채널 전송 거부", /401/.test(sendAfter2), sendAfter2);
  } finally {
    await ctx.close();
    relay.close();
    pageServer.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 통과 · 스크린샷 ${OUT}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
