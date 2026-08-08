"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  ChevronDown,
  ChevronUp,
  Loader2,
  Download,
  ShieldCheck,
  HardDrive,
  BatteryMedium,
  Speaker,
  Wifi,
  WifiOff,
  ListChecks,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { loadAudioSink } from "@/components/event/audio-output-picker";
import { prefetchEventAudio, type PrefetchTarget } from "@/lib/audio-prefetch";
import { listLocalSourceIds } from "@/lib/local-source";
import { MGMT_OUTBOX_EVENT } from "@/lib/mgmt-outbox";
import type { LocalOnlyCandidate } from "@/lib/audio-targets";
import {
  getShowReadiness,
  requestPersist,
  formatBytes,
  describeSilentRows,
  type ShowReadiness,
  type ShowSetlistRow,
} from "@/lib/show-readiness";

type RowTone = "ok" | "warn" | "bad" | "muted";

// Warn when free space drops under this — a full WAV master can be ~30–90 MB and a
// device that can't fit the next download could fail mid-prep.
const LOW_SPACE_BYTES = 500 * 1024 * 1024; // 500 MB
const LOW_BATTERY = 0.3; // 30%

// ─── Dependencies that survive a re-render ───────────────────────────────────
//
// `refresh` below is a useCallback that starts a full readiness pass, and its
// dependency list is built from this component's ARRAY props. Array IDENTITY is
// the wrong key for that job, in two directions:
//
//  • A DEFAULT PARAMETER re-runs on every render. `localOnly = []` handed refresh
//    a new array every render → a new refresh identity every render → the mount
//    effect's [refresh] dep re-fired every render → refresh() resolved and setR'd
//    a fresh object → render. Unbounded, with React logging "Maximum update depth
//    exceeded", each pass reopening IndexedDB and cursor-walking the event's audio
//    cache — on the card an operator stares at immediately before cutting the
//    wifi. It was latent only because the one caller (desktop/src/pages/live.tsx)
//    happens to pass the prop; correctness must not depend on an OPTIONAL prop
//    being passed.
//  • An INLINE LITERAL from a parent that re-renders costs the same, once per
//    parent render, forever — the hazard a future caller walks into.
//
// So the props are keyed on their CONTENT and the previous array is handed back
// whenever the content has not changed. Every dep list downstream then keys on a
// value that moves only when the answer could.
//
// ⚠️ THE TWO GUARDS ARE NOT EQUALS — do not read them as symmetric, because the
// suite does not. Measured on the "must settle, not spin" block:
//
//   useStableByContent removed, frozen default kept  → 1 test RED (11 passes)
//   frozen default removed (`= []`), stabiliser kept → ALL 8 GREEN
//   both removed                                     → 3 RED (22, 22, 11 passes)
//
// So useStableByContent is the LOAD-BEARING guard: it subsumes the frozen default
// completely, because a fresh `[]` per render still hashes to the same signature
// and gets the held array back. NO_LOCAL_ONLY is the BELT — it stops the omitted-
// prop case from allocating at all, and it keeps the source honest about the
// original bug. A "simplifier" who deletes useStableByContent and sees 7/8 green
// has been told; one who deletes the constant and sees 8/8 green has not, which is
// why test/web/show-readiness-frozen-default.test.ts pins the constant STRUCTURALLY
// instead of leaving that claim to this comment. `localOnly = []` in the parameter
// list is not a tidier spelling of the constant: it is the original bug verbatim,
// because a default expression is re-evaluated on EVERY render — today only the
// stabiliser stands behind it.
//
// (An older note here cited "219 readiness passes in 300ms". That came from a
// wall-clock probe that is NOT in the suite; the numbers above are what the
// shipped, microtask-driven test actually counts. Quote those.)
const NO_LOCAL_ONLY: readonly LocalOnlyCandidate[] = Object.freeze([]);
// Field and record separators, so a title containing a comma cannot forge a
// different set of rows into the same signature.
const FS = "\u001f";
const RS = "\u001e";
// An OMITTED setlist is not an empty one — "not checked" versus "checked, clean"
// is the entire point of `silent` — so the two must never share a signature.
const NO_SETLIST = "\u0000absent";

