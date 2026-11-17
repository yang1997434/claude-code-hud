#!/usr/bin/env node
/**
 * Claude Code HUD — a 3-line, column-aligned statusline for Claude Code.
 *
 *   Opus 5          ⋮ ctx      52% ⋮ cpu   32% ⋮ 5h    ●●●○○  58% ↻3h10m
 *   xhigh           ⋮ tok/s    164 ⋮ mem   37% ⋮ 7d    ●○○○○  17% ↻5d3h
 *   📁 ~/data/claude ⋮ Cache  99.2% ⋮ disk  11% ⋮ Fable ●●●○○  69% ↻1d6h
 *
 * Accounts without a 5-hour window (verified Ultra) get the folder in the free
 * column instead, where it has room for the whole path:
 *
 *   Opus 5     ⋮ ctx      52% ⋮ cpu   32% ⋮ 7d    ●○○○○  17% ↻5d3h
 *   xhigh      ⋮ tok/s    164 ⋮ mem   37% ⋮ Fable ●●●○○  69% ↻1d6h
 *              ⋮ Cache  99.2% ⋮ disk  11% ⋮ 📁 ~/data/claude/myapp
 *
 * Layout: a fixed 4-column grid. Columns 1–3 have FIXED widths (never derived
 * from content) and are separated by a dashed rule, so a value changing from 9% to 100%
 * or a model swap can never shove the rest of the row sideways. Column 4 is
 * free — it holds the only genuinely variable-width content (cwd, quota rings)
 * and sits at the right edge where drift costs nothing.
 *
 * Within a metric cell the label is left-aligned and the value right-aligned
 * against the divider, so labels and digits each form their own sub-column.
 *
 * Data sources:
 *  - Everything on rows 1 and the quota column comes from the statusline stdin
 *    payload (model, effort, cwd, context_window, rate_limits).
 *    Claude Code hands us rate_limits directly, so the 5h/7d cells cost nothing.
 *  - The per-model weekly cap ("Fable 69%") is the one number Claude Code does
 *    not hand to the statusline, so it is fetched from the OAuth usage endpoint
 *    and cached for 60s. Everything else is local.
 *  - Cache (session cache-hit rate) and tok/s are aggregated from the session
 *    transcript JSONL, scanned incrementally: each render reads only the bytes
 *    appended since the last one and folds them into a cached running total.
 *  - cpu/mem read /proc on Linux; on macOS cpu comes from node:os per-core
 *    counters and mem from vm_stat. disk uses statfs everywhere.
 *
 * Optional config: ~/.claude/hud/config.json
 *   { "diskPath": "/data", "cols": [9, 9, 10], "sep": "⋮" }
 */

import { readFileSync, writeFileSync, statfsSync } from 'node:fs';
import { execSync, execFileSync } from 'node:child_process';
import { homedir, cpus, totalmem } from 'node:os';
import { join } from 'node:path';

const VERSION = '2.2.0';

const HOME = homedir();
const HUD_DIR = join(HOME, '.claude', 'hud');
const SYS_CACHE_PATH = join(HUD_DIR, '.sys-cache.json');
const USAGE_CACHE_PATH = join(HUD_DIR, '.usage-cache.json');
const USAGE_TTL = 60_000;        // the statusline reruns every 2s; the API must not
const USAGE_TTL_ERR = 30_000;    // see that rate, so responses are cached
// Claude Code's public OAuth client id (same one the CLI itself uses).
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const SESSION_CACHE_PATH = join(HUD_DIR, '.session-cache.json');

// ── User config (all optional) ──────────────────────
function loadConfig() {
  try {
    return JSON.parse(readFileSync(join(HUD_DIR, 'config.json'), 'utf8'));
  } catch { return {}; }
}
const CFG = loadConfig();
const DISK_PATH = typeof CFG.diskPath === 'string' ? CFG.diskPath : '/';
// Fixed widths for columns 1–3. Column 4 is free.
// Sized to the longest real content in each column and no wider: "Sonnet 5.5",
// "ultracode", "tok/s 1234". Cell content is left-aligned against the divider;
// only the number inside a metric is right-padded, so digits still stack.
// Column 1 has two defaults: 15 while it also holds the folder (accounts with
// a 5-hour window), 10 once the folder has moved to the free column.
const USER_COLS = Array.isArray(CFG.cols) && CFG.cols.length === 3 ? CFG.cols.map(Number) : null;
const COLS = USER_COLS ?? [15, 12, 9];
const COL1_NO_FOLDER = USER_COLS ? USER_COLS[0] : 10;

