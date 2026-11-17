// node --test test_hud.mjs
// Black-box: runs hud.mjs as Claude Code does, with HOME pointed at a scratch
// directory so the real caches, Keychain and network are never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HUD = join(dirname(fileURLToPath(import.meta.url)), 'hud.mjs');
const HOUR = 3_600_000;
const base = { model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' }, effort: { level: 'xhigh' },
  cwd: '/srv/projects/myapp' };
const week = { used_percentage: 17 };

function render(payload, sys) {
  const home = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'hud-test-'));
  try {
    const dir = join(home, '.claude', 'hud');
    mkdirSync(dir, { recursive: true });
    // A fresh usage cache answers the per-model row, so nothing goes online.
    writeFileSync(join(dir, '.usage-cache.json'), JSON.stringify({ timestamp: Date.now(), error: false,
      data: { name: 'Fable', pct: 16, resets_at: null, active: false } }));
    if (sys) writeFileSync(join(dir, '.sys-cache.json'), JSON.stringify(sys));
    const r = spawnSync(process.execPath, [HUD], { input: JSON.stringify(payload), encoding: 'utf8',
      env: { ...process.env, HOME: home } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.replace(/\x1b\[[0-9;]*m/g, '').replace(/\u00a0/g, ' ').trimEnd().split('\n');
  } finally { rmSync(home, { recursive: true, force: true }); }
}

test('5-hour bucket present: 5h / 7d / model cap in the free column, folder in column 1', () => {
  const rows = render({ ...base, rate_limits: { five_hour: { used_percentage: 58 }, seven_day: week } });
  assert.match(rows[0], /^Opus 5\.5\s+⋮ ctx.*⋮ 5h\s+●●●○○  58%$/);
  assert.match(rows[1], /^xhigh\s+⋮ tok\/s.*⋮ 7d\s+●○○○○  17%$/);
  assert.match(rows[2], /^📁 \S+\s+⋮ Cache.*⋮ Fable ●○○○○  16%$/);
  assert.equal(rows[0].indexOf('⋮'), 16, 'column 1 is 15 wide while it holds the folder');
});

test('no 5-hour bucket, none seen before: quotas move up, full folder in the free column', () => {
  const rows = render({ ...base, rate_limits: { seven_day: week } });
  assert.match(rows[0], /^Opus 5\.5\s+⋮ ctx.*⋮ 7d\s+●○○○○  17%$/);
  assert.match(rows[1], /^xhigh\s+⋮ tok\/s.*⋮ Fable ●○○○○  16%$/);
  assert.match(rows[2], /^\s+⋮ Cache.*⋮ 📁 \/srv\/projects\/myapp$/);
  assert.ok(!rows.join('\n').includes('5h'));
  assert.equal(rows[0].indexOf('⋮'), 11, 'column 1 narrows to 10 without the folder');
});

test('bucket missing but seen an hour ago: 5-hour layout stays, cell shows a placeholder', () => {
  const rows = render({ ...base, rate_limits: { seven_day: week } }, { fiveHourSeen: Date.now() - HOUR });
  assert.match(rows[0], /⋮ 5h\s+○○○○○\s+—$/);
  assert.match(rows[2], /^📁 /);
});

test('bucket last seen over a day ago: the account no longer has a 5-hour window', () => {
  const rows = render({ ...base, rate_limits: { seven_day: week } }, { fiveHourSeen: Date.now() - 25 * HOUR });
  assert.ok(!rows.join('\n').includes('5h'));
  assert.match(rows[2], /⋮ 📁 \/srv\/projects\/myapp$/);
});

test('effort cell is the level alone: no thinking tag, on or off', () => {
  for (const enabled of [true, false]) {
    const rows = render({ ...base, thinking: { enabled }, rate_limits: { seven_day: week } });
    assert.match(rows[1], /^xhigh\s+⋮/);
    assert.ok(!/💭|\bOn\b|\bOff\b/.test(rows.join('\n')));
  }
});
