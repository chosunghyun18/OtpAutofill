// v2 브라우저 E2E — 실제 Chromium에 e2e 빌드 확장을 올리고, 목 Gmail API(:8790)로 인증 메일 → 알림 → 클릭 입력까지 검증한다.
// 실행: npm run e2e  (최초 1회 `npx playwright install chromium`)
//
// - 테스트 사이트는 Playwright ctx.route로 https://*.acme.test 등을 https 그대로 응답한다 (content script는 https://*/*에만 붙는다).
// - 헤드리스에서 OS 알림을 누를 수 없어, e2e 빌드 훅 __e2e.click(알림ID)이 실제 리스너와 같은 함수를 부른다.
//   알림 생성·삭제는 __e2e.notifs(래퍼 기록)와 chrome.notifications.getAll()로 함께 본다. 복사 내용은 __e2e.lastCopy.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type Frame, type Page, type Worker } from "playwright";
import { failAR, MockGmail, passAR } from "./mock-gmail.js";

const OUT = mkdtempSync(join(tmpdir(), "otp-e2e-v2-shots-")) + "/";
const EXT = new URL("../../extension/dist-e2e", import.meta.url).pathname;
const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- 테스트 사이트 ----------
const SIGNUP = `<!doctype html><meta charset=utf-8><title>signup</title>
  <h3>Acme 회원가입</h3>
  <form id=f><input id=email type=email name=email><button id=submit>인증메일 발송</button></form>
  <div id=after></div>
  <script>
    document.getElementById("f").addEventListener("submit", (e) => {
      e.preventDefault();
      document.getElementById("after").innerHTML =
        '<p>입력하신 이메일로 인증 메일을 발송했습니다.</p><label>인증번호 <input id=otp autocomplete="one-time-code" inputmode=numeric maxlength=6></label>';
    });
  </script>`;
const SPLIT = `<!doctype html><meta charset=utf-8><title>split</title>
  <form id=f onsubmit="return false"><input id=email name=userEmail placeholder="이메일"><button id=send type=button>인증 메일 받기</button></form>
  <div id=boxes></div>
  <script>
    document.getElementById("send").addEventListener("click", () => {
      document.getElementById("boxes").innerHTML = ${JSON.stringify(
        Array.from({ length: 6 }, (_, i) => `<input class=d${i} maxlength=1 size=1>`).join(""),
      )};
    });
  </script>`;
const SHOP_TOP = `<!doctype html><meta charset=utf-8><title>shop</title>
  <h3>Shop</h3><input id=search placeholder="검색">
  <iframe id=login src="https://login.shop.test/otp" width=500 height=200></iframe>
  <iframe id=ad src="https://widget.evil.test/otp" width=300 height=120></iframe>`;
const SHOP_LOGIN = `<!doctype html><meta charset=utf-8><title>login</title>
  <input id=email type=email><button id=send type=button>코드 받기</button>
  <div id=after></div>
  <script>
    document.getElementById("send").addEventListener("click", () => {
      document.getElementById("after").innerHTML = '<input id=otp autocomplete="one-time-code" maxlength=6>';
    });
  </script>`;
const EVIL_OTP = `<!doctype html><meta charset=utf-8><title>evil</title><label>인증번호 <input id=otp autocomplete="one-time-code" maxlength=6></label>`;
// 페이지 스크립트가 스스로 제출 (사용자 활성화 없음). page.evaluate는 userGesture로 실행돼 활성화가 생기므로 쓰지 않는다
const AUTO_SUBMIT = SIGNUP.replace("</script>", 'setTimeout(() => { document.getElementById("email").value = "x@example.test"; document.getElementById("f").requestSubmit(); }, 300);</script>');
const VERIFIED = `<!doctype html><meta charset=utf-8><title>verified</title><h1>인증 완료</h1>`;