const EMO = { cwd: '📁' };

// ── Theme-aware palette ─────────────────────────────
const rgb = (r, g, b) => `\x1b[38;2;${r};${g};${b}m`;

function detectLightBg() {
  try {
    const s = JSON.parse(readFileSync(join(HOME, '.claude', 'settings.json'), 'utf8'));
    return typeof s.theme === 'string' && s.theme.startsWith('light');
  } catch { return false; }
}
const LIGHT_BG = detectLightBg();

const C = LIGHT_BG ? {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  blue: rgb(32, 94, 166), orange: rgb(188, 82, 21), green: rgb(30, 120, 40),
  cyan: rgb(36, 131, 123), red: rgb(175, 48, 41), yellow: rgb(173, 131, 1),
  magenta: rgb(94, 64, 157), white: rgb(64, 62, 55), gray: rgb(111, 110, 105),
  dimGray: rgb(183, 181, 172),
} : {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  blue: rgb(0, 153, 255), orange: rgb(255, 176, 85), green: rgb(0, 160, 0),
  cyan: rgb(46, 149, 153), red: rgb(255, 85, 85), yellow: rgb(230, 200, 0),
  magenta: rgb(200, 100, 255), white: rgb(220, 220, 220), gray: rgb(128, 128, 128),
  dimGray: rgb(80, 80, 80),
};

// Column divider. Default is a dashed rule: stacked across three rows a solid
// "│" welds into one unbroken line, which reads as a table border rather than
// as three separate rows. The dashes keep the columns aligned while letting the
// rows stay visually distinct. Override with "sep" in config.json.
const SEP = typeof CFG.sep === 'string' ? CFG.sep : '⋮';
const BAR = SEP ? `${C.dimGray}${SEP}${C.reset}` : '';

// ── Display width ───────────────────────────────────
// Column alignment is only as good as the width measurement. Strip ANSI, walk
// grapheme clusters, and count the double-width ones (CJK, emoji, flags) as 2.
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const SEG = typeof Intl !== 'undefined' && Intl.Segmenter
  ? new Intl.Segmenter('en', { granularity: 'grapheme' }) : null;

function isWide(cp) {
  return (cp >= 0x1100 && cp <= 0x115F) || (cp >= 0x2E80 && cp <= 0xA4CF)
    || (cp >= 0xAC00 && cp <= 0xD7A3) || (cp >= 0xF900 && cp <= 0xFAFF)
    || (cp >= 0xFE30 && cp <= 0xFE6F) || (cp >= 0xFF00 && cp <= 0xFF60)
    || (cp >= 0xFFE0 && cp <= 0xFFE6) || (cp >= 0x1F300 && cp <= 0x1F9FF)
    || (cp >= 0x1FA70 && cp <= 0x1FAFF) || (cp >= 0x1F1E6 && cp <= 0x1F1FF);
}

function dispWidth(str) {
  const plain = str.replace(ANSI_RE, '');
  let w = 0;
  const clusters = SEG ? [...SEG.segment(plain)].map(s => s.segment) : [...plain];
  for (const g of clusters) {
    const cps = [...g].map(ch => ch.codePointAt(0));
    // A regional-indicator pair renders as one 2-cell flag.
    if (cps.some(isWide)) { w += 2; continue; }
    if (cps[0] === 0x200D || cps[0] === 0xFE0F) continue;
    w += 1;
  }
  return w;
}

// Pad to an exact column width; truncate with "…" if the content overflows.
function fit(str, width, align = 'left') {
  const w = dispWidth(str);
  if (w > width) {
    const plain = str.replace(ANSI_RE, '');
    let out = '', acc = 0;
    for (const ch of plain) {
      const cw = dispWidth(ch);
      if (acc + cw > width - 1) break;
      out += ch; acc += cw;
    }
    return out + '…' + ' '.repeat(Math.max(0, width - acc - 1));
  }
  const pad = ' '.repeat(width - w);
  return align === 'right' ? pad + str : str + pad;
}

