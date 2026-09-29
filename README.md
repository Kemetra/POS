<div align="center">

<img src="docs/assets/brand/pos-pulse-logo.svg" alt="POS-Pulse logo" width="120" height="120"/>

# POS Pulse

**The Windows desktop POS terminal for the SmartDataPulse pharmacy platform.**

<p align="center">
  <a href="docs/product.md"><img alt="Product: POS Pulse" src="https://img.shields.io/badge/product-POS%20Pulse-0f766e?style=flat-square"></a>
  <a href="README.md"><img alt="Repo: POS-Pulse" src="https://img.shields.io/badge/repo-POS--Pulse-181717?style=flat-square&logo=github&logoColor=white"></a>
  <a href="docs/hardware-matrix.md"><img alt="Platform: Windows terminal" src="https://img.shields.io/badge/platform-Windows%20terminal-2563eb?style=flat-square"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-16a34a?style=flat-square"></a>
</p>

<p align="center">
  <a href=".nvmrc"><img alt="Node.js >=20" src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=nodedotjs&logoColor=white"></a>
  <a href="package-lock.json"><img alt="npm lockfile" src="https://img.shields.io/badge/npm-lockfile-cb3837?style=flat-square&logo=npm&logoColor=white"></a>
  <a href="tsconfig.json"><img alt="TypeScript strict" src="https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white"></a>
  <a href="package.json"><img alt="Electron 40" src="https://img.shields.io/badge/Electron-40-47848f?style=flat-square&logo=electron&logoColor=white"></a>
  <a href="src/renderer"><img alt="React 19" src="https://img.shields.io/badge/React-19-61dafb?style=flat-square&logo=react&logoColor=111827"></a>
  <a href="vite.config.ts"><img alt="Vite 8" src="https://img.shields.io/badge/Vite-8-646cff?style=flat-square&logo=vite&logoColor=white"></a>
  <a href="tailwind.config.ts"><img alt="Tailwind 4" src="https://img.shields.io/badge/Tailwind-4-06b6d4?style=flat-square&logo=tailwindcss&logoColor=white"></a>
  <a href="https://github.com/Kemetra/POS/blob/badges/loc.svg"><img alt="LOC" src="https://raw.githubusercontent.com/Kemetra/POS/badges/loc.svg"></a>
</p>

<p align="center">
  <a href=".specify/memory/constitution.md"><img alt="Electron: sandboxed" src="https://img.shields.io/badge/Electron-sandboxed-0f766e?style=flat-square"></a>
  <a href="src/shared/bridge-api.ts"><img alt="Bridge: typed only" src="https://img.shields.io/badge/bridge-typed%20only-7c3aed?style=flat-square"></a>
  <a href="migrations"><img alt="Local state: durable" src="https://img.shields.io/badge/local%20state-durable-16a34a?style=flat-square"></a>
  <a href="docs/hardware-matrix.md"><img alt="Hardware: MVP matrix" src="https://img.shields.io/badge/hardware-MVP%20matrix-f97316?style=flat-square"></a>
  <a href=".specify/memory/constitution.md"><img alt="Cards: no capture" src="https://img.shields.io/badge/cards-no%20capture-dc2626?style=flat-square"></a>
</p>

![POS Pulse terminal hero](docs/assets/hero-pos-pulse.svg)

</div>

---

## 🔗 Synchronization with Retail Tower OS

POS-Pulse is the **edge** of the platform — it speaks only to `Data-Pulse-2`'s contracts, never
to ERPNext. Catalogue flows **down** for offline lookup; finalized sales are captured locally in
the outbox, destined for the backend.

<p align="center">
  <img src="docs/assets/architecture/pos-pulse-architecture.svg" alt="Animated POS-Pulse synchronization diagram" width="100%"/>
</p>

<p align="center"><sub>POS-Pulse synchronization — catalogue down, sales captured to the outbox.</sub></p>

```text
POS-Pulse ──▶ Data-Pulse-2 ──▶ ERPNext Connector ──▶ ERPNext / Frappe
```

### Where POS-Pulse sits in Retail Tower OS

The full five-repo ecosystem, with the control-plane band on top and POS-Pulse as the highlighted **edge node**.

