# CLAUDE.md — karmyogi

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> Read this first, then `plan.md` for the original phased build plan and the
> still-relevant FUTURE specs (camera vision §7, machine abstraction §8).
> NOTE: `plan.md` is the *original* aspirational plan — the **"Current
> architecture (as built)"** section below is the authoritative map of what
> exists today; the app has grown well past plan.md's panel list.

## What this is

**karmyogi** is a browser-based, multipurpose control + CAD/CAM workbench for a
hobby/desktop **3-axis GRBL machine**. It started as CNC carving / engraving /
pen-plotting / auto-soldering / PCB and has grown into **~18 CAM "modes"**
(each a dockable panel): 2D/3D Carving, Writing, Signature, Soldering, Screw
Fitting, Bore/Drill/Hole, PCB, Glue Dispense, Pick & Place, 3D Printing (FDM
slicer), Laser Cutting, Welding, Spring Coiling, Camera/vision, plus an **AI
G-code** assistant. It runs entirely in the browser, talks to the machine over
USB **Web Serial** (also BLE / WebSocket / a mock transport), visualizes
toolpaths and the bed in **3D**, and presents a fully **dockable / floatable /
resizable** panel UI. It is now also a real **SaaS**: Firebase auth/login, an
admin dashboard, i18n + per-locale SEO, gamepad control, and a PWA self-updater.

It is the **web successor** to the Qt/C++ desktop fork `hjLabs.in_Candle`.
Intended to be hosted as a static SaaS at a subdomain, e.g. `karmyogi.hjlabs.in`.

## Why it exists (and the relationship to the Qt app)

The Qt/C++ app at `/home/hemang/Documents/GitHub/hjLabs.in_Candle` is the
**reference implementation**: it has a complete, working, unit-tested CAD/CAM
core and the full feature set, but Qt Widgets made a modern dockable/resizable
UI painful and hard to iterate on. karmyogi reimplements the **frontend** in
web tech (docking/resizing are trivial and battle-tested there, 3D is nicer, and
hosting is a static build) and **ports the CAD/CAM core algorithms from C++ to
TypeScript**. Treat the Qt code as the spec, not as something to run.

### Reference C++ to port (in the Qt repo `src/cadcam/`)
| C++ file | What to port to TS |
|---|---|
| `geometry.{h,cpp}` | Point/BBox/Polyline, arc + DXF-bulge flattening, signed area/orientation, point-in-polygon, distance helpers |
| `entity.{h,cpp}` | `Entity` (Line/Arc/Circle/Polyline) + `Drawing` document; `flatten()` |
| `toolpath.{h,cpp}` | `Tool`, `ToolpathMove` (Rapid/Feed/Plunge), `Toolpath` |
| `gcodeemitter.{h,cpp}` | Safe G-code: G21/G90/G94/G17, guaranteed safe-Z, **Spindle vs Pen Z mode**, no `-0.000`, modal axis/feed words |
| `dxfimporter.{h,cpp}` | ASCII DXF: LINE/CIRCLE/ARC/LWPOLYLINE/POLYLINE (+ bulges) |
| `offset.{h,cpp}` | polygon offset + concentric inset rings (in TS use a robust clipping lib — see below) |
| `camoperations.{h,cpp}` | engrave / profile (on/inside/outside) / pocket, multi-depth |
| `soldering.{h,cpp}` | auto-soldering points → G-code; spindle output repurposed as **solder-wire feeder** (M3/G4/M5); per-point Free-Z (travel) + Touch-Z (touch-down), feed type (pre-solder / touch-down), feed-time |
| `strokefont.{h,cpp}` | single-stroke (Hershey-simplex) vector font + text layout; loads custom-font JSON |
| `gerberimporter / excellonimporter / pcbcam` | Gerber RS-274X + Excellon → isolation routing / drilling / board cutout |

UI/feature reference: `src/candle/cam/*widget.{h,cpp}` (the CAD/CAM, Soldering,
Writing, PCB, Motion panels) and `src/candle/frmmain.cpp` (controller, jog,
status, sender). The Qt repo also has `tools/handwriting/` — a python3.13
pipeline that turns a photographed template into a custom single-stroke font
JSON (consumed by the Writing mode); keep using it as-is.

