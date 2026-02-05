#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "fs-extra";
import mustache from "mustache";
import archiver from "archiver";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEMPLATE_ROOT = path.join(__dirname, "..", "templates", "standard");

// -------------------- utils --------------------

function getArgValue(flag) {
  const args = process.argv.slice(2);
  const i = args.indexOf(flag);
  if (i === -1) return null;
  return args[i + 1] ?? null;
}

function hasFlag(flag) {
  return process.argv.slice(2).includes(flag);
}

function parseKb(sizeStr) {
  if (!sizeStr) return null;
  const m = String(sizeStr).trim().match(/^(\d+(?:\.\d+)?)\s*kb$/i);
  return m ? Math.round(Number(m[1]) * 1024) : null;
}

// Resolve formats.json even if user runs the command from /source or anywhere else.
// Priority:
// 1) --formats / --config value (relative to cwd)
// 2) <projectRoot>/formats.json (projectRoot = ../ from this CLI file)
// 3) <cwd>/formats.json
async function resolveFormatsPath() {
  const cliValue = getArgValue("--formats") ?? getArgValue("--config");
  if (cliValue) return path.resolve(process.cwd(), cliValue);

  const projectRootCandidate = path.join(path.resolve(__dirname, ".."), "formats.json");
  if (await fs.pathExists(projectRootCandidate)) return projectRootCandidate;

  const cwdCandidate = path.resolve(process.cwd(), "formats.json");
  if (await fs.pathExists(cwdCandidate)) return cwdCandidate;

  return null;
}

function makeZipName({ campaign, langCode, motiveName, width, height }) {
  return [campaign, langCode, motiveName, `${width}x${height}`]
    .filter(Boolean)
    .join("_")
    .replace(/\s+/g, "_")
    .replace(/[^\w.-]+/g, "_") + ".zip";
}

// -------------------- preview (GLOBAL GRID) --------------------

