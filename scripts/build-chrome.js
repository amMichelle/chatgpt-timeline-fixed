#!/usr/bin/env node

/**
 * Chrome Build Script
 *
 * 直接打包 Chrome 版扩展（manifest.json 已是 Chrome MV3 版本）。
 *
 * 排除：开发文件（.git / .DS_Store / .gitignore / scripts / web / *.md / *.zip / .cursor 等）
 *
 * 用法：
 *   node scripts/build-chrome.js
 */

const fs = require('fs');
const path = require('path');
const { createArchive } = require('./build-archive');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'manifest.json');

async function build() {
    const version = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8')).version;
    const zipName = `AIChatTimeline-v${version}-chrome.zip`;
    const zipPath = path.join(ROOT, zipName);


    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

    const bytes = await createArchive(ROOT, zipPath, ['manifest.firefox.json']);
    console.log(`Created ${zipName} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
}

build().catch(error => { console.error(error); process.exitCode = 1; });
