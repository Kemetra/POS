# POS-Pulse Hardware Matrix

## Overview

POS-Pulse is a Windows-only POS terminal for the SmartDataPulse pharmacy platform. The
**hardware matrix** defines what physical devices the application is built and tested against
during the MVP. The matrix is deliberately narrow: shipping a small, well-supported set of
devices is preferable to advertising broad compatibility that the team cannot guarantee.

This document is a **reproduction**, not a redefinition. The authoritative source is
[`.specify/memory/constitution.md`](../.specify/memory/constitution.md) § Hardware (constitution
v1.7.0; scope originally established at v1.2.0; Display row added at v1.7.0). Any conflict between this file and the
constitution is resolved in favor of the constitution. Expanding either the In-Scope or
Out-of-Scope list requires a constitution amendment — see [How to update this doc](#how-to-update-this-doc).

The tested-models tables under each In-Scope category are intentionally empty in feature
`001-foundation`. Foundation does not exercise real hardware; it lays the substrate. Concrete
device entries land in feature `002-terminal-pairing` and the hardware-driver features that
follow.

## In Scope (MVP)

The five categories below are the only hardware surfaces POS-Pulse is built to support during
the MVP. A device that is not listed here is not supported.

### Workstation

Windows 10 or Windows 11 desktop or laptop, x64. This is the single primary build target. The
unsigned `--dir` build artifact produced by `npm run package:dir` (CI, `windows-latest`) MUST
launch on a clean Windows 10 or Windows 11 x64 machine without the development environment
installed (NFR-5).

| Model | Transport | Driver / firmware | Tested in feature | Known caveats |
|:------|:----------|:------------------|:------------------|:--------------|
| _None tested yet — first entry lands in feature 002+_ |  |  |  |  |

### Barcode scanner

**Keyboard-wedge (HID) only.** Scanners present themselves as keyboards and emit barcode data
as keystrokes. POS-Pulse does NOT integrate native scanner SDKs (Honeywell, Zebra DataWedge as
a native bridge, etc.) — wedge mode is the only transport.

| Model | Transport | Driver / firmware | Tested in feature | Known caveats |
|:------|:----------|:------------------|:------------------|:--------------|
| _OBSERVED (not promoted to tested)_ — **HONEYWELL HF680-RS-01 REV B** | Keyboard-wedge (HID) expected; model carries an **-RS** suffix implying an RS-232 variant — confirm wedge/HID mode before promotion | OS-level HID; no native SDK (wedge-only per scope) | 008 §A5 bench (observed 2026-05-30; see [specs/008-sale-finalization-and-receipts/coordination.md](../specs/008-sale-finalization-and-receipts/coordination.md) §"§A5 hardware smoke evidence (2026-05-30)") — **not promoted to a tested row; wedge-into-cart *integration test* still PENDING** | General scan smoke **passed** at the OS level (scanner emits data), AND an **in-POS screen scan smoke passed** (scanner data captured inside the POS screen on 2026-05-30). What remains: the automated **wedge-into-cart integration test** required by rule 1 before promotion (manual in-POS capture is not the integration test). Transport mode (wedge-HID vs RS-232) **to be confirmed** — scope is wedge-HID-only (rule 2). **Owner decision 2026-05-30 (Ahmed): the scanner is recorded as observed/tested for WEDGE INPUT ONLY — no native-SDK integration is in 008 scope** (consistent with the wedge-only Out-of-Scope rule). See coordination.md §"Owner decision — 008 §A5 hardware target (2026-05-30)". |

### Receipt printer

A local print adapter routes through the system printer queue. The **ESC/POS direct path is
preferred** when the connected printer supports it; printers that do not are driven through
the OS print path as a fallback. The choice is made per-printer, not per-feature: the receipt
template engine emits both an ESC/POS byte stream and a printable HTML/canvas fallback so the
same template renders on either path.

| Model | Transport | Driver / firmware | Tested in feature | Known caveats |
|:------|:----------|:------------------|:------------------|:--------------|
| _SUPERSEDED for 008 MVP_ — **Epson TM-T20III** | USB (serial fallback supported) | Epson Advanced Printer Driver (APD) v5.13+; ESC/POS direct command set | 008 (committed at T006 2026-05-26 in [specs/008-sale-finalization-and-receipts/coordination.md](../specs/008-sale-finalization-and-receipts/coordination.md) §"§A3 hardware-matrix coordination thread") | **Owner decision 2026-05-30 (Ahmed): SUPERSEDED for the 008 MVP by Option A (BIXOLON SRP-330 II, row below).** The §A3 commitment record itself is unchanged; this pair is simply not the 008 MVP target. Still a valid future target. ESC/POS direct path was preferred here, but ESC/POS is **descoped** for 008 (OS-print is the accepted path). See coordination.md §"Owner decision — 008 §A5 hardware target (2026-05-30)". |
| ✅ **TESTED (owner-accepted, 2026-05-30)** — **BIXOLON SRP-330 II** | USB (OS print queue); OS-print path (ESC/POS direct descoped for 008) | Vendor driver **installed**; OS-print path via `webContents.print`. **Best observed driver paper setting: 80 × 3276 mm continuous roll** (see caveats) | 008 §A5 — **T301 OS-print bench** (2026-05-30; see [coordination.md](../specs/008-sale-finalization-and-receipts/coordination.md) §"T301 OS-print bench result" + §"Owner bar-answer — 2026-05-30"). **Promoted to a TESTED row by owner acceptance (T523 closed 2026-05-30).** | **✅ Official OS-print-pipeline smoke PASSED (T301, 2026-05-30, PR #304):** a real 008 receipt printed from the official POS-Pulse OS-print pipeline (`webContents.print` via a secure offscreen window). **Render quality:** Arabic legible, English legible, **no** card/voucher data on the slip, **no** excess blank paper, feed/cut acceptable, darkness acceptable; **edge clipping resolved at a 70 mm printable body width** inside the 80 mm roll (`pageSize` stays 80 mm). **Accepted 008 §A5 printer target (Option A)**; Epson TM-T20III superseded for the MVP. **ESC/POS descoped; OS-print is the accepted path.** **Promotion provenance (honest re: rule 1):** there is **no automated CI integration test** for the physical print (CI has no hardware) — this row was promoted to *tested* on the **owner-run manual bench smoke** (observed; receipt photo on file with owner), accepted by Ahmed 2026-05-30. It is **owner-accepted, not CI-tested**. **Paper setting:** best observed is **80 × 3276 mm continuous roll** — short fixed forms (e.g. 80 × 287 mm) may feed excess blank paper. |

### Cash drawer

**Optional.** Cash drawers are opened by sending the kick command (DK1 or DK2 ESC/POS pulse)
through the receipt printer; POS-Pulse does not drive cash drawers directly. A failed
drawer-open command MUST surface a manual-override path per Constitution Principle IV — it
MUST NOT block the receipt print, and it MUST NOT auto-dismiss.

| Model | Transport | Driver / firmware | Tested in feature | Known caveats |
|:------|:----------|:------------------|:------------------|:--------------|
| _DEFERRED from 008 MVP_ — **APG VBS320 (Vasario)** | RJ-12 to printer (DK1 pulse) | Driven via the printer's DK1 ESC/POS command; no native USB driver required | 008 (committed at T006 2026-05-26) — **drawer hardware validation deferred out of 008 by owner decision 2026-05-30** | **Owner decision 2026-05-30 (Ahmed): 008 MVP will NOT block on cash-drawer hardware; drawer / DK1 hardware validation is deferred to a future hardware/peripheral spec.** The drawer-kick *code* (`drawer-kick.ts`, `DrawerFailureBanner`, `drawer_events` table) stays — built, 100% covered, merged; only the physical-drawer hardware bring-up defers. No cash-drawer model was observed on the 008 bench. See coordination.md §"Owner decision — 008 §A5 hardware target (2026-05-30)". |

### Display

Support is judged by the **effective CSS viewport** of the maximized POS window, not by the
physical panel size. Owner-approved policy: Jira RT-312 decisions D1–D8 and D15, summarised on
the Confluence page "POS display and scaling support policy (RT-312)".

| Effective CSS viewport | Status | Behaviour |
|:-----------------------|:-------|:----------|
| width < 1024 | Blocked | Width notice. |
| height < 600 | Blocked | Height notice (RT-313). |
| height 600–767 (width ≥ 1024) | Compact-height band — **supported only after verification on pilot hardware** | Sale and Checkout use the compact composition; amount due, commit, cancel and change stay visible, otherwise an in-surface notice blocks (RT-407, RT-412). |
| ≥ 1024 × 768 | Full reference | Normal composition. |

Rules at every size: never auto-zoom; page zoom is locked at 0 and reset on every launch; the
native menu bar is removed (RT-314).

**Pilot standard:** 1920×1080 panel, Windows Scale **100 %**, window maximized (≈ 1920×1009
with the menu bar removed; 983 with it). **125 %** is supported only with the menu bar removed
(≈ 1536×793). **150 %** is **not supported for the pilot** (≈ 1280×649 with the menu removed;
623 with it). All figures are calculated, not measured. A 1366×768 panel runs at 100 % only, and
only once the 600–767 band is verified.

Calculated (not measured) maximized viewports, as published in the policy page — CSS height ≈
panel height ÷ scale − 71 − 26 (menu bar). RT-314 has since removed the menu bar, which adds
back about 26 px to every height below.

| Panel | 100 % | 125 % | 150 % |
|:------|:------|:------|:------|
| 1920×1080 | 1920×983 | 1536×767 (≈ 793 without the menu) | 1280×623 (bench client 1265×609) — not supported for the pilot |
| 1366×768 | 1366×671 | 1093×517 | blocked (911 wide) |
| 1280×1024 | 1280×927 | 1024×722 | blocked |
| 1024×768 | 1024×671 | blocked | blocked |

| Model | Native resolution | Windows Scale | Tested in feature | Known caveats |
|:------|:------------------|:--------------|:------------------|:--------------|
| _None tested yet — the pilot display model is to be recorded during the site survey (RT-312 D8)_ |  |  |  |  |

## Out of Scope (MVP)

The following are **explicitly NOT supported** in the MVP. Adding any of them requires a
constitution amendment, not a doc edit.

- Android, iPad, iPhone, or any non-Windows POS form factor.
- Label printers and scales.
- Customer-facing displays (CFD / pole displays).
- Direct integration with card terminals (PIN pads, mPOS readers). Card capture stays on a
  separate PCI-DSS certified device per Constitution § Security.
- Native scanner SDKs (Honeywell, Zebra DataWedge as a native bridge, etc.) — wedge mode only.

## Operational rules

These rules are reproduced from constitution § Hardware. They constrain how POS-Pulse handles
the In-Scope hardware surface at runtime and at change-time.

1. **Tested-models registry MUST be kept in sync with reality.** Adding a model to any of the
   In-Scope tables above requires (a) updating the table in this file with the model's
   transport, driver/firmware version, and known caveats, AND (b) adding an integration test
   that exercises the device. A pull request that adds a model without both is incomplete.
2. **Wedge focus management.** Barcode scanner input is treated as keyboard input by default.
   The focus-management strategy MUST prevent stray scans from polluting unrelated fields. The
   pairing screen and the cart screen are the two contexts where wedge input is accepted by
   design; all other contexts MUST guard against accidental capture.
3. **Receipt template versioning.** Receipt templates are version-controlled assets, not
   hardcoded strings. The template engine MUST emit both an ESC/POS byte stream and a printable
   HTML/canvas fallback so the same template renders on the direct-print and OS-print paths
   without divergence.
4. **Hardware failures are loud, not silent** (Constitution Principle IV). A failed cash-drawer
   kick MUST surface a manual-override path; it MUST NOT block the receipt print and MUST NOT
   auto-dismiss. A failed receipt print MUST surface a retry/reprint affordance. A degraded
   mode (e.g., printer offline) is permitted, but the UI MUST display a persistent banner
   until the device recovers — silent degradation is PROHIBITED.

## How to update this doc

This document is a registry, not a policy. Two kinds of changes land here, and they have
different requirements.

**Adding or modifying a tested-model row** (incremental — most common case):

1. Update the relevant table in [In Scope (MVP)](#in-scope-mvp) with the new row.
2. Replace the placeholder row (`_None tested yet — first entry lands in feature 002+_`) the
   first time a category gains its first real entry.
3. Add or update an integration test that exercises the device. A row without a test is
   incomplete (rule 1 above).
4. If a model is removed because it failed verification, leave a brief note in **Known
   caveats** rather than silently deleting the row — future contributors benefit from knowing
   what was tried.

**Changing the In-Scope or Out-of-Scope list itself** (out-of-band — rare):

This requires a **constitution amendment**, not a doc-only edit. The procedure is documented
in [`.specify/memory/constitution.md`](../.specify/memory/constitution.md) § Governance →
Amendment Procedure. A pull request that edits the In-Scope or Out-of-Scope categories of this
file without a parallel constitution amendment in the same PR is out of bounds and MUST be
rejected at review.

Foundation (feature `001-foundation`) deliberately leaves the tested-models tables empty.
First entries land in `002-terminal-pairing` and the hardware-driver features that follow it.

## Source of truth

This file reproduces constitution v1.7.0 § Hardware (scope originally established at v1.2.0;
Display row added at v1.7.0).
The authoritative source is [`.specify/memory/constitution.md`](../.specify/memory/constitution.md)
§ Hardware. If a contributor reads this file and finds it inconsistent with the constitution,
the constitution wins; the inconsistency is a defect in this file and MUST be fixed in the
same PR that surfaces it.
