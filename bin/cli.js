#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "fs-extra";
import mustache from "mustache";
import archiver from "archiver";
import readline from "node:readline";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// -------------------- constants --------------------

const TEMPLATES_DIR = path.join(__dirname, "..", "templates");
const DEFAULT_OUT_DIR = "./src";
const DEFAULT_CAMPAIGN = "my-campaign";
const DEFAULT_CLICKTAG = "https://example.com";
const DEFAULT_ADSERVER_TYPE = "standard";
const DEFAULT_PORT = 8080;

// -------------------- templates --------------------

function getTemplateRoot(fmt, cfg, templateOverride) {
  const type = templateOverride ?? fmt?.brand?.type ?? cfg?.brand?.type ?? "standard";
  return { type: String(type), root: path.join(TEMPLATES_DIR, String(type)) };
}

// -------------------- prompt utils --------------------

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(String(answer || "").trim());
    });
  });
}

// -------------------- cli utils --------------------

function argv() {
  return process.argv.slice(2);
}

function getArgValue(flag) {
  const args = argv();
  const i = args.indexOf(flag);
  if (i === -1) return null;
  return args[i + 1] ?? null;
}

function hasFlag(flag) {
  return argv().includes(flag);
}

function stripKnownFlags(args) {
  // Remove known flags + their values so leftover args can be treated as sizes.
  const flagsWithValue = new Set([
    "--formats",
    "--config",
    "--outDir",
    "--campaign",
    "--clicktag",
    "--template",
    "--port",
    "--only-size",
    "--only-lang",
    "--only-motive",
    "--only-template",
    "--only-index",
  ]);
  const flagsNoValue = new Set(["--zip", "--zip-only", "--preview", "--open", "--create-only", "--update"]);

  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (flagsNoValue.has(a)) continue;
    if (flagsWithValue.has(a)) {
      i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

function parseKb(sizeStr) {
  if (!sizeStr) return null;
  const m = String(sizeStr).trim().match(/^(\d+(?:\.\d+)?)\s*kb$/i);
  return m ? Math.round(Number(m[1]) * 1024) : null;
}

function normalizeSize(width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return "";
  return `${w}x${h}`;
}

function parseSizeList(input) {
  // accepts: "300x600", "300x600, 728x90", ["300x600","728x90"]
  const raw = Array.isArray(input) ? input.join(",") : String(input || "");
  const parts = raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const sizes = [];
  for (const p of parts) {
    const m = p.match(/^(\d+)\s*x\s*(\d+)$/i);
    if (!m) continue;
    sizes.push(`${Number(m[1])}x${Number(m[2])}`);
  }
  return sizes.length ? new Set(sizes) : null;
}

function parseCsvSet(v) {
  if (!v) return null;
  const parts = String(v)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? new Set(parts) : null;
}

function parseIndexSet(v) {
  if (!v) return null;
  const parts = String(v)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n >= 0);
  return parts.length ? new Set(parts) : null;
}

function makeZipName({ campaign, langCode, motiveName, width, height }) {
  return (
    [campaign, langCode, motiveName, `${width}x${height}`]
      .filter(Boolean)
      .join("_")
      .replace(/\s+/g, "_")
      .replace(/[^\w.-]+/g, "_") + ".zip"
  );
}

function ensureValidMode({ createOnly, updateOnly }) {
  if (createOnly && updateOnly) {
    console.error("❌ Use only one of --create-only or --update (not both).");
    process.exit(1);
  }
  return createOnly ? "create-only" : updateOnly ? "update" : "incremental";
}

// -------------------- config + paths --------------------

// Resolve formats.json even if user runs from /src or anywhere else.
async function resolveFormatsPath() {
  const cliValue = getArgValue("--formats") ?? getArgValue("--config");
  if (cliValue) return path.resolve(process.cwd(), cliValue);

  const projectRootCandidate = path.join(path.resolve(__dirname, ".."), "formats.json");
  if (await fs.pathExists(projectRootCandidate)) return projectRootCandidate;

  const cwdCandidate = path.resolve(process.cwd(), "formats.json");
  if (await fs.pathExists(cwdCandidate)) return cwdCandidate;

  return null;
}

function readFormatsFromCfg(cfg) {
  return Array.isArray(cfg) ? cfg : Array.isArray(cfg.formats) ? cfg.formats : [];
}

function buildRoots({ outDir, campaign }) {
  const outRoot = path.resolve(process.cwd(), outDir, campaign);
  const zipRoot = path.resolve(process.cwd(), "output", "zip");
  const sourceRoot = path.resolve(process.cwd(), outDir);
  return { outRoot, zipRoot, sourceRoot };
}

// -------------------- preview (GLOBAL GRID) --------------------

async function collectBannerIndexFiles(rootDir) {
  const found = [];
  const rootIndex = path.join(rootDir, "index.html");

  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const hasIndex = entries.some((e) => e.isFile() && e.name === "index.html");

    if (hasIndex) {
      const indexPath = path.join(dir, "index.html");
      if (path.resolve(indexPath) !== path.resolve(rootIndex)) {
        found.push(indexPath);
        return;
      }
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
    .map(({ label, href, w, h }) => {
      const safeW = Number.isFinite(w) ? w : 300;
      const safeH = Number.isFinite(h) ? h : 250;

      return `
        <div class="card" data-label="${escapeHtml(label)}" style="--w:${safeW}; --h:${safeH}">
          <div class="meta">
            <div class="label" title="${escapeHtml(label)}">${escapeHtml(label)}</div>
            <a class="open" href="${href}" target="_blank" rel="noopener">open</a>
          </div>
          <div class="stage">
            <iframe src="${href}" width="${safeW}" height="${safeH}" loading="lazy"></iframe>
          </div>
        </div>
      `;
    })
    .join("");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>HTML5 Banner Previews</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:16px;overflow-x:auto}
    body::before { content: "";position: fixed;inset: 0;background-image: url("./assets/L-ESPAI_BG.png");background-size: cover;background-position: center;background-repeat: no-repeat;opacity: 0.4;z-index: -1;pointer-events: none;}
    .bar{display:flex;gap:10px;align-items:center;margin:0 0 14px 0}
    input{flex:1;max-width:520px;padding:10px 12px;border:1px solid #ddd;border-radius:10px;font-size:14px}
    .count{font-size:13px;color:#666;white-space:nowrap}
    .grid{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-start}
    .card{background:#ffffff;border:1px solid #000000;border-radius:10px;padding:10px;box-shadow:0 1px 4px rgba(0,0,0,.04);width:calc(var(--w) * 1px + 16px);max-width:100%}
    .stage{width:calc(var(--w) * 1px);padding:8px;border:1px solid #ffffff;border-radius:8px;background:#ffffff;max-width:100%;overflow:auto}
    .meta{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:8px}
    .label{font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .open{font-size:13px;text-decoration:none}
    .bottom-logo{ position: fixed;bottom: 56px;right: 56px;height: 28px;width: auto;z-index: -1;pointer-events: none;}
    iframe{display:block;width:calc(var(--w) * 1px);height:calc(var(--h) * 1px);border:0;background:#fff}
    .hidden{display:none}
  </style>
</head>
<body>
  <img src="./assets/l-espai-logo.png" alt="L’Espai" class="bottom-logo">
  <div class="bar">
    <input id="q" placeholder="Filter..." />
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

function indexFileToPreviewItem({ sourceRoot, absIndex }) {
  const href = path.relative(sourceRoot, absIndex).split(path.sep).join("/");
  const relFolder = href.replace(/\/index\.html$/i, "");
  const parts = relFolder.split("/");
  const size = parts[parts.length - 1] ?? "";
  const m = size.match(/^(\d+)x(\d+)$/i);
  const w = m ? Number(m[1]) : NaN;
  const h = m ? Number(m[2]) : NaN;
  const label = Number.isFinite(w) && Number.isFinite(h) ? `${w}x${h}` : size;
  return { href, label, w, h };
}

async function generateGlobalPreviewPage({ sourceRoot, openAfter = false, port = DEFAULT_PORT }) {
  const indexFiles = await collectBannerIndexFiles(sourceRoot);

  const items = indexFiles.map((absIndex) => indexFileToPreviewItem({ sourceRoot, absIndex }));
  items.sort((a, b) => (a.w - b.w) || (a.h - b.h) || a.label.localeCompare(b.label));

  const html = buildGlobalPreviewHtml({ items });

  const outPath = path.join(sourceRoot, "_preview.html");
  await fs.writeFile(outPath, html, "utf8");
  console.log(`🖼️ Preview page updated: ${outPath}`);

  const url = `http://127.0.0.1:${port}/_preview.html`;
  console.log(`🔗 Open: ${url}`);

  if (openAfter) {
    const open = (await import("open")).default;
    await open(url);
  }
}

// -------------------- assets --------------------

async function readAssets(bannerFolder) {
  const assetsDir = path.join(bannerFolder, "assets");
  if (!(await fs.pathExists(assetsDir))) return [];

  const files = (await fs.readdir(assetsDir))
    .filter((f) => /\.(png|jpe?g|gif|webp|svg)$/i.test(f))
    .filter((f) => !/@2x\./i.test(f))
    .sort();

  return files.map((file) => ({ id: path.parse(file).name, file }));
}

// -------------------- incremental state --------------------

async function readGenState(bannerFolder) {
  const p = path.join(bannerFolder, ".gen-state.json");
  if (!(await fs.pathExists(p))) return null;
  try {
    return await fs.readJson(p);
  } catch {
    return null;
  }
}

async function writeGenState(bannerFolder, state) {
  const p = path.join(bannerFolder, ".gen-state.json");
  await fs.writeJson(p, state, { spaces: 2 });
}

function sameStringArray(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function stableStringify(obj) {
  const seen = new WeakSet();
  const sorter = (x) => {
    if (x && typeof x === "object") {
      if (seen.has(x)) return x;
      seen.add(x);
      if (Array.isArray(x)) return x.map(sorter);
      const out = {};
      for (const k of Object.keys(x).sort()) out[k] = sorter(x[k]);
      return out;
    }
    return x;
  };
  return JSON.stringify(sorter(obj));
}

// -------------------- rendering (ONLY from *.mustache) --------------------

async function renderFromMustacheFiles(dir, data, { overwrite }) {
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      await renderFromMustacheFiles(full, data, { overwrite });
      continue;
    }

    if (!entry.name.endsWith(".mustache")) continue;

    const outPath = full.replace(/\.mustache$/i, "");
    if (!overwrite && (await fs.pathExists(outPath))) continue;

    const raw = await fs.readFile(full, "utf8");
    const out = mustache.render(raw, data);
    await fs.writeFile(outPath, out, "utf8");
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

    archive.glob("**/*", {
      cwd: srcDir,
      dot: true,
      ignore: ["**/*.mustache", "**/.DS_Store", "**/Thumbs.db", "**/.gen-state.json"],
    });

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

// -------------------- generation helpers --------------------

function buildFilters({ onlySizesFromPromptOrArgs }) {
  return {
    onlySize: onlySizesFromPromptOrArgs ?? parseCsvSet(getArgValue("--only-size")),
    onlyLang: parseCsvSet(getArgValue("--only-lang")),
    onlyMotive: parseCsvSet(getArgValue("--only-motive")),
    onlyTemplate: parseCsvSet(getArgValue("--only-template")),
    onlyIndex: parseIndexSet(getArgValue("--only-index")),
  };
}

function matchesFilters({ fmt, idx, cfg, templateOverride, filters }) {
  const size = normalizeSize(fmt.width, fmt.height);
  const lang = String(fmt.language ?? fmt.lang ?? "");
  const motive = String(fmt.motive ?? fmt.motiveName ?? "");
  const { type: templateType } = getTemplateRoot(fmt, cfg, templateOverride);

  if (filters.onlyIndex && !filters.onlyIndex.has(idx)) return false;
  if (filters.onlySize && !filters.onlySize.has(size)) return false;
  if (filters.onlyLang && !filters.onlyLang.has(lang)) return false;
  if (filters.onlyMotive && !filters.onlyMotive.has(motive)) return false;
  if (filters.onlyTemplate && !filters.onlyTemplate.has(templateType)) return false;

  return true;
}

function resolveLangAndMotive(fmt) {
  const langCode = fmt.language ?? fmt.lang ?? null;
  const motiveName = fmt.motive ?? fmt.motiveName ?? null;
  return { langCode, motiveName };
}

function bannerFolderFor({ outRoot, langCode, motiveName, width, height }) {
  return path.join(
    outRoot,
    ...(langCode ? [String(langCode)] : []),
    ...(motiveName ? [String(motiveName)] : []),
    `${width}x${height}`
  );
}

async function ensureTemplateOnCreate({ templateRoot, bannerFolder, exists }) {
  if (exists) return;

  await fs.copy(templateRoot, bannerFolder, {
    overwrite: false,
    errorOnExist: false,
    filter: (src) => !src.includes(`${path.sep}assets${path.sep}`),
  });
}

function shouldProcessBanner({ mode, exists }) {
  // Mode rules
  if (mode === "create-only" && exists) return false;
  if (mode === "update" && !exists) return false;
  return true;
}

function shouldRenderBanner({ mode, exists, prevState, assetsFiles, fmtSig }) {
  const assetsChanged = !prevState || !sameStringArray(prevState.assetsFiles, assetsFiles);
  const fmtChanged = !prevState || prevState.fmtSig !== fmtSig;

  return mode === "update"
    ? true
    : mode === "create-only"
      ? !exists
      : !exists || assetsChanged || fmtChanged;
}

function logSummary({ processed, created, updated, skipped, filteredOut, mode, outRoot, shouldZip, zipRoot }) {
  console.log(`✅ Processed: ${processed} format(s)`);
  if (filteredOut) console.log(`🔎 Filtered out: ${filteredOut}`);
  if (mode === "create-only") console.log(`➕ Created: ${created} | ⏭️ Skipped existing: ${skipped}`);
  else if (mode === "update") console.log(`♻️ Updated: ${updated} | ⏭️ Skipped missing: ${skipped}`);
  else console.log(`⚡ Incremental: created ${created}, updated ${updated}, skipped ${skipped}`);
  console.log(`📁 Output: ${outRoot}`);
  if (shouldZip) console.log(`📦 Zipped to: ${zipRoot}`);
}

function bytesToKb(bytes) {
  return bytes / 1024;
}

function fmtKb(bytes) {
  return `${bytesToKb(bytes).toFixed(1)} kb`;
}

async function checkZipSize({ zipPath, fmt, maxBytes }) {
  if (!maxBytes) return { ok: true, skipped: true };

  const stat = await fs.stat(zipPath);
  const actual = stat.size;

  const ok = actual <= maxBytes;
  const label = `${fmt?.language ?? fmt?.lang ?? ""}_${fmt?.motive ?? fmt?.motiveName ?? ""}_${fmt?.width}x${fmt?.height}`
    .replace(/^_+|_+$/g, "")
    .replace(/__+/g, "_");

  if (ok) {
    console.log(`✅ ZIP size ok: ${path.basename(zipPath)} — ${fmtKb(actual)} / limit ${fmtKb(maxBytes)} (${label})`);
  } else {
    console.warn(`⚠️ ZIP OVERSIZE: ${path.basename(zipPath)} — ${fmtKb(actual)} / limit ${fmtKb(maxBytes)} (${label})`);
  }

  return { ok, actualBytes: actual, maxBytes };
}

// Try to match a banner folder to a format entry (used in --zip-only)
function parseMetaFromBannerFolder({ outRoot, bannerFolder }) {
  // bannerFolder = .../<campaign>/<lang?>/<motive?>/<WxH>
  const rel = path.relative(outRoot, bannerFolder).split(path.sep);
  const sizePart = rel[rel.length - 1] ?? "";
  const m = sizePart.match(/^(\d+)x(\d+)$/i);
  if (!m) return null;

  const width = Number(m[1]);
  const height = Number(m[2]);

  // if folder depth is 1: [ "300x250" ]
  // if depth is 2: [ "PHEV", "300x250" ]
  // if depth is 3+: [ "PHEV", "s700_v2", "300x250" ] (your structure)
  const langCode = rel.length >= 2 ? rel[0] : null;
  const motiveName = rel.length >= 3 ? rel[1] : null;

  return { width, height, langCode, motiveName };
}

function findFormatForFolder({ formats, meta }) {
  if (!meta) return null;

  // Prefer exact match on width/height + language + motive if available
  const exact = formats.find((f) => {
    const w = Number(f.width), h = Number(f.height);
    if (w !== meta.width || h !== meta.height) return false;

    const lang = String(f.language ?? f.lang ?? "");
    const motive = String(f.motive ?? f.motiveName ?? "");

    if (meta.langCode && lang && lang !== meta.langCode) return false;
    if (meta.motiveName && motive && motive !== meta.motiveName) return false;

    return true;
  });
  if (exact) return exact;

  // Fallback: match only by size
  return formats.find((f) => Number(f.width) === meta.width && Number(f.height) === meta.height) ?? null;
}


// -------------------- generation --------------------

async function generateFromFormatsJson({
  formatsAbsPath,
  outDirOverride,
  campaignOverride,
  clicktagOverride,
  shouldZip,
  templateOverride,
  mode, // "incremental" | "create-only" | "update"
  onlySizesFromPromptOrArgs, // Set<string> | null
}) {
  const cfg = await fs.readJson(formatsAbsPath);
  const formats = readFormatsFromCfg(cfg);

  if (!formats.length) {
    throw new Error(`No formats found in ${formatsAbsPath}. Expected { "formats": [ ... ] } or a JSON array.`);
  }

  const filters = buildFilters({ onlySizesFromPromptOrArgs });

  const campaign = campaignOverride ?? cfg.campaign ?? DEFAULT_CAMPAIGN;
  const outDir = outDirOverride ?? DEFAULT_OUT_DIR;

  const { outRoot, zipRoot } = buildRoots({ outDir, campaign });

  let processed = 0;
  let created = 0;
  let updated = 0;
  let skipped = 0;
  let filteredOut = 0;

  for (let idx = 0; idx < formats.length; idx++) {
    const fmt = formats[idx];

    if (!matchesFilters({ fmt, idx, cfg, templateOverride, filters })) {
      filteredOut += 1;
      continue;
    }

    const width = Number(fmt.width);
    const height = Number(fmt.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      throw new Error(`Invalid width/height in formats.json entry: ${JSON.stringify(fmt)}`);
    }

    const { langCode, motiveName } = resolveLangAndMotive(fmt);

    const bannerFolder = bannerFolderFor({ outRoot, langCode, motiveName, width, height });
    const bannerIndex = path.join(bannerFolder, "index.html");
    const exists = await fs.pathExists(bannerIndex);

    if (!shouldProcessBanner({ mode, exists })) {
      skipped += 1;
      continue;
    }

    const { type: templateType, root: templateRoot } = getTemplateRoot(fmt, cfg, templateOverride);
    if (!(await fs.pathExists(templateRoot))) {
      throw new Error(`Template "${templateType}" not found. Expected folder: ${templateRoot}`);
    }

    // Ensure folder exists
    await fs.ensureDir(bannerFolder);

    // Copy template ONLY when creating a new banner (prevents overwriting other formats)
    await ensureTemplateOnCreate({ templateRoot, bannerFolder, exists });

    // assets folder always exists
    await fs.ensureDir(path.join(bannerFolder, "assets"));
    const assets = await readAssets(bannerFolder);
    const assetsFiles = assets.map((a) => a.file);

    // Decide if we should render in incremental mode
    const prevState = await readGenState(bannerFolder);
    const fmtSig = stableStringify(fmt);
    const shouldRender = shouldRenderBanner({ mode, exists, prevState, assetsFiles, fmtSig });

    if (!shouldRender) {
      skipped += 1;
      continue;
    }

    const maxBytes = parseKb(fmt.size);
    const adserverType = fmt?.adserver?.type ?? DEFAULT_ADSERVER_TYPE;
    const clicktag = clicktagOverride ?? cfg.clicktag ?? fmt.clicktag ?? DEFAULT_CLICKTAG;

    // Rendering:
    // - We ONLY render from *.mustache sources
    // - overwrite is true because outputs are derived artifacts
    // - mustache sources remain untouched
    await renderFromMustacheFiles(
      bannerFolder,
      {
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
        FORMAT_JSON: JSON.stringify(fmt),
        TEMPLATE_TYPE: templateType,
      },
      { overwrite: true }
    );

    await writeGenState(bannerFolder, {
      assetsFiles,
      fmtSig,
      templateType,
      updatedAt: new Date().toISOString(),
    });

    if (shouldZip) {
      const zipName = makeZipName({ campaign, langCode, motiveName, width, height });
      const zipPath = path.join(zipRoot, zipName);

      await zipFolder(bannerFolder, zipPath);

      // Compare ZIP size to formats.json "size"
      await checkZipSize({ zipPath, fmt, maxBytes });
    }


    processed += 1;
    if (!exists) created += 1;
    if (exists) updated += 1;
  }

  logSummary({ processed, created, updated, skipped, filteredOut, mode, outRoot, shouldZip, zipRoot });
}

// -------------------- size selection --------------------

async function resolveOnlySizes({ zipOnly, makePreview }) {
  // Allow: `npm run gen 300x600 728x90` (args after flags)
  // Or prompt if none are provided (only when not zip-only/preview-only)
  const rawArgs = argv();
  const freeArgs = stripKnownFlags(rawArgs);
  let onlySizes = parseSizeList(freeArgs);

  if (!zipOnly && !makePreview && !onlySizes) {
    const ans = await ask(
      `Generate which formats?\n` + `  1) all\n` + `  2) specific sizes\n` + `Choose 1 or 2: `
    );

    if (ans === "2") {
      const sizesStr = await ask(`Enter sizes (comma separated), e.g. 300x600, 728x90: `);
      onlySizes = parseSizeList(sizesStr);
      if (!onlySizes) console.log("⚠️ No valid sizes entered. Generating ALL.");
    }
  }

  return onlySizes;
}

// -------------------- zip-only workflow --------------------

async function zipOnlyWorkflow({ outRoot, zipRoot, campaign, makePreview, sourceRoot, formats }) {
  const folders = await collectBannerFolders(outRoot);
  if (!folders.length) {
    console.error(`❌ No banner folders found under: ${outRoot}`);
    process.exit(1);
  }

  let zipped = 0;
  for (const bannerFolder of folders) {
    const rel = path.relative(outRoot, bannerFolder).split(path.sep).join("_");
    const zipName = `${campaign}_${rel}`.replace(/\s+/g, "_").replace(/[^\w.-]+/g, "_") + ".zip";
    const zipPath = path.join(zipRoot, zipName);
    await zipFolder(bannerFolder, zipPath);

    // Compare ZIP size if we can find a matching format
    const meta = parseMetaFromBannerFolder({ outRoot, bannerFolder });
    const fmt = findFormatForFolder({ formats: formats ?? [], meta });
    const maxBytes = parseKb(fmt?.size);
    if (fmt && maxBytes) {
      await checkZipSize({ zipPath, fmt, maxBytes });
    } else if (formats?.length) {
      console.log(`ℹ️ ZIP created (no matching format to validate size): ${path.basename(zipPath)}`);
    }

    zipped += 1;
  }

  console.log(`📦 Zipped ${zipped} banner(s) to: ${zipRoot}`);

  if (makePreview) {
    const openAfter = hasFlag("--open");
    const port = Number(getArgValue("--port") ?? DEFAULT_PORT);
    await generateGlobalPreviewPage({ sourceRoot, openAfter, port });
  }
}

// -------------------- main --------------------

async function main() {
  const formatsAbsPath = await resolveFormatsPath();
  if (!formatsAbsPath) {
    console.error("❌ Could not find formats.json.");
    console.error("   Put formats.json in the project root, or run: node ./bin/cli.js --formats path/to/formats.json");
    process.exit(1);
  }

  const outDirOverride = getArgValue("--outDir");
  const campaignOverride = getArgValue("--campaign");
  const clicktagOverride = getArgValue("--clicktag");
  const templateOverride = getArgValue("--template");

  const shouldZip = hasFlag("--zip");
  const zipOnly = hasFlag("--zip-only");
  const makePreview = hasFlag("--preview");

  // Modes:
  // - default: incremental (create missing, update only when assets/format changed)
  // - --create-only: only create missing (never update)
  // - --update: force update existing (never create new)
  const mode = ensureValidMode({ createOnly: hasFlag("--create-only"), updateOnly: hasFlag("--update") });

  const cfg = await fs.readJson(formatsAbsPath);
  const campaign = campaignOverride ?? cfg.campaign ?? DEFAULT_CAMPAIGN;
  const outDir = outDirOverride ?? DEFAULT_OUT_DIR;

  const { outRoot, zipRoot, sourceRoot } = buildRoots({ outDir, campaign });

  const onlySizes = await resolveOnlySizes({ zipOnly, makePreview });

  if (zipOnly) {
    const formats = readFormatsFromCfg(cfg);
    await zipOnlyWorkflow({ outRoot, zipRoot, campaign, makePreview, sourceRoot, formats });
    return;
  }


  await generateFromFormatsJson({
    formatsAbsPath,
    outDirOverride,
    campaignOverride,
    clicktagOverride,
    shouldZip,
    templateOverride,
    mode,
    onlySizesFromPromptOrArgs: onlySizes,
  });

  if (makePreview) {
    const openAfter = hasFlag("--open");
    const port = Number(getArgValue("--port") ?? DEFAULT_PORT);
    await generateGlobalPreviewPage({ sourceRoot, openAfter, port });
  }
}

main().catch((err) => {
  console.error("❌", err?.stack || err?.message || String(err));
  process.exit(1);
});