// A metric cell: label flush left, value flush right, so every value in a
// column shares one right edge regardless of label length.
function metric(label, value, width) {
  const gap = Math.max(1, width - dispWidth(label) - dispWidth(value));
  return `${C.white}${label}${C.reset}${' '.repeat(gap)}${value}`;
}

// ── Helpers ─────────────────────────────────────────
function healthColor(pct) {
  if (pct >= 90) return C.red;
  if (pct >= 75) return C.orange;
  if (pct >= 50) return C.yellow;
  return C.green;
}

// The OAuth endpoint hands back an ISO string; the statusline payload hands back
// the raw `anthropic-ratelimit-unified-reset` header, which is epoch SECONDS.
// Feeding those seconds to `new Date()` lands in 1970 and every countdown reads
// "now", so normalise both shapes here.
function fmtResetRelative(at) {
  if (at == null || at === '') return '';
  let ms;
  if (typeof at === 'number') ms = at < 1e12 ? at * 1000 : at;
  else if (/^\d+$/.test(String(at))) ms = Number(at) < 1e12 ? Number(at) * 1000 : Number(at);
  else ms = new Date(at).getTime();
  if (!Number.isFinite(ms)) return '';
  const diffMs = ms - Date.now();
  if (diffMs <= 0) return 'now';
  const totalMin = Math.floor(diffMs / 60_000);
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours < 1) return `${mins}m`;
  if (hours < 24) return `${hours}h${String(mins).padStart(2, '0')}m`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d${remHours}h` : `${days}d`;
}

function quotaCircles(pct) {
  const clamped = Math.min(100, Math.max(0, pct));
  const full = Math.round(clamped / 20);
  const clr = healthColor(clamped);
  return `${clr}${'●'.repeat(full)}${C.dimGray}${'○'.repeat(5 - full)}${C.reset}`;
}

// The quota rows stack in the free column, so they align among themselves:
// every label is padded to the widest one ("Fable" is longer than "5h"), which
// puts the ring blocks, the percentages and the countdowns each in their own
// sub-column. `labelW` is that shared width.
function quotaRow(label, pct, resetsAt, labelW, bold = false) {
  const name = `${bold ? C.bold : ''}${C.white}${label}${C.reset}`;
  const pad = ' '.repeat(Math.max(0, labelW - dispWidth(label)));
  if (pct == null) {
    return `${name}${pad} ${C.dimGray}○○○○○${C.reset} ${C.dim}  —${C.reset}`;
  }
  const p = Math.round(pct);
  const reset = fmtResetRelative(resetsAt);
  return `${name}${pad} ${quotaCircles(p)} ${healthColor(p)}${String(p).padStart(3)}%${C.reset}`
    + (reset ? ` ${C.gray}↻${reset}${C.reset}` : '');
}

// A bucket can be absent before the session's first response, or right after a
// window rolls over. Render a placeholder rather than letting the cell vanish —
// a segment that silently disappears reads as a bug.
function quotaCell(label, bucket, labelW) {
  const pct = bucket && typeof bucket.used_percentage === 'number' ? bucket.used_percentage : null;
  return quotaRow(label, pct, bucket?.resets_at, labelW);
}

// The per-model weekly cap. Its label is the model name, and when this is the
// binding limit the label goes bold — that is the number that stops you first.
function scopedCell(s, labelW) {
  if (!s || typeof s.pct !== 'number') return '';
  return quotaRow(s.name, s.pct, s.resets_at, labelW, s.active);
}

// ── System stats ────────────────────────────────────
function readProcStat() {
  try {
    const line = readFileSync('/proc/stat', 'utf8').split('\n', 1)[0];
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = parts;
    return { total: user + nice + system + idle + iowait + irq + softirq + steal, idle: idle + iowait, ts: Date.now() };
  } catch { return cpuSampleFromCpus(cpus()); }
}

// No /proc (macOS): sum the per-core counters node:os exposes; same delta math applies.
function cpuSampleFromCpus(list) {
  if (!Array.isArray(list) || !list.length) return null;
  let total = 0, idle = 0;
  for (const c of list) { for (const v of Object.values(c.times)) total += v; idle += c.times.idle; }
  return { total, idle, ts: Date.now() };
}

function getCpuPct() {
  const now = readProcStat();
  if (!now) return null;
  let pct = null;
  let cache = {};
  try { cache = JSON.parse(readFileSync(SYS_CACHE_PATH, 'utf8')); } catch { /* first run */ }
  if (cache?.cpu && (now.ts - cache.cpu.ts) < 30_000) {
    const totalDiff = now.total - cache.cpu.total;
    const idleDiff = now.idle - cache.cpu.idle;
    if (totalDiff > 0) pct = Math.max(0, Math.min(100, Math.round((1 - idleDiff / totalDiff) * 100)));
  }
  try { cache.cpu = now; writeFileSync(SYS_CACHE_PATH, JSON.stringify(cache)); } catch { /* ignore */ }
  return pct;
}

function getMemPct() {
  try {
    const raw = readFileSync('/proc/meminfo', 'utf8');
    const pick = (key) => {
      const m = raw.match(new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm'));
      return m ? parseInt(m[1], 10) : null;
    };
    const total = pick('MemTotal'), available = pick('MemAvailable');
    if (!total || available == null) return null;
    return Math.round(((total - available) / total) * 100);
  } catch {
    if (process.platform !== 'darwin') return null;
    try { return memPctFromVmStat(execFileSync('vm_stat', { encoding: 'utf8', timeout: 1000 }), totalmem()); } catch { return null; }
  }
}

// macOS vm_stat: "used" the way Activity Monitor counts it = active + wired + compressed pages.
function memPctFromVmStat(text, totalBytes) {
  const page = Number((text.match(/page size of (\d+) bytes/) || [])[1]);
  const pages = (key) => Number((text.match(new RegExp(`^${key}:\\s+(\\d+)\\.`, 'm')) || [])[1]);
  const used = pages('Pages active') + pages('Pages wired down') + pages('Pages occupied by compressor');
  if (!page || !totalBytes || Number.isNaN(used)) return null;
  return Math.max(0, Math.min(100, Math.round((used * page / totalBytes) * 100)));
}

function getDiskPct(path) {
  try {
    const s = statfsSync(path);
    const total = Number(s.blocks) * Number(s.bsize);
    if (!total) return null;
    return Math.round(((total - Number(s.bavail) * Number(s.bsize)) / total) * 100);
  } catch { return null; }
}

// ── Session stats: cache-hit rate + output speed ─────
// Both are session-wide facts that stdin cannot supply (its current_usage
// describes only the latest request), so they come from the transcript JSONL.
// The scan is incremental: state carries a byte offset plus running totals, and
// each render folds in only the newly appended lines.
function freshState(path) {
  return { path, offset: 0, prevTs: null, cur: null, seen: {}, seenN: 0,
           cr: 0, cc: 0, inp: 0, out: 0, recent: [], touched: Date.now() };
}

function loadSessionCache() {
  try { return JSON.parse(readFileSync(SESSION_CACHE_PATH, 'utf8')); } catch { return {}; }
}

function saveSessionCache(all) {
  try {
    // Drop sessions untouched for a day so the file cannot grow without bound.
    const cutoff = Date.now() - 86_400_000;
    for (const k of Object.keys(all)) if ((all[k]?.touched ?? 0) < cutoff) delete all[k];
    writeFileSync(SESSION_CACHE_PATH, JSON.stringify(all));
  } catch { /* ignore */ }
}

function finalizeReq(st) {
  const cur = st.cur;
  st.cur = null;
  if (!cur || cur.sidechain) return;
  const dur = (cur.last ?? 0) - (cur.start ?? 0);
  // Sub-second and absurd durations say more about when lines were flushed
  // than about generation speed, so they never enter the average.
  if (cur.out > 0 && dur >= 1000 && dur < 600_000) {
    st.recent.push({ out: cur.out, dur });
    if (st.recent.length > 5) st.recent.shift();
  }
}

function scanTranscript(st) {
  let buf;
  try { buf = readFileSync(st.path); } catch { return st; }
  if (buf.length < st.offset) st = freshState(st.path);   // truncated or rotated
  const end = buf.lastIndexOf(10) + 1;                    // only whole lines
  if (end <= st.offset) return st;

  for (const line of buf.subarray(st.offset, end).toString('utf8').split('\n')) {
    if (!line) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const ts = d.timestamp ? Date.parse(d.timestamp) : null;
    const u = d.type === 'assistant' ? d.message?.usage : null;

    if (u && d.requestId) {
      if (!st.seen[d.requestId]) {
        // A request's records are cumulative: usage repeats across them, so
        // only the first sighting contributes tokens.
        finalizeReq(st);
        st.seen[d.requestId] = 1;
        st.seenN++;
        st.cr += u.cache_read_input_tokens ?? 0;
        st.cc += u.cache_creation_input_tokens ?? 0;
        st.inp += u.input_tokens ?? 0;
        st.out += u.output_tokens ?? 0;
        st.cur = { id: d.requestId, start: st.prevTs, last: ts, out: u.output_tokens ?? 0,
                   sidechain: d.isSidechain === true };
      } else if (st.cur && st.cur.id === d.requestId) {
        st.cur.last = ts ?? st.cur.last;   // same response, later block
      }
    } else if (st.cur) {
      finalizeReq(st);
    }
    if (ts) st.prevTs = ts;
  }
  st.offset = end;

  // Keep the dedupe set bounded on very long sessions.
  const ids = Object.keys(st.seen);
  if (ids.length > 3000) for (const id of ids.slice(0, ids.length - 2000)) delete st.seen[id];
  st.touched = Date.now();
  return st;
}

function sessionStats(stdin) {
  const path = stdin.transcript_path
    || (stdin.session_id && stdin.cwd
        ? join(HOME, '.claude', 'projects', String(stdin.cwd).replace(/[/.]/g, '-'), `${stdin.session_id}.jsonl`)
        : null);
  if (!path) return null;

  const all = loadSessionCache();
  const key = stdin.session_id || path;
  let st = all[key];
  if (!st || st.path !== path) st = freshState(path);
  st = scanTranscript(st);
  all[key] = st;
  saveSessionCache(all);

  const totalIn = st.cr + st.cc + st.inp;
  const ch = totalIn > 0 ? (st.cr / totalIn) * 100 : null;

  // Speed over the last few completed requests, weighted by output size so one
  // short reply cannot swing the number.
  const window = st.recent.slice(-5);
  const outSum = window.reduce((a, r) => a + r.out, 0);
  const durSum = window.reduce((a, r) => a + r.dur, 0);
  const tps = durSum > 0 ? (outSum / (durSum / 1000)) : null;

  return { ch, tps, requests: st.seenN, out: st.out };
}

// ── Model-scoped weekly limit ───────────────────────
// stdin carries only the five_hour and seven_day buckets. The per-model weekly
// cap — the one that actually binds when you live on Opus or Fable — exists
// only in the OAuth usage endpoint's `limits[]`, as kind "weekly_scoped" with
// the model in `scope`. That is the sole reason this file talks to the network.
function getCredentials() {
  const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (envToken) return { accessToken: envToken };
  if (process.platform === 'darwin') {
    try {
      const raw = execSync('/usr/bin/security find-generic-password -s "Claude Code-credentials" -w',
        { encoding: 'utf8', timeout: 2000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      const parsed = JSON.parse(raw);
      return parsed.claudeAiOauth || parsed;
    } catch { /* fall through to the file */ }
  }
  try {
    const parsed = JSON.parse(readFileSync(join(HOME, '.claude', '.credentials.json'), 'utf8'));
    return parsed.claudeAiOauth || parsed;
  } catch { return null; }
}

async function refreshAccessToken(refreshToken) {
  try {
    const res = await fetch('https://platform.claude.com/v1/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}&client_id=${OAUTH_CLIENT_ID}`,
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    return (await res.json()).access_token || null;
  } catch { return null; }
}