<p align="center">
  <img src="docs/assets/architecture/retail-tower-ecosystem.svg" alt="Retail Tower OS ecosystem diagram — five repositories with POS-Pulse highlighted as the edge node" width="100%"/>
</p>

<p align="center"><sub>POS-Pulse is the gold-badged node (★ THIS REPO). A live animated SVG that honors <code>prefers-reduced-motion</code>.</sub></p>

Full detail: [docs/architecture/synchronization.md](docs/architecture/synchronization.md) ·
Program control plane: [Retail-Tower-Orchestrator](https://github.com/ahmed-shaaban-94/Retail-Tower-Orchestrator).

---

## Live terminal control map

[![POS Pulse live terminal map preview](docs/assets/pos-pulse-live-map-preview.svg)](docs/architecture/pos-pulse-live-map.html)

Open the [interactive Three.js terminal map](docs/architecture/pos-pulse-live-map.html) through a local static server or docs host. It is backed by [topology JSON](docs/architecture/pos-pulse-live-map.json); the README stays GitHub-safe with the static SVG preview above.

---

## Repository structure flow

Every layer of POS Pulse — from the cashier's first scan to the SaaS handoff — in one animated diagram, framed by Spec Kit governance on the left and the quality and state machinery on the right.

![POS Pulse animated repository structure flow](docs/assets/structure-flowchart.svg)

Open [the structure flowchart](docs/assets/structure-flowchart.svg) directly for the full-resolution animated view. It traces each authenticated path: UI events into the renderer, validated payloads through the typed bridge, durable writes into SQLite, secrets through `safeStorage`, and contract-backed sync to the platform.

---

## Current implementation status

The active feature is [`specs/010-pos-catalog-read-down-consumption`](specs/010-pos-catalog-read-down-consumption) — planning is complete and implementation is blocked pending backend contract, migration-safety, and owner-approval gates. Everything through product search and barcode lookup is complete.

| Area | Status | Evidence |
| --- | --- | --- |
| Secure Electron foundation | Complete | [`specs/001-foundation`](specs/001-foundation) |
| Terminal pairing | Complete | [`specs/002-terminal-pairing`](specs/002-terminal-pairing) |
| POS shell and operator sessions | Complete | [`specs/003-pos-ui-shell`](specs/003-pos-ui-shell) · [`specs/004-operator-session`](specs/004-operator-session) |
| Sales cart and payments tender | Complete | [`specs/005-sales-cart`](specs/005-sales-cart) · [`specs/006-payments-tender`](specs/006-payments-tender) |
| POS visual system | Complete | [`specs/007-pos-visual-system`](specs/007-pos-visual-system) |
| Sale finalization and receipts | Complete (internal/dev MVP) | [`specs/008-sale-finalization-and-receipts`](specs/008-sale-finalization-and-receipts) |
| Product search and barcode lookup | Complete | [`specs/009-product-search-and-barcode-lookup`](specs/009-product-search-and-barcode-lookup) |
| Catalogue read-down consumption | Planned; blocked pending gates | [`specs/010-pos-catalog-read-down-consumption`](specs/010-pos-catalog-read-down-consumption) |

---

## What you can verify today

| Claim | Repo-backed evidence |
| --- | --- |
| Renderer cannot reach Node/Electron directly | [preload bridge](src/preload) · [bridge API](src/shared/bridge-api.ts) |
| High-trust work stays in Electron main | [main process](src/main) · [constitution](.specify/memory/constitution.md) |
| Money avoids floating point | [shared money code](src/shared) · [constitution](.specify/memory/constitution.md) |
| Local terminal state is migration-backed | [SQLite migrations](migrations) |
| Hardware scope is intentionally narrow | [hardware matrix](docs/hardware-matrix.md) |
| Backend/API source of truth is external | [API snapshot](scripts/openapi-snapshot.json) · [constitution](.specify/memory/constitution.md) |

---

## Why this exists

Pharmacy checkout needs a terminal that feels fast to cashiers and boringly safe to operators. **POS Pulse keeps high-trust work in the Electron main process, keeps the renderer behind a typed preload bridge, and treats local terminal state as operationally important — not incidental UI cache.**

The backend SaaS platform lives outside this repository. POS Pulse consumes its contracts and keeps local terminal behavior secure, observable, and offline aware.

> **Success metric.** A cashier completes a sale, prints a receipt, and opens the drawer in under 10 seconds — with every transaction durably recorded and attributable to a named operator at a specific terminal, regardless of network state.

---

## Capabilities

<table>
<tr>
<td width="33%" align="center" valign="top">
  <img src="docs/assets/icons/secure-electron.svg" width="72" alt=""/><br/>
  <strong>Secure Electron boundary</strong><br/>
  <sub><code>contextIsolation</code>, sandboxing, and a typed preload bridge keep renderer code away from Node APIs.</sub>
</td>
<td width="33%" align="center" valign="top">
  <img src="docs/assets/icons/terminal-pairing.svg" width="72" alt=""/><br/>
  <strong>Terminal pairing</strong><br/>
  <sub>Device identity and branch scope are established through explicit pairing flows.</sub>
</td>
<td width="33%" align="center" valign="top">
  <img src="docs/assets/icons/operator-session.svg" width="72" alt=""/><br/>
  <strong>Operator sessions</strong><br/>
  <sub>Cashier, manager, and admin access is enforced through local session and role surfaces.</sub>
</td>
</tr>
<tr>
<td align="center" valign="top">
  <img src="docs/assets/icons/local-database.svg" width="72" alt=""/><br/>
  <strong>Local durability</strong><br/>
  <sub>SQLite migrations preserve terminal state and audit/event records predictably.</sub>
</td>
<td align="center" valign="top">
  <img src="docs/assets/icons/audit-trail.svg" width="72" alt=""/><br/>
  <strong>Audit &amp; redaction</strong><br/>
  <sub>Logs and audit events avoid PII, cards, secrets, and unsafe payloads.</sub>
</td>
<td align="center" valign="top">
  <img src="docs/assets/icons/hardware.svg" width="72" alt=""/><br/>
  <strong>Hardware discipline</strong><br/>
  <sub>Windows x64, keyboard-wedge scanners, receipt printers, and optional cash drawers — intentionally narrow.</sub>
</td>
</tr>
</table>

---

## Terminal architecture

POS Pulse is an Electron 40 + React 19 + Vite 8 application. The app is split across the Electron main process, a typed preload bridge, the renderer, local SQLite, and generated API types from the SmartDataPulse platform contract.

![POS Pulse architecture](docs/assets/architecture-terminal.svg)

```mermaid
flowchart LR
  cashier["Cashier / operator"]
  renderer["src/renderer<br/>React POS UI"]
  preload["src/preload<br/>typed contextBridge"]
  main["src/main<br/>Electron main process"]
  sqlite[("SQLite<br/>local terminal state")]
  secrets["safeStorage<br/>device secrets"]
  api["SmartDataPulse API<br/>external SaaS backend"]
  hardware["Supported hardware<br/>scanner, printer, drawer"]

  cashier --> renderer
  renderer -- typed bridge only --> preload
  preload --> main
  main --> sqlite
  main --> secrets
  main -. contract-backed calls .-> api
  renderer -. keyboard wedge / print UX .-> hardware
```

---

## End-to-end transaction flow

A sale travels through every process boundary — and never crosses one without a contract.

![POS Pulse transaction flow](docs/assets/system-flow.svg)

| Step | Lane | What happens |
| :--: | --- | --- |
| **1** | Renderer | Cashier scans an SKU; React cart state updates in minor-unit money. |
| **2** | Preload | The typed `contextBridge` contract validates the call payload. |
| **3** | Main | Zod + money invariants check the transaction before any state mutates. |
| **4** | Main | A redacted audit event is composed — PII, card, and secret fields are stripped. |
| **5** | SQLite | The transactional migration runner commits the sale and the audit event together. |
| **6** | SaaS | Online? An idempotent, contract-backed sync hands the receipt off to the platform. |

---

## Repository map

| Path | Purpose |
| --- | --- |
| `src/main` | Electron main process · SQLite access · pairing · audit · logging · operator lifecycle · secrets · IPC handlers · observability |
| `src/preload` | Typed preload bridge exposed through `contextBridge` |
| `src/renderer` | React + Vite renderer · shell · routes · UI primitives · operator surfaces · design tokens |
| `src/shared` | Shared types · money utilities · audit schemas · bridge contracts · pairing types · operator roles |
| `migrations` | Versioned SQLite migration files applied by the local migration runner |
| `tests` | Unit and integration coverage outside process-local source test folders |
| `specs` | Spec Kit artifacts for foundation, pairing, POS shell, operator sessions, sales, payments, visual system, sale finalization, product search, catalogue read-down |
| `docs` | Documentation index · hardware matrix · product · design system · runbooks · architecture · assets |
| `scripts` | Codegen, dev-electron launcher, perf seeds, LOC badge automation |
| `.specify` | Spec Kit infrastructure · constitution v1.3.0 · templates |
| `.github` | CI workflows · PR template · `windows-latest` gates |

### What this repo owns
Windows 10/11 x64 Electron POS terminal · secure process boundaries · typed preload bridge · local SQLite migrations and terminal state · pairing, operator session, audit, logging, renderer shell · POS UI primitives, routes, and design tokens · MVP hardware compatibility docs.

### What this repo does **not** own
SmartDataPulse SaaS backend · backend OpenAPI source-of-truth · dashboard/admin web app · broad hardware compatibility outside the MVP matrix · PCI card-terminal integration or direct card capture.

---

## Tech stack

| Layer | Stack |
| --- | --- |
| Desktop runtime | Electron 40 · Windows 10/11 x64 target |
| Renderer | React 19 · Vite 8 · Tailwind 4 |
| Language | TypeScript 5 strict mode |
| Local data | `better-sqlite3` · SQL migrations |
| Security | Electron sandbox · context isolation · typed preload bridge · `safeStorage` |
| Observability | pino · Sentry Electron |
| Testing | Vitest · Testing Library · happy-dom · axe-core |
| Packaging | electron-builder unsigned Windows directory build |

---

## Getting started

**Prerequisites.** Node.js 20+ · npm with the committed `package-lock.json` · Windows 10/11 x64 for the target runtime and package dry-run.

```bash
npm install            # install dependencies
npm run dev            # run Vite + Electron together
npm run typecheck      # both tsconfigs
npm run lint           # eslint + prettier --check
npm test               # vitest
npm run package:dir    # electron-builder --win --dir (unsigned)
```

**Codegen.** The codegen flow uses the pinned OpenAPI snapshot unless a later feature moves the project to a live contract source.

```bash
npm run codegen:api     # regenerate src/shared/api-types.ts
npm run codegen:verify  # CI helper: regen → diff
```

---

## Documentation

| Audience | First reads |
| --- | --- |
| **Product & operations** | [Product brief](docs/product.md) · [Hardware matrix](docs/hardware-matrix.md) · [POS shell spec](specs/003-pos-ui-shell/spec.md) |
| **Engineering** | [Foundation quickstart](specs/001-foundation/quickstart.md) · [Pairing quickstart](specs/002-terminal-pairing/quickstart.md) · [Operator session plan](specs/004-operator-session/plan.md) · [Live terminal map](docs/architecture/pos-pulse-live-map.html) |
| **Design** | [Design system](docs/DESIGN.md) · [Visual system spec](specs/007-pos-visual-system/spec.md) |
| **Security** | [Constitution](.specify/memory/constitution.md) · [Operator security review](specs/004-operator-session/security-review/s1-review.md) |
| **Integration** | [Pairing HTTP contract](specs/002-terminal-pairing/contracts/pairing-http.md) · [Operator bridge contract](specs/004-operator-session/contracts/bridge-api.md) · [API snapshot](scripts/openapi-snapshot.json) |

Full navigation lives in [docs/README.md](docs/README.md). Operational playbooks live in [docs/runbook](docs/runbook) (payments, sale finalization, product search, sales cart, security review).

---

## Development agreement

POS Pulse follows the project constitution and Spec Kit workflow. Keep changes thin, test first, preserve secure Electron boundaries, avoid unsafe logging, and do not change dependency manifests, lockfiles, migrations, or security posture without explicit approval.

<div align="center">
<sub>Precise · accountable · unhurried.</sub>
</div>