const SITES: Record<string, string> = {
  "https://www.acme.test/signup": SIGNUP,
  "https://www.acme.test/split": SPLIT,
  "https://www.acme.test/auto": AUTO_SUBMIT,
  "https://www.acme.test/verify": VERIFIED,
  "https://www.shop.test/": SHOP_TOP,
  "https://login.shop.test/otp": SHOP_LOGIN,
  "https://widget.evil.test/otp": EVIL_OTP,
  "https://evil.test/otp": EVIL_OTP,
};

// ---------- 헬퍼 ----------
type Notif = { title: string; message: string; contextMessage?: string; buttons?: { title: string }[] };

let sw: Worker;
const hook = <T>(fn: string, arg?: unknown) =>
  sw.evaluate(([f, a]) => (globalThis as any).__e2e[f as string](a), [fn, arg] as const) as Promise<T>;
const notifs = () => sw.evaluate(() => [...(globalThis as any).__e2e.notifs.entries()]) as Promise<Array<[string, Notif]>>;
const lastCopy = () => sw.evaluate(() => (globalThis as any).__e2e.lastCopy) as Promise<string>;
const realNotifIds = () => sw.evaluate(() => new Promise<string[]>((r) => chrome.notifications.getAll((all) => r(Object.keys(all)))));
const state = () => hook<{ sessions: Record<string, any>; items: Record<string, any> }>("state");

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 8000): Promise<T | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(100);
  }
  return null;
}
const waitNotif = (pred: (id: string, n: Notif) => boolean, ms = 8000) =>
  waitFor(async () => (await notifs()).find(([id, n]) => pred(id, n)) ?? null, ms);
const waitSession = (ms = 5000) => waitFor(async () => Object.keys((await state()).sessions).length > 0, ms);

async function startSignup(ctx: BrowserContext): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto("https://www.acme.test/signup");
  await page.click("#email");
  await page.keyboard.type("me@example.test");
  await page.click("#submit"); // 실제 클릭 → 사용자 활성화 + submit 트리거
  await page.waitForSelector("#otp");
  return page;
}