function pickScoped(data) {
  const lim = (data?.limits || []).find(
    l => l.kind === 'weekly_scoped' && l.scope?.model?.display_name && typeof l.percent === 'number');
  if (!lim) return null;
  return { name: lim.scope.model.display_name, pct: lim.percent,
           resets_at: lim.resets_at, active: lim.is_active === true };
}

async function fetchScopedLimit() {
  let cached = null;
  try {
    const c = JSON.parse(readFileSync(USAGE_CACHE_PATH, 'utf8'));
    const ttl = c.error ? USAGE_TTL_ERR : USAGE_TTL;
    cached = c.data ?? null;
    if (Date.now() - (c.timestamp || 0) < ttl) return cached;
  } catch { /* no cache yet */ }

  const write = (data, error) => {
    // Keep the last good reading on a transient failure so the cell does not
    // blink out mid-session.
    try { writeFileSync(USAGE_CACHE_PATH, JSON.stringify({ timestamp: Date.now(), data: error ? cached : data, error })); }
    catch { /* ignore */ }
  };

  try {
    const creds = getCredentials();
    if (!creds?.accessToken) { write(null, true); return cached; }
    let token = creds.accessToken;
    if (creds.expiresAt && Date.now() > creds.expiresAt && creds.refreshToken) {
      token = (await refreshAccessToken(creds.refreshToken)) || token;
    }
    const call = (tk) => fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${tk}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(4000),
    });
    let res = await call(token);
    if (res.status === 401 && creds.refreshToken) {
      const fresh = await refreshAccessToken(creds.refreshToken);
      if (fresh) res = await call(fresh);
    }
    if (!res.ok) { if (process.env.HUD_DEBUG) console.error("scoped HTTP", res.status); write(null, true); return cached; }
    const scoped = pickScoped(await res.json());
    write(scoped, false);
    return scoped;
  } catch (e) { if (process.env.HUD_DEBUG) console.error("scoped fetch failed:", e?.name, e?.message); write(null, true); return cached; }
}

