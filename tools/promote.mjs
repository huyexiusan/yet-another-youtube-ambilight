#!/usr/bin/env node
// 把「测试版」提升为「正式版」。
//
// 工作流：
//   1. 日常只改 youtube-ambilight-dev.user.js（测试版，版本号 x.y.z-dev）
//   2. 在浏览器里验证满意
//   3. node tools/promote.mjs           → 生成 youtube-ambilight-mirror.user.js
//   4. git commit && git push && 打 tag && 发 Release
//
// 测试版和正式版的差异只有这些：@name / @namespace / @version /
// BOOT_FLAG / LS_KEY / canvas 与 style 的 id 后缀。其余代码应当完全一致。
//
// 用法：
//   node tools/promote.mjs --dry-run   只看会改什么，不落盘
//   node tools/promote.mjs             真正写入正式版文件
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const ROOT = 'C:/Users/STQ43/Desktop/ambi-mirror';
const SRC = `${ROOT}/youtube-ambilight-dev.user.js`;
const DST = `${ROOT}/youtube-ambilight-mirror.user.js`;
const dryRun = process.argv.includes('--dry-run');

let src = readFileSync(SRC, 'utf8');
const before = src;

// ── 1. 版本号：1.5.1-dev → 1.5.1 ────────────────────────────────
const verMatch = src.match(/^\/\/ @version\s+([\d.]+)-dev$/m);
if (!verMatch) {
  console.error('✗ 测试版的 @version 不是 x.y.z-dev 格式，拒绝转换');
  process.exit(1);
}
const newVer = verMatch[1];
src = src.replace(/^\/\/ @version\s+[\d.]+-dev$/m, `// @version      ${newVer}`);
src = src.replace(/const SCRIPT_VERSION = '[\d.]+-dev';/, `const SCRIPT_VERSION = '${newVer}';`);

// ── 2. 标识转换 ────────────────────────────────────────────────
const reps = [
  ['// @name         视频氛围灯 · 径向反查版［测试版］', '// @name         视频氛围灯 · 径向反查版'],
  ['// @namespace    https://github.com/huyexiusan/yet-another-youtube-ambilight/dev',
   '// @namespace    https://github.com/huyexiusan/yet-another-youtube-ambilight'],
  ["const BOOT_FLAG = '__ambiMirrorBootedDev__';", "const BOOT_FLAG = '__ambiMirrorBooted__';"],
  ["const LS_KEY = 'ambi_mirror_settings_v1_dev';", "const LS_KEY = 'ambi_mirror_settings_v1';"],
  ["'ambi-mirror-bili-css-dev'", "'ambi-mirror-bili-css'"],
  ["'ambi-mirror-canvas-dev'", "'ambi-mirror-canvas'"],
  ["'ambi-mirror-edge-dev'", "'ambi-mirror-edge'"],
  ["'ambi-mirror-backdrop-dev'", "'ambi-mirror-backdrop'"],
  // 自动更新地址要指回正式版文件
  ['ambilight@latest/youtube-ambilight-dev.user.js', 'ambilight@latest/youtube-ambilight-mirror.user.js'],
];

const missed = [];
for (const [from, to] of reps) {
  if (!src.includes(from)) { missed.push(from.slice(0, 50)); continue; }
  src = src.split(from).join(to);
}
if (missed.length) {
  console.log('⚠ 这些没匹配到（可能已经改过或代码变了）：');
  missed.forEach((m) => console.log('   ' + m));
}

// ── 3. 自检：不该有 dev 残留 ────────────────────────────────────
const left = src.match(/ambi-mirror-(canvas|edge|backdrop|bili-css)-dev|__ambiMirrorBootedDev__|_settings_v1_dev|@version\s+\S*-dev/g);
if (left) {
  console.error('✗ 仍有 dev 标识残留:', [...new Set(left)].join(', '));
  process.exit(1);
}

// ── 4. 语法检查 ────────────────────────────────────────────────
try {
  execFileSync(process.execPath, ['--check', SRC], { stdio: 'pipe' });
} catch (e) {
  console.error('✗ 测试版本身就有语法错误，先修好再提升');
  process.exit(1);
}

const changed = src !== before;
console.log(`版本: ${verMatch[1]}-dev  →  ${newVer}`);
console.log(`体积: ${(src.length / 1024).toFixed(1)} KB`);
console.log(dryRun ? '\n[dry-run] 没有写入文件' : `\n已写入 ${DST}`);
if (dryRun) {
  console.log('预览前 12 行：');
  console.log(src.split('\n').slice(0, 12).join('\n'));
}

if (!dryRun) writeFileSync(DST, src, 'utf8');
