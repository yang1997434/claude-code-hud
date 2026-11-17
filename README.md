[English](README.md) | [中文](README.zh-CN.md)

# Claude Code HUD

A 3-line, column-aligned statusline for [Claude Code](https://claude.com/claude-code). Model, context, session cache-hit rate, output speed, system load, and your 5-hour / 7-day / per-model weekly quota — in one glanceable grid.

```
Opus 5.5        ⋮ ctx      52% ⋮ cpu    8% ⋮ 5h    ●●●○○  58% ↻3h10m
xhigh           ⋮ tok/s    105 ⋮ mem   34% ⋮ 7d    ●○○○○  17% ↻5d3h
📁 ~/code/myapp ⋮ Cache  99.0% ⋮ disk  21% ⋮ Fable ●○○○○  16% ↻2d11h
```

Accounts without a 5-hour window (verified Ultra) get a narrower first column, and the folder moves to the free column where the whole path fits:

```
Opus 5.5   ⋮ ctx      52% ⋮ cpu    8% ⋮ 7d    ●○○○○  17% ↻5d3h
xhigh      ⋮ tok/s    105 ⋮ mem   34% ⋮ Fable ●○○○○  16% ↻2d11h
           ⋮ Cache  99.0% ⋮ disk  21% ⋮ 📁 ~/code/myapp
```

Columns 1–3 have **fixed** widths — never derived from content — so a value going from 9% to 100%, a model swap, or a long path can't shove the rest of the row sideways (long paths keep their tail, e.g. `…jects/myapp` for `~/projects/myapp`). Within a metric cell the label sits flush left and the value flush right, so every value in a column shares one right edge. Column 4 is free: it holds the quota rows, which align among themselves on the widest label, and sits at the right edge where drift costs nothing.

The divider is a dashed `⋮` rather than a solid `│` on purpose: stacked across three rows, a solid rule welds into one unbroken line and the HUD starts reading as a boxed table instead of three separate rows.

## What's on it

| Column | Row 1 | Row 2 | Row 3 |
|--------|-------|-------|-------|
| 1 | Model, cleaned up and color-coded by family | Reasoning effort (colored by intensity) | Working directory (worktrees render as `repo:wt/name`) |
| 2 | Context window usage | **Output speed** | **Session cache-hit rate** |
| 3 | CPU utilization | Memory usage | Disk usage |
| 4 | 5-hour quota | 7-day quota | **Per-model weekly quota** (label = model name; bold when it is the binding limit) |

Without a 5-hour window, column 4 reads 7-day quota / per-model weekly quota / working directory, and the third row of column 1 stays empty.

**Cache** is the cache-hit rate across the *whole session*: `cache_read ÷ (cache_read + cache_creation + uncached input)`. Since a high number is the good end here, its color ramp is inverted — 99% reads green.

**tok/s** is output speed over the last 5 completed requests, weighted by output size so one short reply can't swing it. Samples under a second are discarded: they describe when lines were flushed to the transcript, not how fast the model generated.

Percentages share one health palette: **<50 green · 50–75 yellow · 75–90 orange · ≥90 red**. The whole HUD follows your Claude Code theme — on `light*` themes it swaps to a dark, Flexoki-aligned ink palette so nothing washes out.

## Install

**As a Claude Code plugin** (upgrades with `/plugin update`) — run inside Claude Code:

```
/plugin marketplace add yang1997434/claude-code-hud
/plugin install claude-code-hud@claude-code-hud
/claude-code-hud:setup
```

A plugin cannot set the main statusline by itself, so `setup` does it once: it asks before replacing a statusline you already have, then runs the same `install.sh` as below. From then on the plugin refreshes `~/.claude/hud/hud.mjs` at every session start, so an upgrade is `/plugin update` plus a new session. Customise through `config.json` — direct edits to the script are overwritten; use the script install if you want to hack on it.

**Or the one-liner:**

```bash
curl -fsSL https://raw.githubusercontent.com/yang1997434/claude-code-hud/main/install.sh | bash
```

**Or from a clone:**

```bash
git clone https://github.com/yang1997434/claude-code-hud.git
cd claude-code-hud && ./install.sh
```

**Or just ask your Claude** — paste this into Claude Code:

> Install the statusline from https://github.com/yang1997434/claude-code-hud : fetch its install.sh and run it, then confirm the statusLine entry in ~/.claude/settings.json.

Either way, the installer copies `hud.mjs` to `~/.claude/hud/`, backs up your `settings.json`, and points `statusLine` at the script. Restart Claude Code and the HUD appears.

### Requirements

- **Node.js ≥ 18.15** (`statfsSync`)
- Claude Code **2.0.71+**, which puts `rate_limits` in the statusline payload. On older versions the quota column is simply absent.
- A **subscription login** (Pro / Max / Ultra) for the quota column. On API-key setups those cells don't render; everything else still works.
- The per-model weekly row needs the OAuth token Claude Code already stores locally (macOS Keychain, `~/.claude/.credentials.json`, or `CLAUDE_CODE_OAUTH_TOKEN`). Without it that one row is simply absent.
- Linux or macOS (the installer and the plugin hook are bash); Windows is untested.
- CPU and memory work on both: Linux reads `/proc`, macOS uses Node's per-core counters and `vm_stat`. Anything unavailable shows a dash, never an error.

## Configuration

Optional. Create `~/.claude/hud/config.json`:

```json
{
  "diskPath": "/data",
  "cols": [15, 12, 9],
  "sep": "⋮"
}
```

| Key | Default | Effect |
|-----|---------|--------|
| `diskPath` | `"/"` | Mount point measured by the `disk` cell |
| `cols` | `[15, 12, 9]` | Fixed widths of columns 1–3. Widen column 1 if you want longer paths; the others are sized for `Cache 100.0%` and `disk 100%`. Left unset, column 1 is 10 instead of 15 when the account has no 5-hour window, since the folder is not in it then |
| `sep` | `"⋮"` | Column divider. `"┊"`, `"╎"`, `"¦"` also read well; `""` drops the dividers and aligns on padding alone |

## How it works

- Claude Code invokes the script (per `statusLine.refreshInterval`, every 2s) and pipes the session payload on stdin: model, context window, effort, cwd, and `rate_limits`. The 5h / 7d numbers come straight from that payload — no network involved.
- Whether the account has a **5-hour window** is read off the same payload. A `five_hour` bucket seen within the last 24 hours — by any session, remembered in `~/.claude/hud/.sys-cache.json` — keeps the 5-hour layout, so a bucket that is briefly missing (before a session's first response, or after a window rolls over) shows a placeholder instead of flipping the grid. An account that stops having one, such as a newly verified Ultra, switches layout a day later.
- The **per-model weekly cap** is the one number Claude Code does not hand to the statusline. It is read from the same OAuth usage endpoint the CLI uses, with the token Claude Code already stores (if that access token has expired, it is refreshed with the stored refresh token for this call only — nothing is written back), and cached in `~/.claude/hud/.usage-cache.json` for 60s (30s after an error) so the 2s refresh never hits the API at that rate. The last good reading is kept across transient failures. Set `HUD_DEBUG=1` to log why a fetch failed.
- **Cache** and **tok/s** are session-wide facts that stdin cannot supply — its `current_usage` describes only the latest request — so they are aggregated from the session transcript JSONL. The scan is incremental: a cache in `~/.claude/hud/.session-cache.json` holds a byte offset plus running totals, and each render parses only the bytes appended since the last one. Requests are de-duplicated by `requestId`, since one response can span several transcript records that repeat the same cumulative usage.
- Column alignment is measured, not guessed: ANSI codes are stripped and the remainder is walked as grapheme clusters, counting emoji, flags and CJK as two cells.
- CPU% is a delta between two samples (`/proc/stat` on Linux, Node's per-core counters on macOS) cached in `~/.claude/hud/.sys-cache.json`, so the first render shows `cpu —` and it settles from the second refresh on. Memory on macOS is counted the way Activity Monitor does: active + wired + compressed pages.
- **Privacy:** the only outbound requests go to Anthropic — the usage call and, when the stored token has expired, a token refresh — both with the credentials Claude Code already holds. Nothing else leaves your machine; the HUD reads local files and its own stdin.

## Uninstall

Plugin install — inside Claude Code:

```
/claude-code-hud:uninstall
/plugin uninstall claude-code-hud@claude-code-hud
```

Script install:

```bash
./uninstall.sh
```

Either way it removes the `statusLine` entry (only if it points at this HUD), the script, and its caches; `config.json` is kept.

## License

[MIT](LICENSE)