// ── 5-hour window ───────────────────────────────────
// Verified Ultra accounts have no 5-hour window, and their payload simply has
// no five_hour bucket. But the bucket is also missing before a session's first
// response and after a window has rolled over, so one missing bucket proves
// nothing: remember when one was last seen (any session) and keep the 5-hour
// layout for a day after that. An account that loses its window switches
// layout a day later; one that still has it never flickers.
const FIVE_HOUR_MEMORY_MS = 86_400_000;
const FIVE_HOUR_STAMP_MS = 600_000;   // rewrite the timestamp at most every 10 min

function hasFiveHour(bucket, nowMs = Date.now()) {
  let cache = {};
  try { cache = JSON.parse(readFileSync(SYS_CACHE_PATH, 'utf8')) || {}; } catch { /* first run */ }
  const seen = Number(cache.fiveHourSeen) || 0;
  if (bucket && typeof bucket.used_percentage === 'number') {
    if (nowMs - seen > FIVE_HOUR_STAMP_MS) {
      try { cache.fiveHourSeen = nowMs; writeFileSync(SYS_CACHE_PATH, JSON.stringify(cache)); } catch { /* ignore */ }
    }
    return true;
  }
  return nowMs - seen < FIVE_HOUR_MEMORY_MS;
}

// ── cwd ─────────────────────────────────────────────
// In column 1 the folder is a fixed-width cell, so long paths elide instead of
// stretching the grid (3 cells go to the "📁 " prefix). In the free column it
// has room for a full path or worktree name; only a very long one elides.
const CWD_MAX_FREE = 48;