/**
 * Returns the value it was last given for this signature, so equal content keeps
 * one stable identity. A ref written during render, holding only a value derived
 * from this render's props: no effect, no extra render, nothing to tear.
 */
function useStableByContent<T>(value: T, signature: string): T {
  const held = useRef({ signature, value });
  if (held.current.signature !== signature) held.current = { signature, value };
  return held.current.value;
}

function ToneIcon({ tone }: { tone: RowTone }) {
  if (tone === "ok") return <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />;
  if (tone === "warn") return <AlertTriangle className="h-4 w-4 text-amber-500" />;
  if (tone === "bad") return <XCircle className="h-4 w-4 text-destructive" />;
  return <span className="h-4 w-4" />;
}

function Row({
  tone,
  icon,
  label,
  value,
  action,
}: {
  tone: RowTone;
  icon: React.ReactNode;
  label: string;
  value: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2.5 py-1.5 text-sm">
      <span className="text-muted-foreground">{icon}</span>
      <span className="text-foreground">{label}</span>
      <span
        className={cn(
          "ml-auto inline-flex items-center gap-1.5 tabular-nums",
          tone === "ok" && "text-green-700 dark:text-green-400",
          tone === "warn" && "text-amber-600 dark:text-amber-400",
          tone === "bad" && "text-destructive",
          tone === "muted" && "text-muted-foreground"
        )}
      >
        {value}
        <ToneIcon tone={tone} />
      </span>
      {action}
    </div>
  );
}

/**
 * Show Readiness Check — the preflight an operator runs before "เริ่มโชว์", so a
 * device is provably ready to run the set OFFLINE (the offline-first foundation:
 * audio must be on-device and pinned before net even matters). One green/red
 * checklist: songs cached at the current version · storage pinned (won't be
 * evicted) · free space · battery · network. Inline actions fix the common gaps
 * (prep the device, pin storage) without leaving the page.
 *
 * Collapses to a one-line verdict when all-clear; auto-expands when something
 * blocks an offline run (missing/outdated audio).
 */
