// 확장 프로그램 빌드 — esbuild로 번들 후 출력 폴더에 manifest·html 복사.
// chrome://extensions → "압축해제된 확장 프로그램을 로드" → extension/dist 선택
//   node build.mjs          → dist/      v2 실사용 (chrome.identity + gmail.googleapis.com)
//   node build.mjs --e2e    → dist-e2e/  v2 E2E (고정 토큰, 목 Gmail http://localhost:8790, 테스트 훅 __e2e)
//   node build.mjs --v1     → dist-v1/   v1 SMS 경로 (보류, npm run e2e:v1)
import { build, context } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const watch = process.argv.includes("--watch");
const e2e = process.argv.includes("--e2e");
const v1 = process.argv.includes("--v1");
const out = v1 ? "dist-v1" : e2e ? "dist-e2e" : "dist";

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(v1 ? "public-v1" : "public", out, { recursive: true });

const E2E_GMAIL = "http://localhost:8790";
if (e2e) {
  // 목 Gmail 서버에 서비스 워커가 fetch할 수 있게 호스트 권한을 더한다
  const mf = JSON.parse(readFileSync(`${out}/manifest.json`, "utf8"));
  mf.host_permissions = [...mf.host_permissions, `${E2E_GMAIL}/*`];
  mf.name += " (E2E)";
  writeFileSync(`${out}/manifest.json`, JSON.stringify(mf, null, 2));
}

const define = {
  __E2E__: String(e2e),
  __GMAIL_BASE__: JSON.stringify(e2e ? `${E2E_GMAIL}/gmail/v1/users/me` : "https://gmail.googleapis.com/gmail/v1/users/me"),
  __POLL_MS__: e2e ? "300" : "5000",
};
// minifySyntax: define으로 false가 된 e2e 분기를 실제로 제거한다 (식별자·공백은 그대로)
const common = { bundle: true, target: "chrome120", sourcemap: true, logLevel: "info", define, minifySyntax: !v1 };
const src = v1 ? "src/v1" : "src";
const configs = [
  // content script는 ES module로 로드되지 않으므로 iife
  { ...common, entryPoints: [`${src}/content.ts`], outfile: `${out}/content.js`, format: "iife" },
  { ...common, entryPoints: [`${src}/background.ts`], outfile: `${out}/background.js`, format: "esm" },
  { ...common, entryPoints: [`${src}/popup.ts`], outfile: `${out}/popup.js`, format: "iife" },
];
if (!v1) configs.push({ ...common, entryPoints: ["src/offscreen.ts"], outfile: `${out}/offscreen.js`, format: "iife" });

if (watch) {
  for (const c of configs) await (await context(c)).watch();
} else {
  await Promise.all(configs.map((c) => build(c)));
  // 실사용 번들에 테스트 훅이 남으면 안 된다
  if (!e2e && !v1) {
    for (const f of ["background.js", "content.js", "popup.js", "offscreen.js"]) {
      const code = readFileSync(`${out}/${f}`, "utf8");
      for (const leak of ["__e2e", "e2e-token", "localhost:8790"]) {
        if (code.includes(leak)) throw new Error(`${out}/${f}에 e2e 전용 값(${leak})이 남아 있음`);
      }
    }
  }
}