function fmtCwd(cwd, CWD_MAX) {
  if (!cwd) return '';
  let p = cwd.startsWith(HOME) ? '~' + cwd.slice(HOME.length) : cwd;
  const wt = p.match(/^(.*?)\/\.claude\/worktrees\/([^/]+)$/);
  if (wt) p = `${wt[1].split('/').pop() || wt[1]}:wt/${wt[2]}`;
  if (p.length <= CWD_MAX) return p;
  const segs = p.split('/').filter(Boolean);
  if (segs.length >= 4) {
    const lead = p.startsWith('/') ? '/' : (p.startsWith('~') ? '~/' : '');
    const head = p.startsWith('~') ? '' : segs[0];
    const cand = `${lead}${head}${head ? '/' : ''}…/${segs.slice(-2).join('/')}`;
    if (cand.length <= CWD_MAX) return cand;
  }
  return '…' + p.slice(p.length - (CWD_MAX - 1));
}

// ── Grid ────────────────────────────────────────────
async function readStdin() {
  if (process.stdin.isTTY) return null;
  const chunks = [];
  try {
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) chunks.push(chunk);
    const raw = chunks.join('');
    return raw.trim() ? JSON.parse(raw) : null;
  } catch { return null; }
}

function pctVal(pct) {
  return pct == null ? `${C.dim}  —${C.reset}`
    : `${healthColor(pct)}${String(pct).padStart(3)}%${C.reset}`;
}