A copy of the key reference files lives in `reference/` (`cadcam/`, `cam/`,
`handwriting/`) for offline lookup — **on this machine that is the source of
truth**, since the original Qt repo path (`/home/hemang/...`) is a Linux path
that does not exist here.

### UI/UX inspiration: cncjs (DESIGN/LOOKS reference only)
[**cncjs**](https://github.com/cncjs/cncjs) is a **visual design reference only** — we do
**not** fork it or adopt its architecture (it's a Node server + socket.io + node-serialport
+ React 15/Redux app; the opposite of our browser-only Web Serial static SPA). We take
*how it looks* (layout, spacing, iconography, widget grouping) and reimplement in our own
stack; if we already do something better, we keep ours. cncjs is **MIT-licensed**, so its
**local asset files (icons/button graphics) may be reused with attribution** once installed.
Borrow its widget information-architecture for our panels: per-axis **DRO** (work + machine
pos, zero/go-to-zero), **jog pad** with step size, **connection** + **status**
(state/feed/spindle/buffer), **console + MDI + macros**, **spindle** + **Z-probe**,
**feed/rapid/spindle override** controls, and 3D tool-path visualization. cncjs also ships a
dedicated responsive view for screens **<720px**, validating our desktop⇄mobile requirement.

## Tech stack (decided)

- **Vite + TypeScript** (strict).
- **React** + **three.js** via **@react-three/fiber** (+ **drei**) for the 3D viewport.
- **dockview** for the dockable/floatable/resizable panel layout (this is the piece
  that was painful in Qt — it is a built-in feature here).
- **Web Serial API** (`navigator.serial`) for GRBL USB comms.
- **zustand** for state (machine state, program, settings, layout/theme).
- Styling: start with CSS variables + a small utility layer (Tailwind optional — decide in Phase 0).
- Testing: **NO unit tests — ever.** Verify *everything* visually in the real browser
  with **Playwright** + screenshots (see closed-loop below). No vitest, no test files.
- Output: static SPA → host on **Cloudflare Pages / R2**.

## Hard constraints / platform notes (know these)

- **Web Serial is Chromium-only** (Chrome/Edge/Opera/Brave; NOT Firefox/Safari) and
  requires **HTTPS or `localhost`** plus a **user gesture** to pick the port.
- GRBL streaming is line-based with flow control; browser latency is fine. Use the
  character-counting protocol (track GRBL's 127-byte RX buffer) for throughput, or
  simple send-then-wait-for-`ok` to start.
- Realtime bytes: `?` (status), `!` (feed hold), `~` (resume), `0x18` (soft reset).
- Provide a **mock serial device** so the whole app is developable/testable without
  hardware (and so Playwright e2e can run headless in CI).

## Safety (generated G-code)

Always emit `G21 G90 G94 G17`, a guaranteed **safe-Z retract** before any XY
travel and at program end, conservative default feeds, and explicit spindle/pen
handling. The machine doubles as a **pen plotter and a solder-wire feeder**, so Z
semantics and the spindle output are **mode-configurable** (Spindle / Pen /
Feeder). Port the emitter's safety behavior exactly from `gcodeemitter.cpp`.

## Responsive UI (REQUIRED — desktop AND mobile, one mental model)

Every page/panel/UI **must** be fully usable at both **desktop** and **mobile/phone**
sizes, and switching between the desktop and mobile versions (and back) must have the
**least possible learning curve** — same controls, labels, and mental model on both,
not two divergent UIs.

- The **dockview** docking shell is desktop-oriented. At narrow/mobile widths the app
  shell falls back to a **mobile layout** (single-column / stacked or a tabbed panel
  switcher) that shows the *same panel content* — only the arrangement changes.
- Use fluid CSS (flex/grid, `clamp()`, media/container queries). Avoid fixed pixel
  widths that break small screens. Touch targets ≥ ~36px; jog pads, number fields, and
  tables (Controller / Soldering / PCB) must be touch-usable and reflow on mobile.
- Verify in the closed loop at **multiple viewport sizes** (desktop + a phone preset)
  via Playwright.

## Closed-loop development (REQUIRED — this is how we work)

Develop in a **closed loop**: change → run the dev server → drive the **real
browser with Playwright** (click / drag / resize / type) → screenshot → *look at
the screenshot* → judge → iterate. Do **not** make many blind changes.

This is now fully automatable (the Playwright MCP tools can open `localhost`,
interact, and screenshot) — unlike the Qt app, where synthetic mouse drags never
triggered the dock splitters and made resize work un-verifiable. Web fixes the
verification loop too.

- **No unit tests.** Verify ALL logic (core CAM/G-code, serial, UI) by exercising it
  through the running app and Playwright — drive it, screenshot, *look*, judge.
- UI: Playwright against the Vite dev server; verify docking/resizing/drag + the
  desktop⇄mobile layouts visually. Typecheck with `tsc --noEmit` (not a test, just types).

## Parallel-agent development

This project is structured for **parallel agents** (see `plan.md`). The golden
rule learned from the Qt work: **parallel agents must own disjoint file sets** —
never let two agents edit the same file at once. `plan.md` assigns each workstream
an explicit `Owns:` directory/file list and a `Depends on:` list, and groups them
into "parallel batches" that can run concurrently. The orchestrator integrates
shared wiring (the app shell / dockview registry) between batches.

## Current architecture (as built) — authoritative map

Three independent pillars + a shell, exactly as `plan.md` intended, but much wider:

- **`src/core/` — pure TS CAD/CAM core (NO React/DOM/three).** The ported Qt
  algorithms (`geometry`, `entity`, `toolpath` via `cam.ts`, `gcodeEmitter`,
  `offset`, `dxf`, `gerber`/`excellon`/`pcbCam`, `soldering`, `centerline`/
  `outlineFont`/`fontLibrary`/`hersheyData`) **plus** many newer generators:
  `slicer` (FDM), `laser`/`laserCam`/`laserImage`, `springCoiling`, `screwDriving`,
  `drilling`, `cutout`, `glue`, `pickPlace`, `nesting`, `heightmap`, `carve3d`,
  `meshImport` (STL/STEP via occt-import-js), `simulation`, `materials`/`stock`,
  `cameraCalib` (homography/DLT), `aiGcode`. Heavy ones run in **Web Workers**
  (`carve3d.worker.ts`, `slicer.worker.ts`). Keep this dir UI-independent.
- **`src/serial/` — transport + GRBL controller (NO UI).** `controller.ts` is the
  service the app talks to; it delegates over a **pluggable transport**: `usbPort`
  (Web Serial), `blePort` (Web Bluetooth), `wsPort` (WebSocket), `mockPort` (no
  hardware). `streamer`/`status`/`realtime`/`settings` implement GRBL streaming;
  `dialect.ts` + `store/machineProfile.ts` are the start of the §8 multi-controller
  abstraction (GRBL is the default).
- **`src/viewer/` — three.js / @react-three/fiber scene (no business logic).**
  `Viewer.tsx` + bed/toolpath/tool-marker/stock/job/placement-gizmo, the live
  `CameraBedPlane` overlay (§7.9), per-mode scenes (`SolderScene`, `SpringScene`),
  and `gcodeToPolylines`.
- **`src/panels/` — one dockview panel per file (UI only; calls core+store+serial).**
  ~18 mode panels + Controller/Console/Program/Visualizer/Motion/Probe.
- **`src/store/` — zustand slices** (one file per concern; ~30 of them). The barrel
  `store/index.ts` is **orchestrator-owned** — re-exports each slice. `persist.ts`
  is the localStorage persistence helper used across slices.
- **`src/app/` — the shell** (`shell.tsx`, `App.tsx`, dockview wiring) +
  **`panelRegistry.ts`** (orchestrator-owned). Every panel is `React.lazy()`-loaded
  and wrapped in its own `<ErrorBoundary>` + `<Suspense>`, so unopened modes stay
  out of the entry chunk and one panel crashing (bad DXF/STL/Gerber, WebGL/WASM
  failure) never white-screens the SPA. `MobileShell.tsx` is the narrow-width
  fallback. **To add a panel, edit `panelRegistry.ts`** in three places: `lazyPanels`,
  `availablePanels`/`TAB_TITLES`, and the `tab.*` i18n call site `TAB_TITLE_KEYS`.
- **Cross-cutting:** `src/auth/` (Firebase login, Google One-Tap, grace gate),
  `src/admin/` (admin dashboard), `src/camera/` (calibration/tracking/recorder),
  `src/i18n/` (translations + per-tab titles), `src/pwa/` (self-update manager that
  defers reload while a job is streaming). Vendor code-split into `vendor-three`,
  `vendor-firebase`, `vendor-occt`, `vendor-clipping`, etc. (see `vite.config.ts`).

### i18n is mandatory
User-facing strings go through `t('some.key', 'English fallback')` from `src/i18n`.
The extractor (`npm run i18n:check`, `scripts/i18n-check.mjs`) statically scans for
those literal calls — so the **key and English fallback must be string literals**,
not variables. It skips `src/i18n/` itself; that's why tab-title `t()` call sites
live in `src/app/panelRegistry.ts`.

## Build / run / host

```bash
npm install
npm run dev          # Vite dev server on localhost:5185 (Web Serial + camera work on localhost)
npm run build        # tsc --noEmit && vite build -> dist/ static files
npm run preview      # serve the built app
npm run typecheck    # tsc --noEmit (types only — there are NO unit tests; verify via Playwright)
npm run i18n:check   # static-extract t('key','English') calls; flag missing/orphan locale keys
# deploy: push dist/ to Cloudflare Pages (see docs/deploy.md). HTTPS is automatic.

# Camera (getUserMedia) and Web Serial need a SECURE CONTEXT. localhost is secure;
# plain http://<lan-ip> is NOT. To use the camera/Serial from another LAN device:
HTTPS=1 npm run dev -- --host 0.0.0.0   # then open https://<lan-ip>:5185, accept the self-signed cert
```

Dev-only Vite plugins (in `vite.config.ts`, all plain `.mjs`, kept out of the app
tsconfig): `vite-camera-plugin` (receives camera frames), `vite-machine-plugin`
(a **machine bridge** relaying this browser's GRBL machine to the server so an
agent can read live state / queue commands), `vite-i18n-seo` (build-only: emits a
crawlable `/<locale>/` page per language + hreflang + sitemap). `build-info.json`
is emitted at the dist root for the in-app PWA staleness check.

## Conventions / guardrails

- Keep the **CAD/CAM core (`src/core/`) UI-independent and pure** — no React/DOM
  imports — so it stays portable and mirrors the Qt `cadcam` lib structure.
- TypeScript strict; one concern per file; small modules.
- Never block the UI thread on serial I/O; use async streams / a worker if needed.
- Keep generated G-code safe (see Safety above).
- Update this file and `plan.md` as the architecture solidifies.

## Status

The original phased build (Phase 0 → Batch A–D from `plan.md`) is **complete and
shipped**: scaffold, GRBL serial + mock, pure CAD/CAM core, 3D viewer, the core
panels (Controller/Console/Coordinates/Program/Visualizer), the Motion/`$`-settings
editor, the first CAM modes (Carving/Writing/Soldering/PCB), and Batch-D polish
(global zoom, layout/theme persistence, PWA/offline, Cloudflare deploy).

Built since (beyond the original plan):
- **Many more CAM modes:** 3D Printing (FDM slicer), Laser Cutting, Welding,
  Spring Coiling, Screw Fitting, Bore/Drill/Hole, Glue Dispense, Pick & Place,
  Signature, AI G-code assistant. STL/STEP import (occt-import-js) + 3D carving.
- **More transports:** BLE + WebSocket alongside USB Web Serial and the mock; the
  start of the multi-controller abstraction (`dialect.ts` + `machineProfile`).
- **Camera/vision:** calibration sheet, homography bed-tracking, live camera→3D
  bed overlay, recorder (§7.9 of `plan.md` partly landed; full auto-setup parked).
- **SaaS + polish:** Firebase auth/login, admin dashboard, i18n + per-locale SEO,
  gamepad control (rebind UI, 3D model, diagnostic), PWA self-update manager.

Still **parked** (specs live in `plan.md`): full one-button camera "auto-setup &
carve" (§7), the digital-twin machine model (§7.10), and the broader controller /
machine-type / axis-layout abstraction (§8).

Everything verified in the browser via Playwright; `tsc --noEmit` clean. No unit
tests by design.
