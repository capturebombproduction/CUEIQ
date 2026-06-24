# CueIQ Desktop — Plan (Electron + Vite SPA)

> Decided 2026-06-25 with พี่: the server-rendered web app is the wrong substrate for
> a show that must run OFFLINE on stage (SW gymnastics stayed fragile). Build an
> INSTALLABLE desktop app (Windows + Mac) that looks identical, boots offline 100%
> from on-disk assets, and SYNCS with the existing app automatically (same Supabase
> + R2). This is NOT a from-scratch rewrite — it reuses the UI, theme, lib, audio
> engine, and IndexedDB stores. The web app stays as-is for online management.

## Why desktop (not mobile / not native rewrite)
- Stage audio devices are usually laptops → desktop fits the real workflow.
- No App Store / iOS quirks; distribute an .exe / .dmg directly to the label.
- Electron bundles the built SPA → it loads from local files → **boots offline with
  zero service-worker dependency** (kills the whole class of bugs we hit).
- A React Native / Flutter rewrite would throw away the working UI + Web Audio engine
  for no extra benefit here.

## Stack (locked)
- **Electron** — one Chromium engine on Win + Mac → consistent Web Audio (zero-tolerance
  audio), mature, easy electron-builder distribution. (Tauri's per-OS webviews risked
  audio divergence.)
- **Vite + React + TypeScript SPA** as the renderer — client-rendered (no server render
  to fail offline), fast, simple static build for Electron to load.
- **Same Supabase (auth/data) + R2 (audio)** → desktop and web share one backend, so
  "sync with the old app" is automatic: edit on desktop → web sees it (realtime), and
  vice-versa. No custom sync protocol for the online path.
- **Local-first**: reuse the IndexedDB stores (song-cache / audio-store / event-store /
  show-run-outbox) + deviceId. Offline reads local; reconnect replays the outbox; the
  existing realtime broadcast triggers other devices.

## Reuse map (what carries over verbatim / near-verbatim)
- Theme: `app/globals.css` (CSS vars) + `tailwind.config.ts` → copied into desktop = identical look.
- UI: `components/ui/*` (Button/Input/Card/Badge/...) — pure, reused via `@` alias.
- Logic/lib: `lib/supabase/client.ts`, `lib/username`, `lib/utils`, `lib/types`,
  `lib/time`, `lib/permissions`, audio (`lib/audio-*`, `lib/song-cache`, `lib/audio-store`),
  `lib/event-store`, `lib/show-run-outbox`, `lib/device-id`, `lib/show-readiness`,
  `lib/show-authority`, `lib/bpm-detect`, metronome.
- Big client component `components/event/live-mode.tsx` — already prop-driven; drives the Show Runner.
- The offline-first work (readiness preflight, outbox, authority, status strip) all carries over.

## Porting cost (the real work)
- `next/navigation` (useRouter/usePathname/useParams) → react-router equivalents (shim or adapt).
- `next/link` → react-router `Link` (or `<a>`). `next/dynamic` → `React.lazy`. `next/font` → bundled `@fontsource/kanit` (offline).
- Server Components (`app/**/page.tsx` doing `await getEventBundle`) → client pages that fetch
  via the browser Supabase client, mirroring `lib/queries` (RLS works the same with the user's session).
- `lib/supabase/server`, server actions, `app/api/*` → client calls / a thin presign helper
  (R2 presign currently a route handler → reuse the same endpoint on the web origin, or move into the app).

## Milestones
- **M1 (scaffold + login):** `desktop/` Vite SPA, theme + UI reused, client Supabase auth, an
  authed placeholder. Verifiable in a browser (`vite dev`). ← current
- **M2 (shell + read pages):** react-router shell (header/nav), dashboard, event page — client
  data fetch mirroring `lib/queries`, reusing components. Local-first reads.
- **M3 (Show Runner):** port `live-mode` + audio + IndexedDB; offline run end-to-end; sync on reconnect.
- **M4 (Electron):** main + preload load the built SPA from disk (offline boot, no SW);
  electron-builder → Win `.exe` + Mac `.dmg`; optional auto-update.
- **M5 (polish):** offline-first niceties carry over; 2-device + airplane verification.

## Layout
- Lives in `desktop/` in this repo (own package.json + deps; Vercel ignores it — root build only).
- `desktop/node_modules` + `desktop/dist` + `desktop/dist-electron` gitignored.
- Supabase URL + anon key are PUBLIC (NEXT_PUBLIC_*) → embedded in the build (fine; same as web).
