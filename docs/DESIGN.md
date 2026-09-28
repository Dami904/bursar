# Design: Graphite and gold

Chosen 28 Sep 2026 for the console, landing page and demo. It builds on PLAN.md §8.9.6 (a calm
finance-tool look where the budget bar is the main element).

**The idea:** the interface itself is black and white, so the only colours on screen carry
meaning: the status of money. Gold is the one decorative colour, a nod to Tameion's seals, and is
kept for the logo and the "anchored on Arc" badges.

## Logo

A **b with a coin for its bowl** (option 8): a black stem (white in dark mode) and a gold coin.
It's simple enough to hold up as a 16 px favicon.

```svg
<svg viewBox="0 0 64 64"><rect x="14" y="8" width="8" height="48" rx="4" fill="#161616"/><circle cx="36" cy="40" r="14" fill="#B08A2E"/></svg>
```

## Voice: minimal, not bare

- Few words. Short labels, one primary action per screen, numbers before sentences.
- The job page always shows: what's left, the budget bar, anything that needs you, the
  decisions, and the agents. Details (full reasoning, policy checks, transaction hashes) open
  one tap away, in a row or on the decision's evidence page.
- Every row says who did what ("Researcher · Insight for newsletter"), so two purchases never
  look the same.
- Status words are plain: **Paid** (settled), **Held** (reserved), **Needs you** (awaiting
  approval), **Stuck** (unresolved), **Blocked** (denied). The ledger names stay in the API.

## Tokens

| Token          | Light     | Dark      | Use                                 |
| -------------- | --------- | --------- | ----------------------------------- |
| `--bg`         | `#FAFAFA` | `#0B0B0B` | Page                                |
| `--surface`    | `#FFFFFF` | `#151515` | Cards, panels                       |
| `--border`     | `#E6E6E6` | `#2A2A2A` | Hairlines                           |
| `--text`       | `#111111` | `#EDEDED` | Body text                           |
| `--text-muted` | `#6E6E6E` | `#9A9A9A` | Supporting text, hashes             |
| `--accent`     | `#161616` | `#F2F2F2` | Primary buttons only (one per view) |
| `--on-accent`  | `#FFFFFF` | `#111111` | Text on primary buttons             |
| `--seal`       | `#B08A2E` | `#DDB75A` | Logo mark, "anchored" badge outline |
| `--seal-bg`    | `#F6EDD6` | `#2F2610` | "Anchored" badge fill               |
| `--seal-text`  | `#6E5516` | `#F0D796` | "Anchored" badge text               |
| `--track`      | `#EDEDED` | `#242424` | Budget bar: remaining               |

## Status colours (they mean exactly one thing each)

| State            | Light     | Dark      | Pill background (light / dark) | Pill text (light / dark) |
| ---------------- | --------- | --------- | ------------------------------ | ------------------------ |
| Paid (settled)   | `#1E7F4E` | `#4CC38A` | `#E3F2E9` / `#12301F`          | `#155E39` / `#7FD9AB`    |
| Held (reserved)  | `#5B45C9` | `#A495F2` | `#ECE8FB` / `#231D45`          | `#3F2F96` / `#C2B8F7`    |
| Needs you        | `#B7791F` | `#F0B849` | `#FBF0DA` / `#3A2C0C`          | `#7A4E0E` / `#F5CD76`    |
| Stuck            | `#D2603A` | `#F08A63` | `#FBE7DF` / `#3A1D12`          | `#8E3A1D` / `#F5A889`    |
| Blocked (denied) | `#B83232` | `#EE6A63` | `#F8E1E1` / `#3A1616`          | `#8A2222` / `#F39590`    |

Every pill also carries its text label, so colour is never the only signal.

## Type

- **Inter** for all interface text, in two weights (400 and 500).
- **Newsreader, italic** only for an agent's quoted reasoning: the "agent's voice".
- **JetBrains Mono** for transaction hashes, addresses and amounts in tables.

## Rules

- Follow the device's light or dark setting, with a manual toggle in settings.
- One primary (black or white) button per view; everything else is secondary (outlined).
- Gold appears only in the logo seal and "anchored on Arc" badges, never on buttons or data.
- No gradients, shadows or 3D. The landing page has one SVG/CSS animation.
- Money is shown in USDC to 2 decimals (4 for sub-cent amounts).
