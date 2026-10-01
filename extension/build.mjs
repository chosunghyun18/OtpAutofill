// 확장 프로그램 빌드 — esbuild로 번들 후 dist/에 manifest·html 복사.
// chrome://extensions → "압축해제된 확장 프로그램을 로드" → extension/dist 선택
import { build, context } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const watch = process.argv.includes("--watch");
rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
cpSync("public", "dist", { recursive: true });

const common = { bundle: true, target: "chrome120", sourcemap: true, logLevel: "info" };
const configs = [
  // content script는 ES module로 로드되지 않으므로 iife
  { ...common, entryPoints: ["src/content.ts"], outfile: "dist/content.js", format: "iife" },
  { ...common, entryPoints: ["src/background.ts"], outfile: "dist/background.js", format: "esm" },
  { ...common, entryPoints: ["src/popup.ts"], outfile: "dist/popup.js", format: "iife" },
];

if (watch) {
  for (const c of configs) await (await context(c)).watch();
} else {
  await Promise.all(configs.map((c) => build(c)));
}