async function collectBannerIndexFiles(rootDir) {
  const found = [];

  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    const hasIndex = entries.some((e) => !e.isDirectory() && e.name === "index.html");
    if (hasIndex) {
      found.push(path.join(dir, "index.html"));
      return;
    }

    for (const e of entries) {
      if (e.isDirectory()) await walk(path.join(dir, e.name));
    }
  }

  if (await fs.pathExists(rootDir)) await walk(rootDir);
  return found;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function buildGlobalPreviewHtml({ items }) {
  const cards = items
    .map(({ label, href, h }) => {
      const iframeHeight = Number.isFinite(h) ? Math.min(h + 20, 740) : 320;
      return `
        <div class="card" data-label="${escapeHtml(label)}">
          <div class="meta">
            <div class="label" title="${escapeHtml(label)}">${escapeHtml(label)}</div>
            <a class="open" href="${href}" target="_blank" rel="noopener">open</a>
          </div>
          <iframe src="${href}" height="${iframeHeight}" loading="lazy"></iframe>
        </div>
      `;
    })
    .join("");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Banner Preview</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:16px;background:#fafafa}
    h1{margin:0 0 6px 0;font-size:20px}
    .sub{color:#555;margin:0 0 14px 0;font-size:13px}
    .bar{display:flex;gap:10px;align-items:center;margin:0 0 14px 0}
    input{flex:1;max-width:520px;padding:10px 12px;border:1px solid #ddd;border-radius:10px;font-size:14px}
    .count{font-size:13px;color:#666}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:14px}
    .card{background:#fff;border:1px solid #e6e6e6;border-radius:10px;padding:10px;box-shadow:0 1px 4px rgba(0,0,0,.04)}
    .meta{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:8px}
    .label{font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .open{font-size:13px;text-decoration:none}
    iframe{width:100%;border:1px solid #eee;border-radius:8px;background:#f6f6f6}
    .hidden{display:none}
  </style>
</head>
<body>
  <h1>Banner Preview</h1>
  <p class="sub">Auto-generated grid. Re-run with <code>--preview</code> after adding banners/assets.</p>

  <div class="bar">
    <input id="q" placeholder="Filter (campaign / language / motive / size)…" />
    <div class="count"><span id="shown"></span>/<span id="total"></span></div>
  </div>

  <div class="grid" id="grid">${cards}</div>

  <script>
    const q = document.getElementById('q');
    const cards = Array.from(document.querySelectorAll('.card'));
    const shown = document.getElementById('shown');
    const total = document.getElementById('total');
    total.textContent = cards.length;

    function update(){
      const v = (q.value || '').trim().toLowerCase();
      let visible = 0;
      for(const c of cards){
        const label = (c.getAttribute('data-label') || '').toLowerCase();
        const ok = !v || label.includes(v);
        c.classList.toggle('hidden', !ok);
        if(ok) visible++;
      }
      shown.textContent = visible;
    }
    q.addEventListener('input', update);
    update();
  </script>
</body>
</html>`;
}

async function generateGlobalPreviewPage({ sourceRoot }) {
  const indexFiles = await collectBannerIndexFiles(sourceRoot);

  const items = indexFiles.map((absIndex) => {
    const href = path.relative(sourceRoot, absIndex).split(path.sep).join("/");
    const relFolder = href.replace(/\/index\.html$/i, "");
    const parts = relFolder.split("/");
    const size = parts[parts.length - 1] ?? "";
    const m = size.match(/^(\d+)x(\d+)$/i);
    const h = m ? Number(m[2]) : NaN;

    return { href, label: relFolder, h };
  });

  items.sort((a, b) => a.label.localeCompare(b.label));

  const html = buildGlobalPreviewHtml({ items });
  const outPath = path.join(sourceRoot, "index.html");
  await fs.ensureDir(sourceRoot);
  await fs.writeFile(outPath, html, "utf8");

  console.log(`🖼️ Preview page created: ${outPath}`);
}

// -------------------- assets + rendering --------------------

async function readAssets(bannerFolder) {
  const assetsDir = path.join(bannerFolder, "assets");
  if (!(await fs.pathExists(assetsDir))) return [];

  const files = (await fs.readdir(assetsDir))
    .filter((f) => /\.(png|jpe?g|gif|webp|svg)$/i.test(f))
    .filter((f) => !/@2x\./i.test(f))
    .sort();

  return files.map((file) => ({
    id: path.parse(file).name,
    file
  }));
}

async function renderTextFiles(dir, data) {
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      await renderTextFiles(full, data);
      continue;
    }

    const isTemplate = entry.name.endsWith(".mustache");
    const isRenderable = isTemplate || /\.(html|css|js|json|txt|md)$/i.test(entry.name);
    if (!isRenderable) continue;

    const raw = await fs.readFile(full, "utf8");
    const out = mustache.render(raw, data);

    if (isTemplate) {
      const outPath = full.replace(/\.mustache$/i, "");
      await fs.writeFile(outPath, out, "utf8");
      await fs.remove(full);
    } else {
      await fs.writeFile(full, out, "utf8");
    }
  }
}

// -------------------- zip --------------------

async function zipFolder(srcDir, zipPath) {
  await fs.ensureDir(path.dirname(zipPath));

  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", resolve);
    archive.on("error", reject);

    archive.pipe(output);
    archive.directory(srcDir, false);
    archive.finalize();
  });
}

// -------------------- zip-only mode --------------------

async function collectBannerFolders(rootDir) {
  const found = [];

  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const names = entries.map((e) => e.name);

    if (names.includes("index.html")) {
      found.push(dir);
      return;
    }

    for (const e of entries) {
      if (e.isDirectory()) await walk(path.join(dir, e.name));
    }
  }

  if (await fs.pathExists(rootDir)) await walk(rootDir);
  return found;
}

// -------------------- generation --------------------

async function generateFromFormatsJson({
  formatsAbsPath,
  outDirOverride,
  campaignOverride,
  clicktagOverride,
  shouldZip
}) {
  const cfg = await fs.readJson(formatsAbsPath);

  const formats = Array.isArray(cfg) ? cfg : (Array.isArray(cfg.formats) ? cfg.formats : []);
  if (!formats.length) {
    throw new Error(
      `No formats found in ${formatsAbsPath}. Expected { "formats": [ ... ] } or a JSON array.`
    );
  }

  const campaign = campaignOverride ?? cfg.campaign ?? "my-campaign";
  const outDir = outDirOverride ?? "./source";
  const outRoot = path.resolve(process.cwd(), outDir, campaign);
  const zipRoot = path.resolve(process.cwd(), "output", "zip");

  let count = 0;

  for (const fmt of formats) {
    const width = Number(fmt.width);
    const height = Number(fmt.height);

    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      throw new Error(`Invalid width/height in formats.json entry: ${JSON.stringify(fmt)}`);
    }

    const langCode = fmt.language ?? fmt.lang ?? null;
    const motiveName = fmt.motive ?? fmt.motiveName ?? null;

    const bannerFolder = path.join(
      outRoot,
      ...(langCode ? [String(langCode)] : []),
      ...(motiveName ? [String(motiveName)] : []),
      `${width}x${height}`
    );

    await fs.ensureDir(bannerFolder);

    // Overwrite template files but NEVER clobber existing assets
    await fs.copy(TEMPLATE_ROOT, bannerFolder, {
      overwrite: true,
      filter: (src) => !src.includes(`${path.sep}assets${path.sep}`)
    });
    await fs.ensureDir(path.join(bannerFolder, "assets"));

    const assets = await readAssets(bannerFolder);

    const maxBytes = parseKb(fmt.size);
    const adserverType = fmt?.adserver?.type ?? "standard";
    const clicktag = clicktagOverride ?? cfg.clicktag ?? fmt.clicktag ?? "https://example.com";

    await renderTextFiles(bannerFolder, {
      CAMPAIGN: campaign,
      LANGUAGE: langCode ?? "",
      MOTIVE: motiveName ?? "",
      WIDTH: width,
      HEIGHT: height,
      SIZE_KB: fmt.size ?? "",
      MAX_BYTES: maxBytes ?? "",
      ADSERVER_TYPE: adserverType,
      CLICKTAG: clicktag,
      ASSETS: assets,
      FORMAT_JSON: JSON.stringify(fmt)
    });

    if (shouldZip) {
      const zipName = makeZipName({ campaign, langCode, motiveName, width, height });
      await zipFolder(bannerFolder, path.join(zipRoot, zipName));
    }

    count += 1;
  }

  console.log(`✅ Generated ${count} banner(s) in: ${outRoot}`);
  if (shouldZip) console.log(`📦 Zipped to: ${zipRoot}`);
}

// -------------------- main --------------------

async function main() {
  const formatsAbsPath = await resolveFormatsPath();

  if (!formatsAbsPath) {
    console.error("❌ Could not find formats.json.");
    console.error("   Put formats.json in the project root, or run: banner-generator --formats path/to/formats.json");
    process.exit(1);
  }

  const outDirOverride = getArgValue("--outDir");
  const campaignOverride = getArgValue("--campaign");
  const clicktagOverride = getArgValue("--clicktag");

  const shouldZip = hasFlag("--zip");
  const zipOnly = hasFlag("--zip-only");
  const makePreview = hasFlag("--preview");

  const cfg = await fs.readJson(formatsAbsPath);

  const campaign = campaignOverride ?? cfg.campaign ?? "my-campaign";
  const outDir = outDirOverride ?? "./source";
  const outRoot = path.resolve(process.cwd(), outDir, campaign);
  const zipRoot = path.resolve(process.cwd(), "output", "zip");
  const sourceRoot = path.resolve(process.cwd(), outDir);

  if (zipOnly) {
    const folders = await collectBannerFolders(outRoot);
    if (!folders.length) {
      console.error(`❌ No banner folders found under: ${outRoot}`);
      process.exit(1);
    }

    let zipped = 0;
    for (const bannerFolder of folders) {
      const rel = path.relative(outRoot, bannerFolder).split(path.sep).join("_");
      const zipName = `${campaign}_${rel}`
        .replace(/\s+/g, "_")
        .replace(/[^\w.-]+/g, "_") + ".zip";

      await zipFolder(bannerFolder, path.join(zipRoot, zipName));
      zipped += 1;
    }

    console.log(`📦 Zipped ${zipped} banner(s) to: ${zipRoot}`);

    if (makePreview) {
      await generateGlobalPreviewPage({ sourceRoot });
    }

    return;
  }

  await generateFromFormatsJson({
    formatsAbsPath,
    outDirOverride,
    campaignOverride,
    clicktagOverride,
    shouldZip
  });

  if (makePreview) {
    await generateGlobalPreviewPage({ sourceRoot });
  }
}

main().catch((err) => {
  console.error("❌", err?.stack || err?.message || String(err));
  process.exit(1);
});