export function ShowReadinessCheck({
  eventId,
  targets: targetsProp,
  // NOT `= []`. See NO_LOCAL_ONLY above: a default parameter is re-evaluated on
  // every render, and this one used to put the whole card into an unbounded
  // render/refresh loop the moment a caller left the prop off. useStableByContent
  // now catches that case too — this constant is the belt, not the brace.
  localOnly: localOnlyProp = NO_LOCAL_ONLY,
  setlist: setlistProp,
}: {
  eventId: string;
  targets: PrefetchTarget[];
  /**
   * Rows linked to a song with no online master (lib/audio-targets.ts). They are
   * not prefetch targets — there is nothing to download — but they are not nothing
   * either: either this device holds the file (⭐#1 step 7) or that row goes SILENT
   * on stage. Before this, they were invisible here, so a set with a fileless song
   * reported a clean green "พร้อมโชว์ออฟไลน์".
   */
  localOnly?: readonly LocalOnlyCandidate[];
  /**
   * The event's setlist rows, so the preflight can reconcile them against what the
   * resolvers actually claimed (lib/show-readiness.ts `silent`). REQUIRED for that
   * check to run at all: round 10 built the whole guard and then left this prop
   * unpassed, so `silent` was hard-wired to [] on every real call and the green lie
   * shipped unchanged. Omit it and you get the old, blinder behaviour.
   */
  setlist?: readonly ShowSetlistRow[];
}) {
  // Content-keyed, identity-stable views of the three array props. Used from here
  // down INSTEAD of the raw props — including in plain render code, so there is
  // exactly one name per prop and no way to reach for the unstable one by habit.
  const targets = useStableByContent(
    targetsProp,
    targetsProp.map((t) => [t.itemId, t.path, t.name].join(FS)).join(RS)
  );
  const localOnly = useStableByContent(
    localOnlyProp,
    localOnlyProp.map((c) => [c.itemId, c.songId, c.name].join(FS)).join(RS)
  );
  const setlist = useStableByContent(
    setlistProp,
    setlistProp
      ? // EVERY field of the row, including `song_id`, which lib/show-readiness.ts
        // does not currently read. A signature that covers only today's readers is
        // a trap: the day someone reads one more field, equal-signature-but-changed
        // rows would be silently held back with no failing test to say so.
        setlistProp
          .map((row) => [row.id, row.kind, row.title ?? "", row.song_id ?? ""].join(FS))
          .join(RS)
      : NO_SETLIST
  );

  const [r, setR] = useState<ShowReadiness | null>(null);
  const [open, setOpen] = useState(false);
  const userToggled = useRef(false); // once the user opens/closes, stop auto-driving it
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [pinBusy, setPinBusy] = useState(false);
  // "หยุด" aborts the transfer in flight (not just between files) — on a
  // black-holed venue network the current download would otherwise never settle.
  const abortRef = useRef<AbortController | null>(null);
  // Desktop-only extras (the standalone show machine): which output the show
  // audio is pinned to, and whether this event's data is cached for an offline
  // cold boot. Both stay null on the web build → the rows never render there.
  const isDesktop =
    typeof window !== "undefined" &&
    !!(window as { cueiqNative?: unknown }).cueiqNative;
  const [sink, setSink] = useState<{ label: string; missing: boolean } | null>(null);
  const [offlineData, setOfflineData] = useState<boolean | null>(null);

  useEffect(() => {
    if (!isDesktop) return;
    let alive = true;
    const check = async () => {
      // same key the desktop read-cache writes (desktop/src/data/cache.ts)
      try {
        setOfflineData(localStorage.getItem(`cueiq:cache:event:${eventId}`) != null);
      } catch {
        setOfflineData(null);
      }
      const saved = loadAudioSink();
      if (!saved) {
        if (alive) setSink({ label: "ลำโพงเริ่มต้นของระบบ", missing: false });
        return;
      }
      try {
        const all = await navigator.mediaDevices.enumerateDevices();
        const dev = all.find((d) => d.kind === "audiooutput" && d.deviceId === saved);
        if (alive)
          setSink(
            dev
              ? { label: dev.label || "อุปกรณ์เสียงที่เลือกไว้", missing: false }
              : { label: "อุปกรณ์ที่เลือกไว้ไม่ได้เสียบอยู่", missing: true }
          );
      } catch {
        if (alive) setSink(null);
      }
    };
    check();
    navigator.mediaDevices?.addEventListener?.("devicechange", check);
    return () => {
      alive = false;
      navigator.mediaDevices?.removeEventListener?.("devicechange", check);
    };
  }, [isDesktop, eventId]);

  // Of the master-less rows, how many does THIS device actually hold bytes for?
  // The rest have no audio anywhere and will be silent — the one thing this
  // preflight exists to say out loud.
  const [heldLocally, setHeldLocally] = useState<Set<string>>(new Set());

  const refresh = useCallback(() => {
    // `alsoAccounted` = the local-only candidates. They are NOT download targets but
    // they are accounted for (the row resolved to a song; whether this device holds
    // the bytes is the separate noFileAtAll check below), so without them every
    // master-less row would be double-reported as silent.
    getShowReadiness(eventId, targets, {
      setlist,
      alsoAccounted: localOnly.map((c) => c.itemId),
    })
      .then(setR)
      .catch(() => {});
    if (localOnly.length > 0) {
      listLocalSourceIds()
        // UNION, never replace. A successful flush uploads the file and then
        // CLEARS the local override, so a plain replace would drop the song out
        // of "held here" and re-file it under "no file anywhere" — flipping the
        // preflight to red for the one song that just got fixed, because
        // `localOnly` is a snapshot of the bundle and cannot know the master
        // landed. Bytes here OR bytes we promoted both mean playable.
        .then((ids) => setHeldLocally((prev) => new Set([...prev, ...ids])))
        .catch(() => {});
    }
    // These three are the CONTENT-KEYED views from the top of the component, not
    // the raw props. That is what makes this dependency list safe: it changes when
    // the set of songs changes and at no other time — not when a default parameter
    // re-allocates, not when a parent re-renders with an equal inline literal, and
    // above all not on this component's own setR, which is the cycle that turned
    // this callback into an unbounded loop. Never swap them back for the props.
  }, [eventId, targets, localOnly, setlist]);

  useEffect(() => {
    refresh();
    const onVisible = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", refresh);
    window.addEventListener("offline", refresh);
    // a file picked in the Library changes this answer without a reload
    window.addEventListener(MGMT_OUTBOX_EVENT, refresh);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", refresh);
      window.removeEventListener("offline", refresh);
      window.removeEventListener(MGMT_OUTBOX_EVENT, refresh);
    };
  }, [refresh]);

  // Auto-open the first time something is actually wrong — but never override a
  // choice the user already made. Keyed on BOTH failure halves: this used to live
  // inside the readiness callback, which only ever saw the download counts, so a
  // set whose ONLY problem was a song with no file at all stayed collapsed —
  // hiding the very row that names those songs.
  //
  // `silentCount` is deliberately NOT in here (wave-2 repair). Auto-open exists for
  // states with an ACTION: needCount has เตรียม, missingFileCount has "put a file on
  // that song". A silent row may be a band that plays that song live, and there is
  // no button anywhere that clears it — so keying auto-open on it re-opened the
  // panel on every single mount, forever, on a perfectly healthy live_band show.
  // (`userToggled` is a ref, reset per mount, so it could not even be dismissed.)
  const needCount = r ? r.audio.stale + r.audio.missing : 0;
  const missingFileCount = localOnly.filter((c) => !heldLocally.has(c.songId)).length;
  // Rows that resolved to nothing at all. Only meaningful when `setlist` was passed:
  // with the prop omitted this is [] meaning "not checked", never "checked and clean".
  const silentCount = r?.silent.length ?? 0;
  useEffect(() => {
    if (!r || userToggled.current) return;
    setOpen(needCount > 0 || missingFileCount > 0);
  }, [r, needCount, missingFileCount]);

  const prepare = useCallback(async () => {
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy(true);
    try {
      await prefetchEventAudio(eventId, targets, {
        onProgress: (p) => setProgress({ done: p.done, total: p.total }),
        isCancelled: () => ac.signal.aborted,
        signal: ac.signal,
      });
    } finally {
      // Leave the busy state however the prepare ended (cancel, timeout, throw):
      // a spinner that never clears dead-locks "เตรียม" — and with it the only way
      // to get the show's audio onto this device — for the rest of the session.
      abortRef.current = null;
      setProgress(null);
      setBusy(false);
      refresh();
    }
  }, [eventId, targets, refresh]);

  // Left the Show Runner while เตรียมเพลง was still running: nothing is watching
  // the progress any more, so stop the transfer instead of leaving its fetch,
  // stall timer and retry backoff alive behind the unmounted screen.
  useEffect(() => () => abortRef.current?.abort(), []);

  const pin = useCallback(async () => {
    setPinBusy(true);
    await requestPersist();
    setPinBusy(false);
    refresh();
  }, [refresh]);

  // No audio in this event → nothing to preflight (e.g. an MC-only run). The silent
  // count has to be part of this: a set whose song rows ALL lost their audio has no
  // targets and no local-only candidates either, so the old condition removed the
  // card entirely — the operator saw no mention of those rows at all, only the
  // absence of a control they may never have noticed was there. The card now shows
  // up collapsed and calm in that state (it is also where the storage-pin, battery
  // and audio-output rows live, which are worth having on the Show Runner anyway).
  if (targets.length === 0 && localOnly.length === 0 && silentCount === 0) return null;
  if (!r) return null;

  // Master-less rows split in two: bytes on this device (playable) vs no audio
  // anywhere (silent on stage). Only the second kind is a problem, and no amount
  // of "เตรียม" fixes it — somebody has to put a file on the song. Counted per
  // SONG, not per row: the same song can sit in a setlist twice and it is one
  // file either way.
  const bySong = (cs: LocalOnlyCandidate[]) => {
    const seen = new Map<string, LocalOnlyCandidate>();
    for (const c of cs) if (!seen.has(c.songId)) seen.set(c.songId, c);
    return [...seen.values()];
  };
  const localReady = bySong(localOnly.filter((c) => heldLocally.has(c.songId)));
  const noFileAtAll = bySong(localOnly.filter((c) => !heldLocally.has(c.songId)));
  const audioReady =
    // "there is something playable" — or every row that could have carried audio is
    // already named in the silent list below, in which case the download counts have
    // nothing left to say and a red "เพลงยังไม่ครบในเครื่อง" would point the operator
    // at a เตรียม button with nothing to fetch.
    (r.audio.total + localReady.length > 0 || r.silent.length > 0) &&
    needCount === 0 &&
    noFileAtAll.length === 0;

  // Critical = audio not all on-device at the current version (blocks offline run).
  // Warnings = won't stop the show but worth fixing: storage not pinned, low space,
  // low battery. Network being offline is EXPECTED for a standalone show → info only.
  const lowSpace = r.storage.free != null && r.storage.free < LOW_SPACE_BYTES;
  const notPinned = r.storage.persisted === false;
  const lowBattery =
    r.battery.supported &&
    r.battery.level != null &&
    r.battery.level < LOW_BATTERY &&
    !r.battery.charging;
  // A silent row is NOT a warning. Round 10 argued correctly that a hard red would
  // be wrong here, then put `r.silent.length > 0` in `hasWarn` anyway, which is the
  // same guess one shade lighter — and the wave-2 review caught what that costs.
  //
  // The device cannot tell "this row's library song was deleted" from "the band
  // plays this one live and never wanted a file": ON DELETE SET NULL leaves the two
  // byte-identical (lib/completeness.ts makes the same argument about the same rows,
  // and lib/completeness.test.ts pins a hand-typed row as COMPLETE). A "+ เพลง" row
  // named by hand has song_id null and no audio_path — a first-class way to build a
  // setlist, and the whole of a live_band set. Amber here meant the Show Runner told
  // an operator their healthy show had five faults, every mount, with nothing to
  // press. An operator who learns to ignore this panel is exactly who will miss the
  // deleted-song case it was built for.
  //
  // What the guard actually has to kill is the CLAIM — the headline must never read
  // a bare "พร้อมโชว์ออฟไลน์" while a song row plays nothing. `verdictText` below
  // still appends the count ("มี N แถวที่ไม่มีไฟล์เสียง") whenever there is one, so
  // the bare string is unreachable then and that guard holds without this term
  // — and it composes with the caution wording instead of replacing it. The body still names the
  // rows. Stating the fact is honest; scoring it as a fault is a guess.
  const hasWarn =
    lowSpace ||
    notPinned ||
    lowBattery ||
    (sink?.missing ?? false) ||
    offlineData === false;

  const verdict: RowTone = !audioReady ? "bad" : hasWarn ? "warn" : "ok";
  const verdictText = noFileAtAll.length
    ? `ยังไม่พร้อม — มี ${noFileAtAll.length} เพลงที่ยังไม่มีไฟล์`
    : !audioReady
      ? "ยังไม่พร้อม — เพลงยังไม่ครบในเครื่อง"
      : // Two independent facts, COMPOSED — not one shadowing the other. The silent
        // count qualifies the headline without condemning it (the bare
        // "พร้อมโชว์ออฟไลน์" must not stand over a row that plays nothing, but a row
        // that plays nothing is normal for a band playing live). Checking it above
        // hasWarn instead made "มีข้อควรระวัง" unreachable on any set with a silent
        // row, so the amber header named the one thing it tells the operator to
        // ignore while the real warning — dead audio device, low battery, งานยังไม่
        // อยู่ในเครื่อง — went unnamed and the panel does not auto-open for those.
        `${
          hasWarn
            ? "พร้อมโชว์ (มีข้อควรระวัง)"
            : r.silent.length > 0
              ? "พร้อมโชว์"
              : "พร้อมโชว์ออฟไลน์"
        }${r.silent.length > 0 ? ` — มี ${r.silent.length} แถวที่ไม่มีไฟล์เสียง` : ""}`;

  const toggle = () => {
    userToggled.current = true;
    setOpen((o) => !o);
  };

  return (
    <div
      className={cn(
        "no-print rounded-lg border bg-card/40",
        verdict === "bad" && "border-destructive/40",
        verdict === "warn" && "border-amber-500/40"
      )}
    >
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
        aria-expanded={open}
      >
        <ListChecks className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="text-sm font-medium">ตรวจความพร้อมก่อนเริ่มโชว์</span>
        <span
          className={cn(
            "ml-auto inline-flex items-center gap-1.5 text-sm font-medium",
            verdict === "ok" && "text-green-700 dark:text-green-400",
            verdict === "warn" && "text-amber-600 dark:text-amber-400",
            verdict === "bad" && "text-destructive"
          )}
        >
          <ToneIcon tone={verdict} />
          {verdictText}
        </span>
        {open ? (
          <ChevronUp className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        )}
      </button>

      {open && (
        <div className="space-y-0.5 border-t px-3 py-2">
          <Row
            // A set that reaches here with no files at all is now possible (every
            // song row silent → no targets, no local-only). A green tick next to
            // "ไม่มีไฟล์เพลง" would be nonsense, so that state reads muted.
            tone={
              r.audio.total + localReady.length === 0
                ? "muted"
                : audioReady
                  ? "ok"
                  : needCount > 0
                    ? "bad"
                    : "muted"
            }
            icon={<Download className="h-4 w-4" />}
            label="เพลงในเครื่อง (เล่นได้แม้เน็ตหลุด)"
            value={
              r.audio.total > 0
                ? `${r.audio.ready}/${r.audio.total}`
                : localReady.length > 0
                  ? // no online master anywhere in this set, but the files are here
                    `${localReady.length} เพลงจากเครื่องนี้`
                  : "ไม่มีไฟล์เพลง"
            }
            action={
              needCount > 0 ? (
                busy ? (
                  <div className="ml-2 inline-flex items-center gap-2">
                    <Button size="sm" variant="outline" disabled>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      {progress?.done ?? 0}/{progress?.total ?? needCount}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => abortRef.current?.abort()}
                    >
                      หยุด
                    </Button>
                  </div>
                ) : (
                  <Button size="sm" variant="outline" className="ml-2" onClick={prepare}>
                    <Download className="h-3.5 w-3.5" /> เตรียม {needCount} เพลง
                  </Button>
                )
              ) : undefined
            }
          />

          {/* Rows whose song has no online master. Bytes held here = playable
              (⭐#1 step 7, an upload still queued from a venue with no wifi);
              anything else is a track that will be silent, and no "เตรียม" fixes
              it — the fix is to put a file on that song. */}
          {localReady.length > 0 && (
            <Row
              tone="ok"
              icon={<HardDrive className="h-4 w-4" />}
              label="ไฟล์ที่รออัปโหลด (เล่นได้จากเครื่องนี้)"
              value={`${localReady.length} เพลง`}
            />
          )}
          {noFileAtAll.length > 0 && (
            <Row
              tone="bad"
              icon={<XCircle className="h-4 w-4" />}
              label="เพลงที่ยังไม่มีไฟล์เลย (จะเงียบตอนโชว์)"
              value={noFileAtAll
                .slice(0, 3)
                .map((c) => c.name)
                .join(", ")
                .concat(noFileAtAll.length > 3 ? ` +${noFileAtAll.length - 3}` : "")}
            />
          )}

          {/* Rows the resolvers never claimed at all — no library link and no file
              of their own, so nothing downstream will play them. Sometimes a song
              deleted out from under the row (ON DELETE SET NULL keeps the row and its
              title), just as often a line the band typed in and intends to play live.
              Naming them is the point. MUTED and phrased as a question, not an
              accusation: this row wore tone="bad" + an XCircle for one round and put
              five red faults on a hand-typed live_band set. See the `hasWarn` comment
              above — nothing here can tell the two causes apart, so it must not
              pretend to. */}
          {r.silent.length > 0 && (
            <Row
              tone="muted"
              icon={<ListChecks className="h-4 w-4" />}
              label="แถวที่ไม่มีไฟล์เสียง — ถ้าเล่นสดไม่ต้องทำอะไร"
              value={describeSilentRows(r.silent)}
            />
          )}

          <Row
            tone={
              r.storage.persisted === true
                ? "ok"
                : r.storage.persisted === false
                  ? "warn"
                  : "muted"
            }
            icon={<ShieldCheck className="h-4 w-4" />}
            label="พื้นที่ถูกล็อก (กันเบราว์เซอร์ลบไฟล์เพลง)"
            value={
              r.storage.persisted === true
                ? "ล็อกแล้ว"
                : r.storage.persisted === false
                  ? "ยังไม่ล็อก"
                  : "ไม่ทราบ"
            }
            action={
              notPinned ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-2"
                  onClick={pin}
                  disabled={pinBusy}
                >
                  {pinBusy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ShieldCheck className="h-3.5 w-3.5" />
                  )}
                  ล็อกพื้นที่
                </Button>
              ) : undefined
            }
          />

          {r.storage.free != null && (
            <Row
              tone={lowSpace ? "warn" : "ok"}
              icon={<HardDrive className="h-4 w-4" />}
              label="พื้นที่ว่างในเครื่อง"
              value={formatBytes(r.storage.free)}
            />
          )}

          {r.battery.supported && r.battery.level != null && (
            <Row
              tone={lowBattery ? "warn" : "ok"}
              icon={<BatteryMedium className="h-4 w-4" />}
              label="แบตเตอรี่"
              value={`${Math.round(r.battery.level * 100)}%${r.battery.charging ? " · กำลังชาร์จ" : ""}`}
            />
          )}

          {/* desktop-only: where the show audio is routed (set in Live Mode) */}
          {sink && (
            <Row
              tone={sink.missing ? "warn" : "ok"}
              icon={<Speaker className="h-4 w-4" />}
              label="เสียงออกที่"
              value={sink.label}
            />
          )}

          {/* desktop-only: can this event cold-boot offline (data cached)? */}
          {offlineData != null && (
            <Row
              tone={offlineData ? "ok" : "warn"}
              icon={<HardDrive className="h-4 w-4" />}
              label="ข้อมูลงานในเครื่อง (เปิดแบบไม่มีเน็ตได้)"
              value={offlineData ? "พร้อม" : "เปิดงานนี้ตอนออนไลน์ 1 ครั้งก่อน"}
            />
          )}

          <Row
            tone={r.online ? "ok" : "muted"}
            icon={r.online ? <Wifi className="h-4 w-4" /> : <WifiOff className="h-4 w-4" />}
            label="การเชื่อมต่อ"
            value={r.online ? "ออนไลน์" : "ออฟไลน์ — รันจากเครื่องนี้ได้"}
          />
        </div>
      )}
    </div>
  );
}
