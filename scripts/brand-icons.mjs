#!/usr/bin/env node
// Rebuild committed icons from the SVG master. --preview also writes a review
// sheet and desktop/mobile screenshots to build/brand-icons (not shipped).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "snack-player/public");
const MASTER = readFileSync(path.join(PUBLIC, "icons/playsnack-icon.svg"), "utf8");
const REVIEW = path.join(ROOT, "build/brand-icons");
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const favicon = await page.evaluate((source) => {
    const svg = new DOMParser().parseFromString(source, "image/svg+xml");
    svg.documentElement.setAttribute("width", "64");
    svg.documentElement.setAttribute("height", "64");
    svg.getElementById("background").setAttribute("rx", "13");
    // Optical sizing: the tiny tab icon needs a larger mark and bite.
    svg.getElementById("mark").setAttribute("transform", "translate(-3.84 -3.84) scale(1.12)");
    svg.querySelectorAll("mask circle").forEach((circle) => {
      circle.setAttribute("r", String(Number(circle.getAttribute("r")) * 1.04));
    });
    return new XMLSerializer().serializeToString(svg);
  }, MASTER);
  writeFileSync(path.join(PUBLIC, "favicon.svg"), `${favicon}\n`);

  const targets = [
    ["icons/favicon-16.png", 16, favicon],
    ["icons/favicon-32.png", 32, favicon],
    ["icons/favicon-48.png", 48, favicon],
    ["icons/apple-touch-icon.png", 180, MASTER],
    ["icons/icon-192.png", 192, MASTER],
    ["icons/icon-512.png", 512, MASTER],
    ["icons/icon-1024.png", 1024, MASTER],
    ["icons/maskable-icon-512.png", 512, MASTER],
  ];
  const images = new Map();
  for (const [file, size, source] of targets) {
    const encoded = await page.evaluate(async ({ source, size }) => {
      const svg = new DOMParser().parseFromString(source, "image/svg+xml");
      svg.documentElement.setAttribute("width", String(size));
      svg.documentElement.setAttribute("height", String(size));
      const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" }));
      try {
        const img = new Image();
        img.src = url;
        await img.decode();
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = size;
        canvas.getContext("2d").drawImage(img, 0, 0, size, size);
        return canvas.toDataURL("image/png").split(",")[1];
      } finally {
        URL.revokeObjectURL(url);
      }
    }, { source, size });
    const png = Buffer.from(encoded, "base64");
    writeFileSync(path.join(PUBLIC, file), png);
    images.set(file, png);
    console.log(`${file}: ${size}x${size}`);
  }

  // ICO container with native 16/32/48px PNG frames; no upscaled fallback.
  const sizes = [16, 32, 48];
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  const frames = sizes.map((size, index) => {
    const png = images.get(`icons/favicon-${size}.png`);
    const entry = 6 + index * 16;
    header[entry] = header[entry + 1] = size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
    return png;
  });
  writeFileSync(path.join(PUBLIC, "favicon.ico"), Buffer.concat([header, ...frames]));

  if (process.argv.includes("--preview")) {
    mkdirSync(REVIEW, { recursive: true });
    const data = (file) => `data:image/png;base64,${images.get(file).toString("base64")}`;
    const img = (file, size, attrs = "") => `<img src="${data(file)}" width="${size}" height="${size}" alt="PlaySnack" ${attrs}>`;
    const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PlaySnack - Bite mark review</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f3f4f5;color:#17191b;font:14px -apple-system,BlinkMacSystemFont,sans-serif;letter-spacing:0}main{max-width:960px;margin:auto;padding:40px}header{display:flex;align-items:baseline;justify-content:space-between;gap:16px;border-bottom:1px solid #d3d6d9;padding-bottom:20px}h1{font-size:28px;margin:0;font-weight:750}h2{font-size:13px;font-weight:650;margin:0 0 24px}p{margin:8px 0;color:#64696e;font-size:13px}header span{font-size:12px;color:#64696e}.study{display:grid;grid-template-columns:1fr 1fr;gap:48px;padding:36px 0;border-bottom:1px solid #d3d6d9}.main-icon{border-radius:48px;display:block}.tab{display:flex;align-items:center;gap:10px;width:100%;height:44px;padding:0 14px;border:1px solid #d3d6d9;background:#fff;border-radius:8px 8px 0 0;font-size:12px}.tab.dark{background:#232629;color:#f5f6f7;border-color:#34383c;margin-top:12px}.tab span{flex:1}.tab i{font-size:16px;font-style:normal;color:#8a8e92}.sizes{display:flex;align-items:flex-end;gap:28px;margin-top:28px}.sample{display:flex;flex-direction:column;align-items:center;gap:10px}.sample small{font-size:11px;color:#64696e}.surfaces{display:flex;gap:28px;align-items:center;margin-top:28px}.surfaces img{display:block}.surfaces .round{border-radius:50%}.surfaces .squircle{border-radius:22px}.bottom{display:flex;align-items:center;justify-content:space-between;gap:20px;padding-top:24px}.signature{display:flex;align-items:center;gap:12px;font-size:24px;font-weight:750}.signature img{border-radius:10px}.spec{font:11px ui-monospace,monospace;color:#64696e;text-align:right;line-height:1.8}@media(max-width:600px){main{padding:24px}header{align-items:flex-start}header span{text-align:right;max-width:96px;line-height:1.5}.study{grid-template-columns:1fr;gap:32px;padding:28px 0}.main-icon{width:176px;height:176px;border-radius:40px}.bottom{align-items:flex-start;flex-direction:column}.spec{text-align:left}}
</style><main>
<header><h1>PlaySnack</h1><span>05 / CLEAN BITE<br>DESIGN REVIEW</span></header>
<section class="study"><div><h2>APP ICON</h2>${img("icons/icon-1024.png", 208, 'class="main-icon"')}<div class="surfaces"><div class="sample">${img("icons/icon-192.png", 64, 'class="squircle"')}<small>iOS</small></div><div class="sample">${img("icons/maskable-icon-512.png", 64, 'class="round"')}<small>Android crop</small></div></div></div>
<div><h2>BROWSER TABS / ACTUAL SIZE</h2><div class="tab">${img("icons/favicon-16.png", 16)}<span>PlaySnack</span><i>&times;</i></div><div class="tab dark">${img("icons/favicon-16.png", 16)}<span>PlaySnack</span><i>&times;</i></div><div class="sizes">${sizes.map((size) => `<div class="sample">${img(`icons/favicon-${size}.png`, size)}<small>${size} px</small></div>`).join("")}</div><p style="margin-top:24px">Native-size exports from the vector master.</p></div></section>
<footer class="bottom"><div class="signature">${img("icons/icon-192.png", 40)}PlaySnack</div><div class="spec">SVG + 1024 px master<br>16 / 32 / 48 / 180 / 192 / 512 / 1024 px</div></footer>
</main></html>`;
    writeFileSync(path.join(REVIEW, "preview.html"), html);
    await page.setViewportSize({ width: 960, height: 660 });
    await page.setContent(html);
    await page.locator("img").evaluateAll((imgs) => Promise.all(imgs.map((img) => img.decode())));
    await page.screenshot({ path: path.join(REVIEW, "preview-desktop-v5.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(REVIEW, "preview-mobile-v5.png"), fullPage: true });
    console.log(`Review: ${path.join(REVIEW, "preview.html")}`);
  }
} finally {
  await browser.close();
}