function buildGrid(stdin, scoped) {
  const sess = sessionStats(stdin) || {};

  // Model name → "Opus 5": strip "Claude ", a "(1M context)" tail, a "[1m]" tail.
  const id = stdin.model?.id ?? '';
  const name = (stdin.model?.display_name || id.replace('claude-', '').replace(/-\d{8}$/, ''))
    .replace(/^claude\s+/i, '').replace(/\s*\([^)]*\)\s*$/, '').replace(/\s*\[[^\]]*\]\s*$/, '').trim();
  let modelColor = C.cyan;
  if (/opus/i.test(id)) modelColor = C.magenta;
  else if (/sonnet/i.test(id)) modelColor = C.cyan;
  else if (/haiku/i.test(id)) modelColor = C.green;
  const modelCell = `${modelColor}${C.bold}${name}${C.reset}`;

  const effLvl = String(stdin?.effort?.level ?? '').toLowerCase();
  const effColor = { low: C.green, medium: C.cyan, high: C.blue, xhigh: C.magenta,
                     ultracode: C.red, max: C.red }[effLvl] || C.white;
  // Thinking is on by default, so it is not shown; the cell is the effort alone.
  const effCell = effLvl ? `${effColor}${effLvl}${C.reset}` : '';

  const rl = stdin.rate_limits || {};
  const fiveHour = hasFiveHour(rl.five_hour);
  const col1 = fiveHour ? COLS[0] : COL1_NO_FOLDER;

  const cwd = stdin.workspace?.current_dir ?? stdin.cwd ?? '';
  const cwdMax = fiveHour ? Math.max(8, col1 - 3) : CWD_MAX_FREE;
  const cwdCell = cwd ? `${EMO.cwd} ${C.white}${fmtCwd(cwd, cwdMax)}${C.reset}` : '';

  const cw = stdin.context_window;
  const ctxPct = cw
    ? (typeof cw.used_percentage === 'number'
        ? Math.min(100, Math.max(0, Math.round(cw.used_percentage)))
        : (cw.context_window_size > 0
            ? Math.round((cw.total_input_tokens / cw.context_window_size) * 100) : null))
    : null;

  const chPct = sess.ch == null ? null : Math.round(sess.ch * 10) / 10;
  const chCell = chPct == null
    ? metric('Cache', `${C.dim}    —${C.reset}`, COLS[1])
    // A high cache-hit rate is the healthy end here, so the health palette is
    // inverted: 99% must read green, not red.
    : metric('Cache', `${healthColor(100 - chPct)}${chPct.toFixed(1).padStart(5)}%${C.reset}`, COLS[1]);

  const tpsCell = sess.tps == null
    ? metric('tok/s', `${C.dim}   —${C.reset}`, COLS[1])
    : metric('tok/s', `${C.cyan}${String(Math.round(sess.tps)).padStart(4)}${C.reset}`, COLS[1]);

  // Widest quota label wins; "5h" and "7d" pad up to it.
  const qw = Math.max(2, scoped?.name ? dispWidth(scoped.name) : 0);
  const sevenDay = quotaCell('7d', rl.seven_day, qw);
  const scopedRow = scopedCell(scoped, qw);

  // Column 1 and the free column, top to bottom. With a 5-hour window the three
  // quotas fill the free column and the folder sits under the effort; without
  // one the quotas move up and the folder takes the freed slot.
  const [left, free] = fiveHour
    ? [[modelCell, effCell, cwdCell], [quotaCell('5h', rl.five_hour, qw), sevenDay, scopedRow]]
    : [[modelCell, effCell, ''], [sevenDay, scopedRow, cwdCell]];

  const joiner = BAR ? ` ${BAR} ` : '   ';
  const rows = [
    [fit(left[0], col1), metric('ctx', pctVal(ctxPct), COLS[1]),
     metric('cpu', pctVal(getCpuPct()), COLS[2]), free[0]],
    [fit(left[1], col1), tpsCell,
     metric('mem', pctVal(getMemPct()), COLS[2]), free[1]],
    [fit(left[2], col1), chCell,
     metric('disk', pctVal(getDiskPct(DISK_PATH)), COLS[2]), free[2]],
  ];

  return rows.map(cells => cells.filter(c => c !== '').join(joiner));
}

async function main() {
  const stdin = await readStdin();
  if (!stdin) process.exit(0);
  const scoped = await fetchScopedLimit();
  const lines = buildGrid(stdin, scoped);
  if (!lines.length) process.exit(0);
  // Spaces → NBSP so the terminal cannot collapse the grid's padding.
  console.log(lines.join('\n').replace(/ /g, ' '));
}

main();