async function main() {
  const gmail = new MockGmail();
  await gmail.listen(8790);
  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "otp-e2e-v2-")), {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    viewport: { width: 1000, height: 700 },
  });
  await ctx.route(/^https:\/\/[^/]*\.?(acme|shop|evil|other)\.test\//, (route) => {
    const u = new URL(route.request().url());
    const html = SITES[u.origin + u.pathname];
    return route.fulfill({ status: html ? 200 : 404, contentType: "text/html; charset=utf-8", body: html ?? "nf" });
  });

  try {
    sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
    const extId = sw.url().split("/")[2];
    check("확장 로드", !!extId, extId);

    // ---------- 연결 ----------
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.waitForFunction(() => document.getElementById("status")!.textContent!.includes("연결되지"));
    check("팝업: 미연결 상태", true);
    // 연결 전에는 트리거해도 감시하지 않는다
    const pre = await startSignup(ctx);
    await sleep(800);
    check("미연결 상태에서는 감시 안 함", Object.keys((await state()).sessions).length === 0);
    await pre.close();
    await popup.click("#connect");
    await popup.waitForFunction(() => document.getElementById("status")!.textContent!.startsWith("Gmail 연결됨"));
    check("팝업: Gmail 연결", true);

    // ---------- 1. 코드형: 폼 제출 트리거 → 제목 코드 → 알림 → 본문 클릭 입력 ----------
    const page = await startSignup(ctx);
    check("폼 제출 → 감시 세션 시작", !!(await waitSession()));
    const id1 = gmail.addMail({ from: "Acme <no-reply@acme.test>", subject: "[Acme] 인증번호 482913", authResults: [passAR("acme.test")], text: "Acme 가입 인증번호 482913 입니다." });
    const n1 = await waitNotif((id) => id === `otp-${id1}`);
    check("인증 메일 → 알림", !!n1, n1 ? `${n1[1].title} / ${n1[1].message}` : "알림 없음");
    if (n1) {
      check("알림 문구·버튼 [입력][복사]", n1[1].title === "acme.test · 인증번호" && n1[1].message === "482913" && n1[1].buttons?.map((b) => b.title).join() === "입력,복사");
      check("실제 chrome.notifications에도 생성", (await realNotifIds()).includes(n1[0]), (await realNotifIds()).join());
      check("제목에서 코드 → 본문(full) 안 읽음", gmail.fullReads(id1) === 0);
      check("클릭 전 페이지 DOM에 코드 없음", !(await page.evaluate(() => document.documentElement.outerHTML.includes("482913"))));
      await popup.bringToFront();
      await hook("click", n1[0]);
      await page.waitForFunction(() => (document.getElementById("otp") as HTMLInputElement).value === "482913", null, { timeout: 5000 }).catch(() => undefined);
      check("본문 클릭 → 입력칸 입력", (await page.inputValue("#otp")) === "482913");
      check("클릭 시 그 탭으로 전환", (await page.evaluate(() => document.visibilityState)) === "visible");
      const s = await state();
      check(
        "사용 후 알림·아이템·세션 삭제",
        !(await notifs()).some(([id]) => id === n1[0]) && !(await realNotifIds()).includes(n1[0]) && Object.keys(s.items).length === 0 && Object.keys(s.sessions).length === 0,
        JSON.stringify({ notifs: (await notifs()).map(([id]) => id), real: await realNotifIds(), items: Object.keys(s.items), sessions: Object.keys(s.sessions) }),
      );
      await page.screenshot({ path: OUT + "1-code-filled.png" });
    }
    await page.close();

    // ---------- 2. 분할칸 + HTML 본문에만 코드 (metadata 실패 → full) ----------
    const split = await ctx.newPage();
    await split.goto("https://www.acme.test/split");
    await split.click("#email");
    await split.keyboard.type("me@example.test");
    await split.click("#send");
    check("버튼 클릭(SPA) → 감시 세션", !!(await waitSession()));
    const html2 = `<table><tr><td>Acme 이메일 인증</td></tr><tr><td>아래 인증번호를 입력해 주세요</td></tr><tr><td style="font-size:30px"><b>246801</b></td></tr><tr><td>© 2026 Acme 서울시 강남구 123</td></tr></table>`;
    const id2 = gmail.addMail({ from: "no-reply@mail.acme.test", subject: "Acme 회원가입을 완료해 주세요", authResults: [passAR("mail.acme.test")], html: html2, snippet: "Acme에 가입해 주셔서 감사합니다" });
    const n2 = await waitNotif((id) => id === `otp-${id2}`);
    check("HTML 본문 코드 → 알림 (본문 1회 조회)", !!n2 && gmail.fullReads(id2) === 1, n2?.[1].message);
    if (n2) {
      await hook("click", n2[0]);
      await split.waitForFunction(() => (document.querySelector(".d5") as HTMLInputElement).value !== "", null, { timeout: 5000 }).catch(() => undefined);
      const v = await split.evaluate(() => Array.from(document.querySelectorAll("#boxes input"), (i) => (i as HTMLInputElement).value).join(""));
      check("분할 6칸에 한 자리씩", v === "246801", v);
      await split.screenshot({ path: OUT + "2-split.png" });
    }
    await split.close();

    // ---------- 3. 크로스 오리진 iframe (login.shop.test in www.shop.test) ----------
    const shop = await ctx.newPage();
    await shop.goto("https://www.shop.test/");
    const login = await waitFor(async () => shop.frames().find((f) => f.url().startsWith("https://login.shop.test")) ?? null);
    const ad = shop.frames().find((f) => f.url().startsWith("https://widget.evil.test")) as Frame | undefined;
    if (!login || !ad) check("iframe 로드", false);
    else {
      await login.click("#email");
      await shop.keyboard.type("me@example.test");
      await login.click("#send");
      await login.waitForSelector("#otp");
      check("iframe 안 트리거 → 감시 세션", !!(await waitSession()));
      await sleep(800);
      const sites = Object.values((await state()).sessions)[0]?.sites;
      check("활성화 없는 광고 iframe(evil)은 세션 사이트에 안 들어감", JSON.stringify(sites) === '["shop.test"]', JSON.stringify(sites));
      const id3 = gmail.addMail({ from: "Shop <auth@shop.test>", subject: "Shop 로그인 코드 731904", authResults: [passAR("shop.test")], text: "로그인 코드 731904" });
      const n3 = await waitNotif((id) => id === `otp-${id3}`);
      check("iframe 사이트 메일 → 알림", !!n3);
      if (n3) {
        await hook("click", n3[0]);
        await waitFor(async () => (await login.inputValue("#otp")) === "731904", 5000);
        check("크로스 오리진 iframe 입력칸에 입력", (await login.inputValue("#otp")) === "731904");
        check("다른 사이트 iframe(evil)에는 입력 안 됨", (await ad.inputValue("#otp")) === "");
        check("최상위 프레임 입력칸 그대로", (await shop.inputValue("#search")) === "");
        await shop.screenshot({ path: OUT + "3-iframe.png" });
      }
    }
    await shop.close();

    // ---------- 4. 링크형 ----------
    const p4 = await startSignup(ctx);
    await waitSession();
    const id4 = gmail.addMail({
      from: "Acme <no-reply@acme.test>",
      subject: "Acme 이메일 주소를 확인해 주세요",
      authResults: [passAR("acme.test")],
      html: `<p>아래 버튼을 눌러 가입을 완료하세요.</p><a href="https://www.acme.test/verify?t=abc&amp;u=1">이메일 인증하기</a> <a href="https://www.acme.test/unsubscribe">수신거부</a>`,
    });
    const n4 = await waitNotif((id) => id === `otp-${id4}`);
    check("링크형 알림 [열기][링크 복사]", !!n4 && n4[1].title === "acme.test · 이메일 인증 링크" && n4[1].buttons?.map((b) => b.title).join() === "열기,링크 복사", n4?.[1].message);
    if (n4) {
      const opened = ctx.waitForEvent("page", { timeout: 5000 }).catch(() => null);
      await hook("click", n4[0]);
      const vp = await opened;
      await vp?.waitForLoadState().catch(() => undefined);
      // 확장이 연 탭은 route가 붙기 전에 이동을 시작할 수 있어, 화면 대신 탐색 기록의 요청 주소를 본다
      let navUrl = vp?.url();
      if (vp) {
        const c = await ctx.newCDPSession(vp);
        const h = (await c.send("Page.getNavigationHistory")) as { entries: Array<{ url: string; userTypedURL: string }> };
        navUrl = h.entries.at(-1)?.userTypedURL || h.entries.at(-1)?.url || navUrl;
        await c.detach();
      }
      check("클릭 → 새 탭에서 인증 링크", navUrl === "https://www.acme.test/verify?t=abc&u=1", navUrl);
      await vp?.close();
    }
    await p4.close();

    // ---------- 5. 클릭 시점 사이트 불일치 → 입력 안 함 + 복사 + 경고 ----------
    const p5 = await startSignup(ctx);
    await waitSession();
    const id5 = gmail.addMail({ from: "Acme <no-reply@acme.test>", subject: "[Acme] 인증번호 550011", authResults: [passAR("acme.test")] });
    const n5 = await waitNotif((id) => id === `otp-${id5}`);
    if (n5) {
      await p5.goto("https://evil.test/otp"); // 알림을 누르기 전에 탭이 다른 사이트로 바뀜
      await hook("click", n5[0]);
      await sleep(800);
      check("불일치 사이트에는 입력 안 함", (await p5.inputValue("#otp")) === "");
      check("불일치 → 복사", (await lastCopy()) === "550011");
      const w = (await notifs()).find(([id]) => id === `${n5[0]}:warn`);
      check("불일치 경고 알림 (코드 미포함)", !!w && w[1].message.includes("복사만") && !w[1].message.includes("550011"), w?.[1].message);
    } else check("불일치 시나리오 알림", false);
    await p5.close();

    // ---------- 6. 미인증(맨 위 fail + 아래쪽 위조 pass) → 경고 + 복사만 ----------
    const p6 = await startSignup(ctx);
    await waitSession();
    const id6 = gmail.addMail({ from: "Acme <no-reply@acme.test>", subject: "[Acme] 인증번호 660022", authResults: [failAR("acme.test"), passAR("acme.test")] });
    const n6 = await waitNotif((id) => id === `otp-${id6}`);
    check("미인증 메일 → 경고 알림, [복사]만", !!n6 && n6[1].title.startsWith("⚠") && n6[1].buttons?.map((b) => b.title).join() === "복사", n6 ? `${n6[1].title} ${n6[1].contextMessage}` : "알림 없음");
    if (n6) {
      await hook("click", n6[0]);
      await sleep(500);
      check("미인증 → 입력 안 함, 복사", (await p6.inputValue("#otp")) === "" && (await lastCopy()) === "660022");
    }

    // ---------- 7. 무관 메일 → 무알림, 본문 안 읽음 ----------
    const id7 = gmail.addMail({ from: "Other <hi@other.test>", subject: "[Other] 인증번호 770033", authResults: [passAR("other.test")] });
    await sleep(1500);
    check("감시 사이트와 무관한 메일 → 알림 없음", !(await notifs()).some(([id]) => id === `otp-${id7}`));
    check("무관 메일은 metadata 1회만 (틱마다 다시 읽지 않음, 본문 미조회)", gmail.metadataReads(id7) === 1 && gmail.fullReads(id7) === 0, `metadata ${gmail.metadataReads(id7)}회`);
    // 도착 직후 삭제된 메일(404)이 있어도 뒤따르는 메일은 처리된다
    const gone = gmail.addMail({ from: "Acme <no-reply@acme.test>", subject: "[Acme] 인증번호 770044", authResults: [passAR("acme.test")] });
    gmail.deleteMail(gone);
    const id7b = gmail.addMail({ from: "Acme <no-reply@acme.test>", subject: "[Acme] 인증번호 770055", authResults: [passAR("acme.test")] });
    check("삭제된 메일(404) 뒤의 메일도 알림", !!(await waitNotif((id) => id === `otp-${id7b}`)));
    await p6.close();
    check("탭 닫힘 → 그 탭 감시 종료", !!(await waitFor(async () => Object.keys((await state()).sessions).length === 0, 3000)), JSON.stringify((await state()).sessions));

    // ---------- 8. 트리거 전 메일: 2분 넘게 지난 건 무시, 최근 건 되돌아보기로 받음 ----------
    const old = gmail.addMail({ from: "Acme <no-reply@acme.test>", subject: "[Acme] 인증번호 880044", authResults: [passAR("acme.test")], internalDate: Date.now() - 5 * 60_000 });
    const p8a = await startSignup(ctx);
    await waitSession();
    await sleep(1200);
    check("트리거 전 오래된 메일 무시", !(await notifs()).some(([id]) => id === `otp-${old}`));
    await p8a.close();
    await hook("sweep", Date.now() + 11 * 60_000); // 세션 정리
    const recent = gmail.addMail({ from: "Acme <no-reply@acme.test>", subject: "[Acme] 인증번호 880055", authResults: [passAR("acme.test")], internalDate: Date.now() - 30_000 });
    const p8b = await startSignup(ctx);
    const n8 = await waitNotif((id) => id === `otp-${recent}`);
    check("늦은 트리거: 30초 전 도착 메일은 되돌아보기로 알림", !!n8);

    // ---------- 9. 만료 → 알림·아이템 삭제 ----------
    await sleep(1000); // 되돌아보기 알림이 먼저 와서, 페이지의 문구·입력칸 트리거(500ms 묶음)가 sweep 뒤에 세션을 다시 만들지 않게 기다린다
    check("만료 전 아이템 있음", Object.keys((await state()).items).length > 0);
    await hook("sweep", Date.now() + 11 * 60_000);
    await sleep(300);
    const s9 = await state();
    const left = (await notifs()).map(([id]) => id);
    check("10분 TTL → 아이템·세션·알림 삭제", Object.keys(s9.items).length === 0 && Object.keys(s9.sessions).length === 0 && left.length === 0, JSON.stringify({ left, items: s9.items, sessions: s9.sessions }));
    await p8b.close();

    // ---------- 10. 페이지가 사용자 활성화 없이 트리거 → 감시 안 함 ----------
    const p10 = await ctx.newPage();
    await p10.goto("https://www.acme.test/auto");
    // waitForSelector·evaluate도 사용자 제스처로 실행돼 활성화가 생기므로 페이지를 건드리지 않고 기다린다
    await sleep(1500);
    const s10 = await state();
    check("사용자 활성화 없는 트리거 → 감시 안 함", Object.keys(s10.sessions).length === 0, JSON.stringify(s10.sessions));
    await p10.close();

    // ---------- 11. 서비스 워커 종료 후 입력칸 포커스로 재개 ----------
    const p11 = await startSignup(ctx);
    await waitSession();
    const cdp = await ctx.newCDPSession(p11);
    const { targetInfos } = (await cdp.send("Target.getTargets")) as { targetInfos: Array<{ targetId: string; type: string; url: string }> };
    const swTarget = targetInfos.find((t) => t.type === "service_worker" && t.url.includes(extId!));
    const stopped = swTarget ? await cdp.send("Target.closeTarget", { targetId: swTarget.targetId }).then(() => true, () => false) : false;
    if (!stopped) check("서비스 워커 강제 종료 (CDP)", false, "지원 안 됨 — 건너뜀");
    else {
      await sleep(500);
      const id11 = gmail.addMail({ from: "Acme <no-reply@acme.test>", subject: "[Acme] 인증번호 110066", authResults: [passAR("acme.test")] });
      const next = ctx.waitForEvent("serviceworker", { timeout: 10_000 }).catch(() => null);
      await p11.click("#otp"); // 포커스 → content가 메시지 → 워커 기동
      sw = (await next) ?? ctx.serviceWorkers()[0]!;
      const n11 = await waitNotif((id) => id === `otp-${id11}`, 10_000);
      check("워커 종료 후 입력칸 포커스 → 재개·알림", !!n11);
      if (n11) {
        await hook("click", n11[0]);
        await waitFor(async () => (await p11.inputValue("#otp")) === "110066", 5000);
        check("재기동 워커에서도 클릭 입력", (await p11.inputValue("#otp")) === "110066");
      }
    }
    await p11.close();

    // ---------- 12. 팝업 최근 항목 · 연결 해제 ----------
    const p12 = await startSignup(ctx);
    await waitSession();
    const id12 = gmail.addMail({ from: "Acme <no-reply@acme.test>", subject: "[Acme] 인증번호 121212", authResults: [passAR("acme.test")] });
    check("팝업 시나리오 알림", !!(await waitNotif((id) => id === `otp-${id12}`)), JSON.stringify((await state()).sessions));
    await popup.bringToFront();
    // 백그라운드 탭의 2초 갱신 타이머는 느려질 수 있어 새 코드가 그려질 때까지 기다린다
    await popup.waitForFunction(() => document.getElementById("items")!.textContent!.includes("121212"), null, { timeout: 8000 }).catch(() => undefined);
    check("팝업 최근 항목에 코드", ((await popup.textContent("#items")) ?? "").includes("121212"), (await popup.textContent("#items")) ?? "");
    await popup.screenshot({ path: OUT + "12-popup.png" });
    await popup.click("#disconnect");
    await popup.waitForFunction(() => document.getElementById("status")!.textContent!.includes("연결되지"));
    const s12 = await state();
    check("연결 해제 → 코드·세션·알림 삭제", Object.keys(s12.items).length === 0 && Object.keys(s12.sessions).length === 0 && (await notifs()).length === 0);
    await p12.close();
  } finally {
    await ctx.close();
    gmail.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 통과 · 스크린샷 ${OUT}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
