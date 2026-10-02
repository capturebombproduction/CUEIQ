"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  Plus,
  Pencil,
  Trash2,
  Music,
  Music2,
  FileAudio,
  Loader2,
  Search,
  CloudUpload,
  CloudOff,
  Volume2,
  VolumeX,
  Clock3,
  Lock,
  FolderInput,
  Undo2,
  Play,
  Pause,
  AudioLines,
  AudioWaveform,
  Hourglass,
  CircleCheck,
  CircleX,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { notify } from "@/lib/notify-client";
import { detectAudioDuration } from "@/lib/audio";
import {
  buildSongAudioPath,
  uploadEventAudio,
  removeEventAudio,
} from "@/lib/audio-remote";
import { cacheSongBlob, pruneSupersededSongs } from "@/lib/song-cache";
import {
  getLocalSource,
  setLocalSource,
  clearLocalSource,
  listLocalSourceIds,
} from "@/lib/local-source";
import { AUDIO_QUEUED_MESSAGE } from "@/lib/audio-upload-queue";
import { MGMT_OUTBOX_EVENT } from "@/lib/mgmt-outbox";
import {
  dropPendingAudioUpload,
  listPendingAudioUploads,
  tryQueueAudioUpload,
} from "@/lib/mgmt-write";
import { formatDuration, parseDurationToSeconds } from "@/lib/time";
import { wroteNothing, noRowsMessage } from "@/lib/write-guard";
import { hasLiveSession } from "@/lib/auth-session";
import {
  fetchServerNowMs,
  planTempSongPurge,
  stillTemporary,
  tempSongCandidates,
  type EventDateRow,
  type SetlistLink,
} from "@/lib/temp-song-purge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { MetaIcon } from "@/components/status-icon";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  COPYRIGHT_META,
  SONG_LANGUAGES,
  SONG_LANGUAGE_LABELS,
  type CopyrightStatus,
  type Group,
  type Song,
} from "@/lib/types";
import { canApprove, canEditGroup, type Perms } from "@/lib/permissions";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { privateChannel, songsTopic } from "@/lib/realtime";
import { cn } from "@/lib/utils";
import { THAI_RE } from "@/lib/thai";
import { useLibraryPreview } from "@/components/song/use-library-preview";
import { LibraryMiniPlayer } from "@/components/song/library-mini-player";

const NONE = "__none__";
const COPYRIGHT_KEYS = Object.keys(COPYRIGHT_META) as CopyrightStatus[];

/**
 * A song's rights entry, never undefined: an offline cached row (or one written
 * before the column existed) can arrive without copyright_status, and reading
 * `.variant` off nothing took the whole คลังเพลง down. Unknown reads as รอตรวจ —
 * the status every new song starts in, and the one that asks for a look.
 */
function rightsOf(song: Song) {
  return Object.prototype.hasOwnProperty.call(COPYRIGHT_META, song.copyright_status ?? "")
    ? COPYRIGHT_META[song.copyright_status]
    : COPYRIGHT_META.pending;
}

/**
 * Sound-effect files share the library with songs (the show's "[SYSTEM_BOOT] SE",
 * an overture). Nothing in the row marks them, so the cover tile reads it off the
 * category or a standalone "SE" in the title — decoration only, nothing filters on it.
 */
function isSoundEffect(song: Song): boolean {
  if (/^(se|sfx)$/i.test((song.category ?? "").trim())) return true;
  return /(^|[\s([])SE([\s)\]]|$)/.test(song.title ?? "");
}

/**
 * The 44 px cover (spec §G.5): a song is a solid band tile with a note, an SE a
 * well with a waveform, and the one in the player shows the EQ glyph instead.
 */
function CoverTile({ song, current }: { song: Song; current: boolean }) {
  const se = isSoundEffect(song);
  const Icon = current ? AudioLines : se ? AudioWaveform : Music;
  return (
    <span
      aria-hidden
      className={cn(
        "grid h-11 w-11 flex-none place-items-center rounded-[2px]",
        se && !current ? "well text-muted-foreground" : "bg-primary text-primary-foreground"
      )}
    >
      <Icon className="h-[19px] w-[19px]" strokeWidth={current ? 2.8 : 1.9} />
    </span>
  );
}

/** A tappable filter chip (44 px, `chip-lg`): solid when on, never colour alone. */
function FilterChip({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "chip chip-lg shrink-0 transition-colors duration-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        on ? "chip-solid" : "chip-neutral hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}

/** The songs guard (0018/0034) speaks English — say it in Thai, and say what to do. */
function friendlyError(message?: string): string | undefined {
  if (!message) return message;
  if (message.includes("only an approver may change copyright_status"))
    return "สถานะลิขสิทธิ์ของเพลงนี้ถูกเปลี่ยนจากหน้าอื่นแล้ว — โหลดหน้านี้ใหม่แล้วลองอีกครั้ง (เปลี่ยนสถานะได้เฉพาะทีมค่าย/แอดมิน)";
  if (message.includes("only an editor may change song details"))
    return "แก้ข้อมูลเพลงได้เฉพาะแอดมิน/Ar ของวงนี้";
  return message;
}

interface FormState {
  id: string | null;
  group_id: string;
  title: string;
  file_name: string;
  durationStr: string;
  language: string; // value code or NONE
  category: string;
  copyright_status: CopyrightStatus;
  notes: string;
}

function emptyForm(groupId: string): FormState {
  return {
    id: null,
    group_id: groupId,
    title: "",
    file_name: "",
    durationStr: "",
    language: NONE,
    category: "",
    copyright_status: "pending",
    notes: "",
  };
}

export function SongLibrary({
  tenantId,
  groups,
  initialSongs,
  perms,
  toolbarEnd,
  footer,
}: {
  tenantId: string;
  groups: Group[];
  initialSongs: Song[];
  perms: Perms;
  /** the page's own control (its refresh button) at the end of the search row */
  toolbarEnd?: ReactNode;
  /**
   * What the page puts after the list (its save bar). Rendered here, not after this
   * component, so it sits ABOVE the room kept for the preview player: placed after
   * the library it ended under the fixed player and its note could not be read.
   */
  footer?: ReactNode;
}) {
  const supabase = createClient();
  const confirm = useConfirm();
  // A song is editable by admin OR the band's Ar; copyright triage is for
  // approvers (admin / label_staff) only. Gate per-row by the song's band.
  const editableGroupIds = useMemo(
    () =>
      new Set(groups.filter((g) => canEditGroup(perms, g.id)).map((g) => g.id)),
    [groups, perms]
  );
  const editGroups = useMemo(
    () => groups.filter((g) => editableGroupIds.has(g.id)),
    [groups, editableGroupIds]
  );
  const canEditSong = (song: Song) => editableGroupIds.has(song.group_id);
  const canEditAny = editableGroupIds.size > 0;
  const approver = canApprove(perms);
  const [songs, setSongs] = useState<Song[]>(initialSongs);
  const [groupFilter, setGroupFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [copyFilter, setCopyFilter] = useState<string>("all");
  // the "มีเสียง" chip: only songs this device can play (canPreview)
  const [audioOnly, setAudioOnly] = useState(false);
  // Phone: the song whose sheet is open (edit, audio, rights, delete live there —
  // the 62 px row holds only the cover, title, rights and ▶). By id, so the sheet
  // follows the row's live state and closes itself if the song goes away.
  const [sheetId, setSheetId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm(editGroups[0]?.id ?? ""));
  const [saving, setSaving] = useState(false);
  const [detecting, setDetecting] = useState(false);
  // file picked in the add/edit dialog — uploaded to R2 on save (one-step add+upload)
  const [pickedFile, setPickedFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // per-song audio upload (to R2). audioBusy[songId] = which op is running.
  const [audioBusy, setAudioBusy] = useState<Record<string, "up" | "del">>({});
  const audioFileRef = useRef<HTMLInputElement>(null);
  const audioTargetRef = useRef<Song | null>(null);
  // Desktop-only (Electron): per-device local audio source. `native` is the
  // Electron bridge (undefined in a browser → these controls never render).
  // localIds = songs that currently have a local override on THIS device.
  const native = typeof window !== "undefined" ? window.cueiqNative : undefined;
  const [localIds, setLocalIds] = useState<Set<string>>(new Set());
  const [localBusy, setLocalBusy] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!native) return;
    listLocalSourceIds().then(setLocalIds).catch(() => {});
  }, [native]);
  // ⭐#1 step 6 — songs whose audio was picked while offline and is still waiting
  // to become the master. Empty on the web (nothing registers a reader), so this
  // costs the web build one resolved promise and renders nothing.
  const [pendingUploads, setPendingUploads] = useState<Set<string>>(new Set());
  const pendingUploadsRef = useRef(pendingUploads);
  pendingUploadsRef.current = pendingUploads;
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      listPendingAudioUploads().then((s) => {
        if (alive) setPendingUploads(s);
      });
    };
    refresh();
    // the outbox fires this after every queue change — including the flush that
    // clears these, so a badge disappears the moment its file has landed
    window.addEventListener(MGMT_OUTBOX_EVENT, refresh);
    return () => {
      alive = false;
      window.removeEventListener(MGMT_OUTBOX_EVENT, refresh);
    };
  }, []);

  // Preview playback — one song at a time, and it stops the moment this page goes
  // away (see components/song/use-library-preview.ts for why that is not optional).
  const preview = useLibraryPreview();
  // The practice room's rule for "has audio": an online master, or bytes held on
  // THIS device (a desktop local source, an upload still queued). No file, no ▶.
  const canPreview = (song: Song) => !!song.audio_path || localIds.has(song.id);
  // A song deleted, or stripped of its file, while it is the one in the player must
  // not keep sounding under a title the list no longer shows.
  const previewId = preview.current?.id ?? null;
  const stopPreview = preview.stop;
  useEffect(() => {
    if (!previewId) return;
    const s = songs.find((x) => x.id === previewId);
    if (!s || !(s.audio_path || localIds.has(s.id))) stopPreview();
  }, [songs, localIds, previewId, stopPreview]);

  const groupName = useMemo(
    () => Object.fromEntries(groups.map((g) => [g.id, g.name])),
    [groups]
  );

  // Lazy cleanup of temporary (ad-hoc) songs. The decision itself lives in
  // lib/temp-song-purge.ts — read the header there for the whole story; the short
  // version is that this used to be a SILENT delete, on THIS DEVICE'S CLOCK, of
  // both the row and the R2 master, with no undo and no second copy. It lost files
  // two ways: a machine whose clock ran fast (dead CMOS battery, a phone set
  // forward) condemned every temporary song in the opener's scope — and an
  // admin's scope is all 8 bands — while the 3-day horizon was measured from the
  // UPLOAD rather than from the show, so a song loaded ad hoc at an Aug-1
  // rehearsal for an Aug-6 gig was "expired" on Aug 4 and destroyed by whoever
  // merely OPENED คลังเพลง first. The setlist row then lost its song_id, and
  // because lib/audio-targets.ts skips rows with no song_id, it disappeared from
  // the completeness gate and the desktop readiness preflight too: a green
  // "พร้อมโชว์ออฟไลน์" with a silent track in the set.
  //
  // พี่พัชร์'s ruling: a temporary song must survive until the event that needs it.
  // So: the SERVER's clock decides expiry, any event that has not happened vetoes
  // the delete, and the user is asked before anything goes. Every step that cannot
  // be established with confidence ends the sweep instead of guessing — the files
  // simply linger until the next open, which costs megabytes, not a show.
  //
  // Round 11 added the two rules that make that actually hold:
  //   · the whole plan is REMADE after the confirm dialog and only the songs both
  //     rounds condemn are deleted — a plan is only true at the instant it was
  //     made, and this dialog can sit unanswered while someone else builds
  //     Saturday's setlist out of exactly these files;
  //   · the "is this really us?" question is handed to planTempSongPurge instead
  //     of asked here, because asked here it ran BEFORE the reads it was meant to
  //     vouch for, and an anon-degraded empty read sailed through as "unused".
  //
  // Round 12 changed WHO OPENS THE DIALOG, and nothing else about the decision.
  // Until now this effect called confirm() itself, and it was the only confirm()
  // in the repo not fired by a click (every other call site is inside an onClick;
  // `grep -rn "confirm({" app components desktop/src` is how that was checked).
  // Two things follow from that, both observed in review:
  //   · ConfirmProvider holds exactly ONE resolver (components/ui/confirm-dialog.tsx
  //     :51-59). A second confirm() while a dialog is open overwrites
  //     `resolver.current` and leaves `open` true — so the first promise is never
  //     settled and the panel simply swaps its contents in place. (Round 13: the
  //     provider now answers a second confirm() "cancelled" instead of repainting,
  //     because click-fired confirms CAN overlap after all — onDelete's opens only
  //     after a setlist-count round-trip, and the page stays clickable in that gap.)
  //     This one fired after an unbounded async run-up (pending-uploads
  //     read → an up-to-8s HEAD for the server clock → setlist read → events read),
  //     so it landed straight on top of an Ar who had just tapped 🗑 on a song. Their
  //     delete then never ran — no toast, no error, nothing — and the destructive
  //     button under their cursor had quietly become "ลบเพลงชั่วคราว", which is the
  //     irreversible R2 delete this whole guard exists to slow down.
  //   · ConfirmProvider is mounted in app/(app)/layout.tsx (and in the desktop's
  //     own shell.tsx:148/153), i.e. OUTSIDE this page in both apps, so an
  //     unprompted modal survived navigating away from คลังเพลง — and answering it
  //     there hit the `cancelled` guard and did precisely nothing, silently.
  // So the effect no longer asks anything. It PREPARES an offer and renders it as an
  // ordinary bar in the page (see `tempPurgeOffer` in the JSX); the confirm is opened
  // by runTempPurge() from a real click, like every other destructive action here.
  // The cost is that expired files linger until someone presses the button, which is
  // the same currency this whole feature already spends: megabytes, not a show.
  const [tempPurgeOffer, setTempPurgeOffer] = useState<{
    purge: Song[];
    keptForEvent: number;
  } | null>(null);
  const [tempPurgeBusy, setTempPurgeBusy] = useState(false);

  // One round of "may these songs go?", from scratch: server clock, links,
  // events, verdict. Called TWICE per sweep — once to build the offer, once after
  // the human answers the confirm — because a plan is only true at the instant it
  // was made (see the second call site in runTempPurge). Lifted to component scope
  // in round 12 for no reason other than that the click handler needs it too; the
  // body below is unchanged.
  const planTempPurge = async (cands: readonly Song[]) => {
    // Rows whose bytes are still sitting in the offline outbox waiting to
    // become the master: the user picked a file at the venue ten minutes ago,
    // and deleting the row now strands it. Read fresh rather than off the
    // `pendingUploads` state, which the sweep effect (deps `[]`) captured as an
    // empty Set before its own loader resolved.
    const pending = await listPendingAudioUploads();
    const candidates = cands.filter((s) => !pending.has(s.id));
    if (candidates.length === 0) return null;
    // The only clock allowed to condemn a file. null = we could not get one,
    // and the rule is then DO NOTHING rather than fall back to Date.now().
    const serverNowMs = await fetchServerNowMs();
    const ids = candidates.map((s) => s.id);
    // A read that ERRORED must be reported as null, never as []: an empty array
    // here means "proved unused", and proving that from a failed request is how
    // you delete a file a show is waiting for.
    const linkRes = await supabase
      .from("setlist_items")
      .select("song_id, event_id")
      .in("song_id", ids);
    const links = linkRes.error ? null : ((linkRes.data ?? []) as SetlistLink[]);
    const eventIds = [
      ...new Set(
        (links ?? [])
          .map((l) => l.event_id)
          .filter((x): x is string => typeof x === "string")
      ),
    ];
    let events: EventDateRow[] | null = [];
    if (eventIds.length > 0) {
      const evRes = await supabase
        .from("events")
        .select("id, event_date")
        .in("id", eventIds);
      events = evRes.error ? null : ((evRes.data ?? []) as EventDateRow[]);
    }
    // hasLiveSession is handed over as a QUESTION, not called here and passed
    // as an answer: the planner runs it after every read above has come back,
    // which is the only moment at which it proves anything. Round 10 asked it
    // first and an anon-degraded `[]` read straight through as "unused".
    return {
      serverNowMs,
      plan: await planTempSongPurge({
        candidates,
        serverNowMs,
        links,
        events,
        proveSession: hasLiveSession,
      }),
    };
  };

  useEffect(() => {
    // Scope: only bands this user may actually edit. A viewer would just collect
    // an RLS-refused delete and an alarming toast, and an Ar has no business being
    // asked about another band's files.
    const scoped = tempSongCandidates(initialSongs).filter((s) =>
      editableGroupIds.has(s.group_id)
    );
    if (scoped.length === 0) return;
    let cancelled = false;
    (async () => {
      const first = await planTempPurge(scoped);
      if (cancelled || !first) return;
      const { plan } = first;
      if (plan.blocked || plan.purge.length === 0) return;
      // The whole output of this effect: an offer, sitting in the page, that the
      // user may ignore forever. Nothing is asked and nothing is deleted here.
      setTempPurgeOffer({
        purge: plan.purge,
        keptForEvent: plan.keptForEvent.length,
      });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // What the offer may still truthfully claim. The bar can now sit on screen for
  // as long as the user likes, and 🔒 (promoteSong) clears a row's stamp in `songs`
  // the moment it lands — a bar that keeps counting a song the user just rescued is
  // telling them their rescue did not work. Narrowed in the same breath for the
  // dialog and the delete, so the number they see, the titles they are asked about
  // and the ids that go are one list.
  const tempPurgeNow = useMemo(
    () => (tempPurgeOffer ? stillTemporary(tempPurgeOffer.purge, songs) : []),
    [tempPurgeOffer, songs]
  );

  /**
   * The user pressed "ตรวจและลบ" on the offer bar. Everything destructive lives
   * here, behind a real click — see the effect above for why that matters.
   *
   * There is deliberately no unmount guard on this flow, unlike the sweep it
   * replaced. That guard existed because a dialog the user never opened could
   * outlive the page and be answered from somewhere else, and honouring it there
   * would have deleted masters on behalf of a page that was gone; it made the
   * answer a silent no-op instead. This dialog is opened by hand, on this page,
   * seconds earlier — so if the user does navigate away with it open and then
   * presses ลบเพลงชั่วคราว, finishing the job is exactly what they asked for, and
   * the toasts below still reach them (Sonner's <Toaster> is in the layout too).
   * The two setSongs/setTempPurgeOffer calls at the end are no-ops on an unmounted
   * component in React 19; nothing else here touches the DOM.
   */
  async function runTempPurge() {
    const offer = tempPurgeOffer;
    if (!offer || tempPurgeBusy) return;

    // The offer was built when the library opened and this button may be pressed
    // an hour later, so work from the NARROWED list (tempPurgeNow): a song the user
    // promoted with 🔒 in the meantime must not even be NAMED in a delete dialog.
    // (The database is asked again below, and the DELETE's .lt() refuses a promoted
    // row outright — this is only so the dialog tells the truth about what it does.)
    const stillOffered = tempPurgeNow;
    if (stillOffered.length === 0) {
      setTempPurgeOffer(null);
      toast.info("ไม่มีเพลงชั่วคราวที่ต้องลบแล้ว");
      return;
    }

    // Confirm-every-delete, the repo standard. Name the files, say plainly that
    // the bytes go for good, and point at the way out (🔒 = เก็บถาวร).
    //
    // The keep-count deliberately does NOT promise "ผูกกับงานที่ยังไม่ถึง":
    // keptForEvent also collects songs whose event row never came back, whose
    // event has no date, and whose link carries no event_id — i.e. "we could
    // not tell". An admin hunting for four upcoming shows that do not exist is
    // a support call; say the weaker thing that is always true.
    const names = stillOffered.map((s) => `“${s.title}”`).join(", ");
    const ok = await confirm({
      title: `ลบเพลงชั่วคราวที่หมดอายุแล้ว ${stillOffered.length} เพลง?`,
      description: (
        <>
          {names} — เป็นไฟล์ที่อัปแบบด่วนจากโหมดไลฟ์ และไม่มีงานที่ยังไม่ถึงใช้อยู่แล้ว
          ลบแล้วไฟล์เสียงจะหายถาวร กู้คืนไม่ได้
          {offer.keptForEvent > 0 &&
            ` (เก็บไว้อีก ${offer.keptForEvent} เพลง เพราะยังมีงานที่ยังไม่จบใช้อยู่ หรือยังตรวจไม่ได้)`}
          {" — ถ้าอยากเก็บไว้ ให้กด “ยังไม่ลบ” แล้วกดรูปกุญแจที่แถวเพลงเพื่อเก็บเป็นเพลงถาวร"}
        </>
      ),
      confirmText: "ลบเพลงชั่วคราว",
      cancelText: "ยังไม่ลบ",
    });
    if (!ok) return;

    setTempPurgeBusy(true);
    try {
      // RE-PLAN. The dialog above waits an unbounded amount of time for a human,
      // and the offer bar behind it may have been sitting there since the page
      // opened — so the plan is old twice over. Meanwhile the other Ar builds
      // Saturday's setlist and adds exactly this ad-hoc backing track. The .lt()
      // below re-checks the EXPIRY half of the guard against the database, but
      // nothing re-checked the LINK half, which is the entire point of this guard.
      // So ask the same questions again on the far side of the wait and delete
      // only what BOTH rounds agreed on. This re-runs the session proof too, which
      // closes the anon window across the dialog for free.
      const second = await planTempPurge(stillOffered);
      if (second?.plan.blocked) {
        // Could not re-check ≠ nothing to re-check. Say so out loud: the user
        // pressed a destructive button and deserves to know it did not run.
        toast.error("ยังลบเพลงชั่วคราวไม่ได้", {
          description: "ตรวจสอบซ้ำไม่สำเร็จ — ลองกดอีกครั้งเมื่อเน็ตกลับมา",
        });
        return;
      }
      const stillOk = new Set(second?.plan.purge.map((s) => s.id) ?? []);
      const doomed = stillOffered.filter((s) => stillOk.has(s.id));
      if (!second || doomed.length === 0) {
        setTempPurgeOffer(null);
        toast.info("ไม่ได้ลบเพลงไหนเลย", {
          description:
            "ระหว่างที่ถามยืนยัน เพลงเหล่านี้ถูกงานที่ยังไม่จบเรียกใช้ ถูกเก็บถาวร หรือมีไฟล์ใหม่รออัปโหลดอยู่",
        });
        return;
      }
      // The instant the DATABASE gave us on the SECOND pass — the freshest server
      // clock we hold, and the one the verdict just above was reached with. It
      // cannot be null here (a null clock blocks the plan), but narrow it rather
      // than assert it: a cast that is right today is the shape of the next bug.
      const serverNowMs = second.serverNowMs;
      if (serverNowMs === null) return;

      // DB rows delete first (one shot, mirroring onDelete) — if that fails, leave
      // everything intact and retry on the next press. R2 files only go after the
      // rows are confirmed gone, so a failed delete never leaves a surviving row
      // pointing at a missing file. And "confirmed gone" has to mean rows came
      // back, not merely that no error did: this runs during the anon minute after
      // a venue reconnect too, where the DELETE is RLS-filtered to zero rows with
      // error:null, and the loop below would then delete masters for rows that are
      // still there. See lib/write-guard.ts.
      //
      // The .lt() re-states the expiry test as a predicate the DATABASE evaluates,
      // against the instant the database itself gave us. Two things fall out for
      // free: this device's clock cannot widen the delete however wrong it is, and
      // a song someone promoted to permanent in the seconds since we planned is
      // excluded automatically, because a NULL audio_expires_at never satisfies `<`.
      const { data, error } = await supabase
        .from("songs")
        .delete()
        .in("id", doomed.map((s) => s.id))
        .lt("audio_expires_at", new Date(serverNowMs).toISOString())
        .select("id");
      if (error) {
        toast.error("ลบเพลงชั่วคราวไม่สำเร็จ", { description: error.message });
        return;
      }
      if (wroteNothing(data)) {
        toast.error("ลบเพลงชั่วคราวไม่สำเร็จ", { description: await noRowsMessage() });
        return;
      }
      const deleted = new Set((data ?? []).map((r) => (r as { id: string }).id));
      for (const s of doomed) {
        if (s.audio_path && deleted.has(s.id)) removeEventAudio(s.audio_path).catch(() => {});
      }
      setSongs((prev) => prev.filter((s) => !deleted.has(s.id)));
      setTempPurgeOffer(null);
      toast.success(`ลบเพลงชั่วคราวที่หมดอายุแล้ว ${deleted.size} เพลง`);
    } finally {
      setTempPurgeBusy(false);
    }
  }

  // Garbage-collect the on-device audio cache. It's keyed by R2 path, so replacing
  // a song's file (new random suffix) orphans the old version's blob, and removing a
  // song's audio entirely orphans it too — neither is ever played again but both
  // linger until a manual cache wipe. Sweep them whenever we know the songs' CURRENT
  // audio_path: on open, and again after an upload/removal changes a path (the
  // signature below re-fires the effect). Map EVERY visible song (audio_path null
  // when its file was removed) so the GC can prove the removed case; pruneSupersededSongs
  // only drops a cached path whose songId IS in this map, so a band not listed is untouched.
  const audioPathSig = useMemo(
    () =>
      songs
        .map((s) => `${s.id}:${s.audio_path ?? ""}`)
        .sort()
        .join("|"),
    [songs]
  );
  useEffect(() => {
    const current = new Map<string, string | null>();
    for (const s of songs) current.set(s.id, s.audio_path ?? null);
    if (current.size === 0) return;
    pruneSupersededSongs(current).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioPathSig]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return songs.filter((s) => {
      if (groupFilter !== "all" && s.group_id !== groupFilter) return false;
      if (copyFilter !== "all" && s.copyright_status !== copyFilter) return false;
      if (audioOnly && !(s.audio_path || localIds.has(s.id))) return false;
      if (
        // โน้ต is in the haystack because it's now shown on the row: an Ar who
        // typed "คีย์ต่ำลง 2" there must be able to find that song by it.
        needle &&
        ![s.title, s.category, s.file_name, s.notes]
          .filter(Boolean)
          .some((x) => (x as string).toLowerCase().includes(needle))
      )
        return false;
      return true;
    });
  }, [songs, groupFilter, copyFilter, query, audioOnly, localIds]);

  // How many songs each rights chip would show, within the band filter — the
  // chip says "รอตรวจ 2" before it is pressed, not after.
  const rightsCount = useMemo(() => {
    const n = { pending: 0, cleared: 0, rejected: 0 };
    for (const s of songs) {
      if (groupFilter !== "all" && s.group_id !== groupFilter) continue;
      if (s.copyright_status === "pending") n.pending++;
      else if (s.copyright_status === "cleared") n.cleared++;
      else if (s.copyright_status === "rejected") n.rejected++;
    }
    return n;
  }, [songs, groupFilter]);
  const filtered = copyFilter !== "all" || audioOnly || groupFilter !== "all" || !!query.trim();

  // The sheet's song, live from `songs`: gone (deleted elsewhere) closes the sheet.
  const sheetSong = sheetId ? songs.find((s) => s.id === sheetId) ?? null : null;

  function openAdd() {
    setPickedFile(null);
    setForm(emptyForm(editGroups[0]?.id ?? ""));
    setOpen(true);
  }

  function openEdit(song: Song) {
    setPickedFile(null);
    setForm({
      id: song.id,
      group_id: song.group_id,
      title: song.title,
      file_name: song.file_name ?? "",
      durationStr: song.duration_seconds
        ? formatDuration(song.duration_seconds)
        : "",
      language: song.language ?? NONE,
      category: song.category ?? "",
      copyright_status: song.copyright_status,
      notes: song.notes ?? "",
    });
    setOpen(true);
  }

  async function onPickFile(file: File | undefined) {
    if (!file) return;
    setPickedFile(file); // keep the File — uploaded to R2 on save
    setForm((f) => ({ ...f, file_name: file.name }));
    setDetecting(true);
    try {
      const seconds = await detectAudioDuration(file);
      setForm((f) => ({ ...f, durationStr: formatDuration(seconds) }));
      toast.success(`ตรวจพบความยาว ${formatDuration(seconds)}`, {
        description: "จะอัปโหลดไฟล์ขึ้นคลาวด์เมื่อกดบันทึก",
      });
    } catch (e) {
      toast.error("ตรวจความยาวไม่สำเร็จ", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setDetecting(false);
    }
  }

  async function onSave() {
    if (!form.title.trim()) {
      toast.error("กรอกชื่อเพลงก่อน");
      return;
    }
    if (!form.group_id) {
      toast.error("เลือกวงก่อน");
      return;
    }
    setSaving(true);
    // ลิขสิทธิ์ is sent CONDITIONALLY (guard 0034): the DB refuses a non-approver
    // changing copyright_status, and it compares against the CURRENT row — so a value
    // that only LOOKS changed because an approver triaged the song from another screen
    // while this dialog was open would make a plain title/duration edit fail with an
    // approver-only error, and every retry fail the same way. Unchanged → left out of
    // the patch entirely; a non-approver never sends it at all (the Select is already
    // disabled, this is the belt). A NEW song always carries it — the insert trigger
    // forces 'pending' for a non-approver anyway.
    const current = form.id ? songs.find((s) => s.id === form.id) : undefined;
    const copyrightPatch: { copyright_status?: CopyrightStatus } =
      !form.id || (approver && form.copyright_status !== current?.copyright_status)
        ? { copyright_status: form.copyright_status }
        : {};
    const payload = {
      tenant_id: tenantId,
      group_id: form.group_id,
      title: form.title.trim(),
      file_name: form.file_name.trim() || null,
      duration_seconds: form.durationStr
        ? parseDurationToSeconds(form.durationStr)
        : 0,
      language: form.language === NONE ? null : form.language,
      category: form.category.trim() || null,
      ...copyrightPatch,
      notes: form.notes.trim() || null,
    };

    let saved: Song | null = null;
    if (form.id) {
      const { data, error } = await supabase
        .from("songs")
        .update(payload)
        .eq("id", form.id)
        .select("*")
        .single();
      if (error || !data) {
        setSaving(false);
        toast.error("บันทึกไม่สำเร็จ", { description: friendlyError(error?.message) });
        return;
      }
      saved = data as Song;
      setSongs((prev) => prev.map((s) => (s.id === form.id ? (saved as Song) : s)));
    } else {
      const { data, error } = await supabase
        .from("songs")
        .insert(payload)
        .select("*")
        .single();
      if (error || !data) {
        setSaving(false);
        toast.error("เพิ่มเพลงไม่สำเร็จ", { description: friendlyError(error?.message) });
        return;
      }
      saved = data as Song;
      setSongs((prev) => [saved as Song, ...prev]);
    }

    // A file picked in this dialog is uploaded to R2 now that we have the song id
    // (one-step add+upload). uploadSongAudio sets audio_path + shows its own toast.
    if (pickedFile) {
      await uploadSongAudio(saved, pickedFile);
    } else {
      toast.success(form.id ? "บันทึกเพลงแล้ว" : "เพิ่มเพลงแล้ว");
    }
    // A newly-added song is forced to copyright 'pending' (DB trigger) for a
    // non-approver → let the approvers know it's waiting (route no-ops otherwise).
    if (!form.id && saved) notify("song_pending", { songId: saved.id });
    setPickedFile(null);
    setSaving(false);
    setOpen(false);
  }

  async function onDelete(song: Song) {
    // Warn if this song is linked into any setlist — those rows lose their file.
    const { count } = await supabase
      .from("setlist_items")
      .select("id", { count: "exact", head: true })
      .eq("song_id", song.id);
    const used = count ?? 0;
    const ok = await confirm({
      title: `ลบเพลง “${song.title}” ออกจากคลัง?`,
      description:
        used > 0
          ? `เพลงนี้ถูกใช้อยู่ใน ${used} รายการของงาน — ลบแล้วงานพวกนั้นจะไม่มีไฟล์เพลงนี้`
          : undefined,
      confirmText: "ลบเพลง",
    });
    if (!ok) return;
    const snapshot = songs;
    setSongs((prev) => prev.filter((s) => s.id !== song.id));
    const { data, error } = await supabase
      .from("songs")
      .delete()
      .eq("id", song.id)
      .select("id");
    if (error) {
      toast.error("ลบไม่สำเร็จ", { description: error.message });
      setSongs(snapshot);
      return;
    }
    // No error and no row = the delete never landed (anon after a failed token
    // refresh, or the row is already gone) — deleting the R2 object anyway would
    // orphan a song that's still live. See lib/write-guard.ts.
    if (wroteNothing(data)) {
      toast.error("ลบไม่สำเร็จ", { description: await noRowsMessage() });
      setSongs(snapshot);
      return;
    }
    if (song.audio_path) removeEventAudio(song.audio_path).catch(() => {});
    broadcastSongsChanged(song.group_id); // live update any open Live Mode (items unlink)
  }

  // Quick copyright triage inline in the table — no need to open the edit dialog.
  async function updateCopyright(song: Song, status: CopyrightStatus) {
    if (status === song.copyright_status) return;
    setSongs((prev) =>
      prev.map((s) => (s.id === song.id ? { ...s, copyright_status: status } : s))
    );
    const { data, error } = await supabase
      .from("songs")
      .update({ copyright_status: status })
      .eq("id", song.id)
      .select("id");
    if (error || wroteNothing(data)) {
      toast.error(
        "เปลี่ยนสถานะไม่สำเร็จ",
        { description: error ? error.message : await noRowsMessage() }
      );
      setSongs((prev) =>
        prev.map((s) =>
          s.id === song.id ? { ...s, copyright_status: song.copyright_status } : s
        )
      );
    } else if (status === "rejected") {
      notify("song_rejected", { songId: song.id });
    } else if (status === "cleared") {
      notify("song_cleared", { songId: song.id });
    }
  }

  // Tell any open Live Mode (same band) that a song's audio changed, so it
  // re-resolves in real time. Group-scoped broadcast → reaches every device.
  function broadcastSongsChanged(groupId: string) {
    const ch = privateChannel(supabase, songsTopic(groupId));
    ch.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        ch.send({ type: "broadcast", event: "changed", payload: {} });
        setTimeout(() => supabase.removeChannel(ch), 600);
      }
    });
  }

  // Upload (or replace) a song's audio to R2. A library upload is PERMANENT, so
  // we also clear any temp-expiry the song carried (e.g. it was first created
  // ad-hoc from Live Mode).
  // Returns the new R2 object path on success (so "ดันขึ้นเป็นต้นฉบับ" can seed the
  // device cache), or null on failure. Existing callers ignore the return.
  async function uploadSongAudio(song: Song, file: File): Promise<string | null> {
    setAudioBusy((b) => ({ ...b, [song.id]: "up" }));
    const prevPath = song.audio_path ?? null;
    const path = buildSongAudioPath(song.tenant_id, song.group_id, song.id, file.name);
    let uploaded = false; // R2 PUT landed — cleanup target if the DB update then fails
    try {
      await uploadEventAudio(path, file, file.type);
      uploaded = true;
      const { data, error } = await supabase
        .from("songs")
        .update({ audio_path: path, audio_name: file.name, audio_expires_at: null })
        .eq("id", song.id)
        .select("id");
      if (error) throw error;
      // No error and no row = the update never landed (anon after a failed token
      // refresh, or the row is gone) — the DB still points at prevPath, so deleting
      // it below would leave the song pointing at nothing. See lib/write-guard.ts.
      if (wroteNothing(data)) {
        toast.error("อัปโหลดไม่สำเร็จ", { description: await noRowsMessage() });
        return null;
      }
      setSongs((prev) =>
        prev.map((s) =>
          s.id === song.id
            ? { ...s, audio_path: path, audio_name: file.name, audio_expires_at: null }
            : s
        )
      );
      if (prevPath && prevPath !== path) removeEventAudio(prevPath).catch(() => {});
      // A real upload supersedes anything this device had queued for the song. Left
      // behind, its local-source override would keep winning at playback (Live Mode
      // reads local source FIRST), so the machine wired to the PA would play the old
      // take while every other device has this one.
      if (pendingUploadsRef.current.has(song.id)) {
        await dropPendingAudioUpload(song.id);
        setPendingUploads((prev) => {
          const n = new Set(prev);
          n.delete(song.id);
          return n;
        });
        setLocalIds((prev) => {
          const n = new Set(prev);
          n.delete(song.id);
          return n;
        });
      }
      broadcastSongsChanged(song.group_id); // live update any open Live Mode
      toast.success("อัปโหลดไฟล์เพลงขึ้นคลังแล้ว");
      return path;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // ⭐#1 step 6 — offline (desktop): don't lose the bytes. They become this
      // song's local source, so this machine plays them straight away, and an
      // audio.upload op remembers to make them the master when the net is back.
      // The R2 object we may already have PUT is deliberately left in place: the
      // queued op aims at that same key, so finishing the job later is a no-op
      // upload rather than a fresh 88 MB transfer.
      const queued = await tryQueueAudioUpload({
        songId: song.id,
        tenantId: song.tenant_id,
        groupId: song.group_id,
        path,
        file,
        fileName: file.name,
        contentType: file.type || "",
        basePath: prevPath,
        songTitle: song.title,
        errorMessage: message,
      });
      if (queued) {
        setLocalIds((prev) => new Set(prev).add(song.id));
        setPendingUploads((prev) => new Set(prev).add(song.id));
        toast.success(AUDIO_QUEUED_MESSAGE, { id: `audio-queued-${song.id}` });
        return null;
      }
      toast.error("อัปโหลดไม่สำเร็จ", { description: message });
      // The PUT landed but the update threw. A thrown update does NOT prove the
      // server rejected it — a dropped response after PostgREST committed looks
      // identical here. So delete the fresh object only when we can PROVE no row
      // points at it: re-read the row, and if that read fails (or we're offline,
      // or RLS hides it) leave the file alone. An orphan on R2 costs nothing;
      // deleting the file a live song points at costs the show.
      if (uploaded) await cleanupUnreferencedUpload(song.id, path);
      return null;
    } finally {
      setAudioBusy((b) => {
        const n = { ...b };
        delete n[song.id];
        return n;
      });
    }
  }

  // Best-effort orphan cleanup after a failed upload. Deletes `path` ONLY when
  // the row provably does not reference it. Any doubt (read failed, offline,
  // row missing) → keep the file.
  async function cleanupUnreferencedUpload(songId: string, path: string) {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    try {
      const { data, error } = await supabase
        .from("songs")
        .select("audio_path")
        .eq("id", songId)
        .maybeSingle();
      if (error || !data) return;
      if (data.audio_path === path) return; // the update DID commit — keep it
      await removeEventAudio(path);
    } catch {
      // leave the object; a later replace/removal sweeps it
    }
  }

  async function onPickAudioFile(file: File | undefined) {
    const song = audioTargetRef.current;
    if (audioFileRef.current) audioFileRef.current.value = "";
    if (!file || !song) return;
    await uploadSongAudio(song, file);
  }

  async function removeSongAudio(song: Song) {
    if (!song.audio_path) return;
    const ok = await confirm({
      title: `ลบไฟล์เสียงของ “${song.title}”?`,
      description: "ข้อมูลเพลงยังอยู่ — ลบเฉพาะไฟล์เสียง",
      confirmText: "ลบไฟล์เสียง",
    });
    if (!ok) return;
    setAudioBusy((b) => ({ ...b, [song.id]: "del" }));
    const path = song.audio_path;
    try {
      const { data, error } = await supabase
        .from("songs")
        .update({ audio_path: null, audio_name: null, audio_expires_at: null })
        .eq("id", song.id)
        .select("id");
      if (error) throw error;
      // No error and no row = the update never landed (anon after a failed token
      // refresh, or the row is gone) — the DB still points at `path`, so deleting
      // it below would leave the song pointing at nothing. See lib/write-guard.ts.
      if (wroteNothing(data)) {
        toast.error("ลบไฟล์ไม่สำเร็จ", { description: await noRowsMessage() });
        return;
      }
      setSongs((prev) =>
        prev.map((s) =>
          s.id === song.id
            ? { ...s, audio_path: null, audio_name: null, audio_expires_at: null }
            : s
        )
      );
      removeEventAudio(path).catch(() => {});
      broadcastSongsChanged(song.group_id); // live update any open Live Mode
      toast.success("ลบไฟล์เสียงแล้ว");
    } catch (e) {
      toast.error("ลบไฟล์ไม่สำเร็จ", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setAudioBusy((b) => {
        const n = { ...b };
        delete n[song.id];
        return n;
      });
    }
  }

  // --- Per-device local source (desktop only) -----------------------------
  // Best-effort MIME from the file name so the pushed master + cached blob carry
  // a sensible content type (the bytes come from the native picker without one).
  function guessAudioType(name: string): string {
    const ext = name.split(".").pop()?.toLowerCase();
    return ext === "mp3"
      ? "audio/mpeg"
      : ext === "wav"
        ? "audio/wav"
        : ext === "m4a" || ext === "aac"
          ? "audio/mp4"
          : ext === "flac"
            ? "audio/flac"
            : ext === "ogg"
              ? "audio/ogg"
              : "";
  }

  // Pick a file off THIS machine and make it the song's playback source here —
  // overrides the R2 master locally without changing anything online.
  async function pickLocalSource(song: Song) {
    if (!native) return;
    setLocalBusy((b) => ({ ...b, [song.id]: true }));
    try {
      const picked = await native.pickAudioFile();
      if (!picked) return; // user cancelled the native dialog
      // The native picker returns an exact, full-buffer Uint8Array; use its
      // ArrayBuffer (a plain Uint8Array isn't a BlobPart under strict lib types).
      const blob = new Blob([picked.bytes.buffer as ArrayBuffer], {
        type: guessAudioType(picked.name),
      });
      await setLocalSource(song.id, blob, picked.name);
      setLocalIds((prev) => new Set(prev).add(song.id));
      toast.success("ใช้ไฟล์ในเครื่องนี้เป็นแหล่งเล่นแล้ว", {
        description: `${picked.name} — เฉพาะเครื่องนี้`,
      });
    } catch (e) {
      toast.error("ตั้งไฟล์ในเครื่องไม่สำเร็จ", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setLocalBusy((b) => {
        const n = { ...b };
        delete n[song.id];
        return n;
      });
    }
  }

  // Drop the local override → this device goes back to playing the R2 master.
  async function revertToMaster(song: Song) {
    try {
      await clearLocalSource(song.id);
      setLocalIds((prev) => {
        const n = new Set(prev);
        n.delete(song.id);
        return n;
      });
      toast.success("กลับไปใช้ต้นฉบับ (R2) แล้ว");
    } catch (e) {
      toast.error("เปลี่ยนกลับไม่สำเร็จ", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Upload the local file as the song's R2 master (everyone gets it), seed this
  // device's cache so it won't re-download, then clear the now-redundant override.
  async function pushLocalAsMaster(song: Song) {
    if (!native) return;
    setLocalBusy((b) => ({ ...b, [song.id]: true }));
    try {
      const local = await getLocalSource(song.id);
      if (!local) {
        toast.error("ไม่พบไฟล์ในเครื่องสำหรับเพลงนี้");
        return;
      }
      const file = new File([local.blob], local.name, {
        type: local.blob.type || guessAudioType(local.name),
      });
      const newPath = await uploadSongAudio(song, file); // shows its own toast
      if (!newPath) return; // upload failed → keep the override
      await cacheSongBlob(newPath, local.blob, local.name).catch(() => {});
      await clearLocalSource(song.id);
      setLocalIds((prev) => {
        const n = new Set(prev);
        n.delete(song.id);
        return n;
      });
    } finally {
      setLocalBusy((b) => {
        const n = { ...b };
        delete n[song.id];
        return n;
      });
    }
  }

  // Desktop-only per-device source controls for one song. Shown only under
  // Electron AND only when the song already has an R2 master (the override
  // chooses which BYTES this device plays for an existing library song).
  function localSourceControls(song: Song) {
    if (!native || !song.audio_path) return null;
    // A queued offline upload stores its bytes AS this song's local source, so
    // "ใช้ต้นฉบับ" here would delete exactly what the queue is waiting to send —
    // no confirm, no warning, and the venue's replacement would simply never land.
    // The "รออัปโหลด" badge already describes the state, and "ดันขึ้นเป็นต้นฉบับ"
    // is what the queue is about to do by itself.
    if (pendingUploads.has(song.id)) return null;
    const busy = !!localBusy[song.id];
    if (localIds.has(song.id)) {
      return (
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="secondary" className="gap-1">
            <FolderInput className="h-3 w-3" /> ไฟล์ในเครื่องนี้ (ยังไม่อัป)
          </Badge>
          {canEditSong(song) && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7"
              disabled={busy}
              title="อัปไฟล์ในเครื่องนี้ขึ้นเป็นต้นฉบับ (R2) ให้ทุกเครื่องได้ไฟล์นี้"
              onClick={() => pushLocalAsMaster(song)}
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <CloudUpload className="h-3.5 w-3.5" />
              )}{" "}
              ดันขึ้นเป็นต้นฉบับ
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-7"
            disabled={busy}
            title="เลิกใช้ไฟล์ในเครื่อง กลับไปเล่นจากต้นฉบับ (R2)"
            onClick={() => revertToMaster(song)}
          >
            <Undo2 className="h-3.5 w-3.5" /> ใช้ต้นฉบับ
          </Button>
        </div>
      );
    }
    return (
      <Button
        variant="ghost"
        size="sm"
        className="h-7 text-muted-foreground"
        disabled={busy}
        title="เล่นเพลงนี้จากไฟล์ในเครื่องนี้แทนต้นฉบับ (เฉพาะเครื่องนี้)"
        onClick={() => pickLocalSource(song)}
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <FolderInput className="h-3.5 w-3.5" />
        )}{" "}
        ใช้ไฟล์ในเครื่องนี้
      </Button>
    );
  }

  // Promote a temporary (ad-hoc) song to permanent — keep its file forever.
  //
  // This is the ESCAPE HATCH from the expiry sweep above, which is exactly why it
  // needs the write guard: an update that lands on zero rows returns error:null
  // (lib/write-guard.ts — the anon minute after a venue reconnect), so this used
  // to show a green "เก็บเป็นเพลงถาวรแล้ว", leave the row's audio_expires_at
  // untouched in the database, and the very next library open would offer the file
  // up for deletion anyway. A user who took the one action available to save a
  // file must not be told it worked when it did not.
  async function promoteSong(song: Song) {
    setSongs((prev) =>
      prev.map((s) => (s.id === song.id ? { ...s, audio_expires_at: null } : s))
    );
    const { data, error } = await supabase
      .from("songs")
      .update({ audio_expires_at: null })
      .eq("id", song.id)
      .select("id");
    if (error || wroteNothing(data)) {
      toast.error("เก็บถาวรไม่สำเร็จ", {
        description: error ? error.message : await noRowsMessage(),
      });
      setSongs((prev) =>
        prev.map((s) =>
          s.id === song.id ? { ...s, audio_expires_at: song.audio_expires_at } : s
        )
      );
    } else {
      toast.success("เก็บเป็นเพลงถาวรแล้ว");
    }
  }

  // Days left before a temporary (ad-hoc) audio file passes its stamp, or null if
  // permanent. NEGATIVE means the stamp is behind us.
  //
  // This is the DEVICE's clock, and that is now the only place in this feature
  // where the device clock is still allowed to speak — because all it does here
  // is colour a badge. It must never sound like a deadline: the sweep condemns a
  // file on the SERVER's clock, refuses while any unfinished งาน still points at
  // it, and asks a human before anything goes. So a laptop with a dead CMOS
  // battery can make this label wrong, but it can no longer make it a promise —
  // see TEMP_BADGE_RULE below, which is the label's title on every row.
  const tempDaysLeft = (song: Song) =>
    song.audio_expires_at
      ? Math.ceil(
          (new Date(song.audio_expires_at).getTime() - Date.now()) / 86400000
        )
      : null;

  /**
   * What the ชั่วคราว badge actually means, verbatim, on every row that shows one.
   * Round 10 changed when a temporary file dies and left the countdown advertising
   * the old rule; "ชั่วคราว 0ว." on a track the band uploaded an hour ago (fast
   * device clock) had Ars re-uploading files that were never in danger.
   */
  const TEMP_BADGE_RULE =
    "ไฟล์ชั่วคราวจากโหมดไลฟ์ — จะถูกลบก็ต่อเมื่อเลยกำหนดตามเวลาของเซิร์ฟเวอร์ ไม่มีงานที่ยังไม่จบใช้อยู่ และมีคนกดยืนยันเท่านั้น (ตัวเลขนี้นับตามนาฬิกาของเครื่องนี้ จึงอาจคลาดเคลื่อน) — กดรูปกุญแจเพื่อเก็บเป็นเพลงถาวร";

  // Per-song render pieces shared by the desktop table and the mobile cards so
  // the two layouts can never drift apart.
  // "table": one line (the md+ Audio column); "sheet": wraps under the thumb.
  function audioStatus(song: Song, layout: "table" | "sheet" = "sheet") {
    const row =
      layout === "table"
        ? "flex flex-nowrap items-center gap-0.5"
        : "flex flex-wrap items-center gap-1.5";
    const busy = audioBusy[song.id];
    const hasAudio = !!song.audio_path;
    const songEditable = canEditSong(song);
    const tempLeft = tempDaysLeft(song);
    if (busy) {
      return (
        <span className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          {busy === "up" ? "กำลังอัป…" : "กำลังลบ…"}
        </span>
      );
    }
    // ⭐#1 step 6 — picked offline, bytes held on this device. Says so plainly
    // instead of "ไม่มีไฟล์เสียง" (a song that has never had a master would
    // otherwise look untouched right after the user just gave it a file).
    if (pendingUploads.has(song.id)) {
      return (
        <div className={row}>
          <Badge
            variant="secondary"
            title="เก็บไฟล์ไว้ในเครื่องนี้แล้ว — เล่นบนเครื่องนี้ได้เลย และจะอัปขึ้นคลังให้เองเมื่อเน็ตกลับ"
          >
            <CloudOff aria-hidden /> รออัปโหลด
          </Badge>
          {songEditable && layout === "sheet" && (
            <Button
              variant="ghost"
              size="icon"
              title="เลือกไฟล์ใหม่แทนไฟล์ที่รออัปโหลด"
              onClick={() => {
                audioTargetRef.current = song;
                audioFileRef.current?.click();
              }}
            >
              <CloudUpload className="h-4 w-4" />
            </Button>
          )}
        </div>
      );
    }
    if (hasAudio) {
      return (
        <div className={row}>
          {tempLeft != null ? (
            <Badge variant="secondary" title={TEMP_BADGE_RULE}>
              <Clock3 aria-hidden />
              {tempLeft > 0 ? `ชั่วคราว ${tempLeft}ว.` : "ชั่วคราว — เลยกำหนดแล้ว"}
            </Badge>
          ) : (
            <Badge variant="success">
              <Volume2 aria-hidden /> มีไฟล์
            </Badge>
          )}
          {/* 44 px icon buttons. The 🔒 escape hatch shows wherever the badge does;
              replacing or removing the file lives in the song's sheet (and the
              table's ⬆ action), so the Audio column stays one short line. */}
          {songEditable && tempLeft != null && (
            <Button
              variant="ghost"
              size="icon"
              title="เก็บเป็นเพลงถาวร (ไม่ให้หมดอายุ)"
              onClick={() => promoteSong(song)}
            >
              <Lock className="h-4 w-4" />
            </Button>
          )}
          {songEditable && layout === "sheet" && (
            <>
              <Button
                variant="ghost"
                size="icon"
                title="เปลี่ยนไฟล์เสียง"
                onClick={() => {
                  audioTargetRef.current = song;
                  audioFileRef.current?.click();
                }}
              >
                <CloudUpload className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="[&_svg]:text-destructive"
                title="ลบไฟล์เสียง"
                onClick={() => removeSongAudio(song)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </>
          )}
        </div>
      );
    }
    if (songEditable && layout === "sheet") {
      return (
        <Button
          variant="secondary"
          className="h-11"
          onClick={() => {
            audioTargetRef.current = song;
            audioFileRef.current?.click();
          }}
        >
          <CloudUpload className="h-4 w-4" /> อัปไฟล์
        </Button>
      );
    }
    return (
      <span className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
        <VolumeX className="h-4 w-4" aria-hidden /> ไม่มีไฟล์
      </span>
    );
  }

  // The rights StatusChip (icon + word). For an approver the chip is the control
  // that cycles it, inside a 44 px-tall button so a thumb can hit it. `readOnly`
  // (the phone row) shows just the chip: there it would sit a thumb's width from
  // the ▶, and one stray tap writes copyright_status and notifies people — on a
  // phone the change is made in the song's sheet.
  function copyrightControl(song: Song, opts?: { readOnly?: boolean }) {
    const cr = rightsOf(song);
    if (approver && !opts?.readOnly) {
      return (
        <button
          type="button"
          onClick={() => {
            const order: CopyrightStatus[] = ["pending", "cleared", "rejected"];
            const next =
              order[(order.indexOf(song.copyright_status) + 1) % 3];
            updateCopyright(song, next);
          }}
          title="คลิกเพื่อเปลี่ยนสถานะลิขสิทธิ์ (รอตรวจ → ถูกต้อง → ถูกปฏิเสธ)"
          className="group grid h-11 shrink-0 place-items-center rounded-[3px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Badge
            variant={cr.variant}
            className="cursor-pointer transition-opacity duration-2 group-hover:opacity-80"
          >
            <MetaIcon icon={cr.icon} />
            {cr.label}
          </Badge>
        </button>
      );
    }
    return (
      <Badge variant={cr.variant} className="shrink-0">
        <MetaIcon icon={cr.icon} />
        {cr.label}
      </Badge>
    );
  }

  // ▶ / ⏸ for one song — the same 44 × 44 key on the table row and the phone row:
  // a well at rest, the band fill while it is the song in the player.
  function previewButton(song: Song) {
    if (!canPreview(song)) return null;
    const isCurrent = preview.current?.id === song.id;
    const busy = isCurrent && preview.loading;
    const sounding = isCurrent && preview.playing;
    return (
      <Button
        type="button"
        variant={isCurrent ? "default" : "secondary"}
        size="icon"
        className="shrink-0 rounded-[2px]"
        aria-label={`${busy || sounding ? "หยุดตัวอย่าง" : "เล่นตัวอย่าง"} ${song.title}`}
        title={busy || sounding ? "หยุดฟัง" : "ฟังตัวอย่าง"}
        onClick={() => preview.play(song)}
      >
        {busy ? (
          <Loader2 className="animate-spin" />
        ) : sounding ? (
          <Pause />
        ) : (
          <Play />
        )}
      </Button>
    );
  }

  /** length · language · BPM, numerals in Barlow; parts that are missing drop out */
  function metaParts(song: Song): ReactNode[] {
    const parts: ReactNode[] = [];
    if (song.duration_seconds) {
      parts.push(
        <span key="len" className="num text-[15px] text-foreground/85">
          {formatDuration(song.duration_seconds)}
        </span>
      );
    }
    if (song.language) {
      parts.push(<span key="lang">{SONG_LANGUAGE_LABELS[song.language] ?? song.language}</span>);
    }
    if (song.bpm) {
      parts.push(
        <span key="bpm">
          <span className="num text-[15px]">{song.bpm}</span>{" "}
          <span className="[@media(max-width:380px)]:text-[10px]">BPM</span>
        </span>
      );
    }
    return parts;
  }

  // Marks the song in the player: aria-current while it is loaded (playing or
  // paused), data-playing only while it is actually sounding.
  function previewMarks(song: Song) {
    const isCurrent = preview.current?.id === song.id;
    return {
      "aria-current": isCurrent ? ("true" as const) : undefined,
      "data-playing": isCurrent && preview.playing ? "true" : undefined,
    };
  }

  // The table's actions (spec §G.5): upload / replace the file, edit, delete.
  // Removing just the file, and a desktop's local source, are in the song's sheet.
  function rowActions(song: Song) {
    if (!canEditSong(song)) return null;
    return (
      <>
        <Button
          variant="ghost"
          size="icon"
          disabled={!!audioBusy[song.id]}
          aria-label={`${song.audio_path ? "เปลี่ยนไฟล์เสียง" : "อัปไฟล์เสียง"} ${song.title}`}
          title={song.audio_path ? "เปลี่ยนไฟล์เสียง" : "อัปไฟล์เสียง"}
          onClick={() => {
            audioTargetRef.current = song;
            audioFileRef.current?.click();
          }}
        >
          <CloudUpload className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`แก้ไขเพลง ${song.title}`}
          title="แก้ไขเพลง"
          onClick={() => openEdit(song)}
        >
          <Pencil className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="[&_svg]:text-destructive"
          aria-label={`ลบเพลง ${song.title}`}
          title="ลบเพลง"
          onClick={() => onDelete(song)}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </>
    );
  }

  return (
    <div className="space-y-3">
      {/* hidden input for per-song audio upload to R2 (separate from the
          dialog's duration-detect picker) */}
      <input
        ref={audioFileRef}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={(e) => onPickAudioFile(e.target.files?.[0])}
      />
      {/* Search row: the field takes what is left; the page's refresh and the
          editor's + sit at its end (icon-only + on a phone, labelled from sm). */}
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1 md:max-w-sm">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-muted-foreground"
            strokeWidth={2.2}
          />
          <Input
            type="search"
            aria-label="ค้นหาเพลง"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="ค้นหาเพลง / หมวดหมู่ / โน้ต…"
            className="h-[46px] pl-10"
          />
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {toolbarEnd}
          {canEditAny && (
            <Button onClick={openAdd} className="h-[46px] min-w-[46px] px-3 sm:px-4" aria-label="เพิ่มเพลง">
              <Plus className="h-[18px] w-[18px]" aria-hidden />
              <span className="hidden sm:inline">เพิ่มเพลง</span>
            </Button>
          )}
        </div>
      </div>

      {/* Filter chips (44 px). Scrolls sideways inside its own row on a narrow
          phone; the page itself never does. */}
      <div className="no-scrollbar -mx-4 flex items-center gap-1.5 overflow-x-auto px-4 pb-0.5 md:mx-0 md:px-0">
        <FilterChip
          on={copyFilter === "all" && !audioOnly}
          onClick={() => {
            setCopyFilter("all");
            setAudioOnly(false);
          }}
        >
          ทั้งหมด
        </FilterChip>
        <FilterChip on={audioOnly} onClick={() => setAudioOnly((v) => !v)}>
          <Volume2 aria-hidden />
          มีเสียง
        </FilterChip>
        <FilterChip
          on={copyFilter === "pending"}
          onClick={() => setCopyFilter((f) => (f === "pending" ? "all" : "pending"))}
        >
          <Hourglass aria-hidden />
          รอตรวจ <span className="num text-[16px]">{rightsCount.pending}</span>
        </FilterChip>
        {/* The old rights dropdown's ✅ ถูกต้อง: an approver re-checking a clearance
            needs the cleared songs on their own. */}
        <FilterChip
          on={copyFilter === "cleared"}
          onClick={() => setCopyFilter((f) => (f === "cleared" ? "all" : "cleared"))}
        >
          <CircleCheck aria-hidden />
          ถูกต้อง <span className="num text-[16px]">{rightsCount.cleared}</span>
        </FilterChip>
        {(rightsCount.rejected > 0 || copyFilter === "rejected") && (
          <FilterChip
            on={copyFilter === "rejected"}
            onClick={() => setCopyFilter((f) => (f === "rejected" ? "all" : "rejected"))}
          >
            <CircleX aria-hidden />
            ถูกปฏิเสธ <span className="num text-[16px]">{rightsCount.rejected}</span>
          </FilterChip>
        )}
        {groups.length > 1 && (
          <div className="w-44 shrink-0">
            <Select value={groupFilter} onValueChange={setGroupFilter}>
              <SelectTrigger aria-label="กรองตามวง">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">ทุกวง</SelectItem>
                {groups.map((g) => (
                  <SelectItem key={g.id} value={g.id}>
                    {g.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>
      {filtered && songs.length > 0 && (
        <p className="px-0.5 text-[12.5px] text-muted-foreground">
          แสดง <span className="num text-[15px] text-foreground">{visible.length}</span> จาก{" "}
          <span className="num text-[15px]">{songs.length}</span> เพลง
        </p>
      )}

      {/* The temporary-song sweep's offer. This bar exists instead of the modal
          that used to appear by itself when คลังเพลง opened: a dialog nobody
          asked for destroyed the confirm the user HAD asked for (one resolver in
          ConfirmProvider), and it outlived the page, because the provider is
          mounted in the layout. A bar can do neither. It waits, it can be
          dismissed with ไว้ก่อน, and it comes back next open — retrying is free
          and the bytes are not. See the sweep effect above. */}
      {tempPurgeNow.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-[2px] bg-warning/10 px-3 py-2.5 shadow-[inset_0_0_0_1px_hsl(var(--warning)/.45)]">
          <Clock3 className="h-4 w-4 shrink-0 text-warning-ink" aria-hidden />
          <div className="min-w-0 text-sm">
            <span className="font-medium">
              เพลงชั่วคราวที่หมดอายุแล้ว {tempPurgeNow.length} เพลง
            </span>{" "}
            <span className="text-muted-foreground">
              — ไฟล์ที่อัปแบบด่วนจากโหมดไลฟ์ และตอนนี้ไม่มีงานที่ยังไม่จบใช้อยู่ · ถ้าอยากเก็บไว้
              ให้กดรูปกุญแจที่แถวเพลงเพื่อเก็บเป็นเพลงถาวร
            </span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-11"
              onClick={() => setTempPurgeOffer(null)}
            >
              ไว้ก่อน
            </Button>
            {/* outline: the solid red is the confirm sheet's, which this opens */}
            <Button
              variant="destructive-outline"
              size="sm"
              className="h-11"
              disabled={tempPurgeBusy}
              onClick={runTempPurge}
            >
              {tempPurgeBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
              ตรวจและลบ
            </Button>
          </div>
        </div>
      )}

      {visible.length === 0 ? (
        <div className="slab flex flex-col items-center justify-center gap-3 py-16 text-center">
          <Music2 className="h-10 w-10 text-muted-foreground" aria-hidden />
          {songs.length === 0 ? (
            <>
              <p className="text-muted-foreground">ยังไม่มีเพลงในคลัง</p>
              {canEditAny && (
                <Button variant="secondary" onClick={openAdd}>
                  <Plus className="h-4 w-4" /> เพิ่มเพลงแรก
                </Button>
              )}
            </>
          ) : (
            <p className="text-muted-foreground">ไม่พบเพลงที่ตรงกับการค้นหา / ตัวกรอง</p>
          )}
        </div>
      ) : (
        <>
          {/* md and up: the Table primitive (one slab, hairlines, a band rail on the
              song in the player). */}
          <div className="hidden md:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Song</TableHead>
                {/* Length and Audio are narrower below lg: their content (a time, one
                    or two badges, nowrap) is well under the lg widths, and the room goes
                    to the Song column — 144 px of it at 768 made every title wrap per
                    word. A column never goes below its content, so nothing is cut. */}
                <TableHead className="w-20 text-right lg:w-24">Length</TableHead>
                <TableHead className="w-32 lg:w-[10rem]">Audio</TableHead>
                <TableHead className="hidden w-24 lg:table-cell">Language</TableHead>
                <TableHead className="hidden w-28 xl:table-cell">Category</TableHead>
                <TableHead className="w-32">Rights</TableHead>
                {/* Band is its own column from lg only. At 768-1023 a label admin's
                    row (Song + Length + Audio + Rights + ▶ + manage) already takes the
                    whole slab, and the table scrolled sideways with the edit / delete
                    keys off-screen — below lg the band is a meta line under the title. */}
                {groups.length > 1 && <TableHead className="hidden w-36 lg:table-cell">Band</TableHead>}
                <TableHead className="w-14">
                  <span className="sr-only">ตัวอย่าง</span>
                </TableHead>
                {canEditAny && (
                  <TableHead className="w-[9.5rem]">
                    <span className="sr-only">จัดการ</span>
                  </TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((song) => {
                const isCurrent = preview.current?.id === song.id;
                const band = groups.find((g) => g.id === song.group_id);
                return (
                  <TableRow
                    key={song.id}
                    {...previewMarks(song)}
                    data-current={isCurrent}
                    className={cn(isCurrent && "bg-primary/[.08]")}
                  >
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <CoverTile song={song} current={isCurrent} />
                        <div className="min-w-0">
                          {/* the title opens the song's sheet — the same one a phone row
                              opens: notes in full, the file, removing it, local source */}
                          <button
                            type="button"
                            aria-haspopup="dialog"
                            onClick={() => setSheetId(song.id)}
                            className={cn(
                              "rounded-[2px] text-left text-[15px] font-medium leading-tight underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                              isCurrent && "font-semibold text-primary-ink"
                            )}
                          >
                            {song.title}
                          </button>
                          {/* โน้ตของเพลง — until now it was write-only (visible only by
                              reopening the edit dialog). Clamped so a long note can't
                              blow the row height up; the full text stays reachable via
                              the tooltip, and the phone's song sheet prints it whole. */}
                          {song.notes && (
                            <div
                              className="line-clamp-2 whitespace-pre-wrap break-words text-xs text-muted-foreground"
                              title={song.notes}
                            >
                              {song.notes}
                            </div>
                          )}
                          {/* the file name is an unbreakable string: as the cell's
                              min-content it held the Song column ~330 px wide and pushed
                              the table past the slab at tablet widths (CQ-39). break-all
                              lets it wrap; two lines at most, the full name on hover. */}
                          {song.file_name && (
                            <div className="flex items-start gap-1 text-xs text-muted-foreground">
                              <FileAudio className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                              <span className="line-clamp-2 min-w-0 break-all" title={song.file_name}>
                                {song.file_name}
                              </span>
                            </div>
                          )}
                          {groups.length > 1 && band && (
                            <div className="flex items-center gap-1.5 text-xs text-muted-foreground lg:hidden">
                              <span
                                aria-hidden
                                className="h-2 w-2 shrink-0 rounded-[1px] bg-muted-foreground"
                                style={band.color ? { background: band.color } : undefined}
                              />
                              <span className="min-w-0 break-words">{band.name}</span>
                            </div>
                          )}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="num text-right text-[15px]">
                      {song.duration_seconds
                        ? formatDuration(song.duration_seconds)
                        : "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      <div className="space-y-1.5">
                        {audioStatus(song, "table")}
                        {localSourceControls(song)}
                      </div>
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground lg:table-cell">
                      {song.language
                        ? SONG_LANGUAGE_LABELS[song.language] ?? song.language
                        : "—"}
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground xl:table-cell">
                      {song.category || "—"}
                    </TableCell>
                    <TableCell>{copyrightControl(song)}</TableCell>
                    {groups.length > 1 && (
                      <TableCell className="hidden text-muted-foreground lg:table-cell">
                        {band ? (
                          <span className="flex items-center gap-2">
                            <span
                              aria-hidden
                              className="h-2.5 w-2.5 shrink-0 rounded-[1px] bg-muted-foreground"
                              style={band.color ? { background: band.color } : undefined}
                            />
                            <span className="truncate">{band.name}</span>
                          </span>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                    )}
                    <TableCell className="px-1.5">
                      {/* no file → an empty slot the key's size, so the column holds */}
                      {previewButton(song) ?? <span aria-hidden className="block h-11 w-11" />}
                    </TableCell>
                    {canEditAny && (
                      <TableCell className="px-1.5">
                        <div className="flex justify-end">
                          {rowActions(song)}
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          </div>

          {/* Phone: 62 px media rows (spec §G.5) — cover, title, length · language ·
              BPM, the rights chip and a 44 px ▶. Everything else a song has (notes,
              its file, audio upload, edit, delete) is one tap away in its sheet. */}
          <div className="stack md:hidden">
            {visible.map((song) => {
              const isCurrent = preview.current?.id === song.id;
              const meta = metaParts(song);
              return (
                <div
                  key={song.id}
                  {...previewMarks(song)}
                  className={cn(
                    "slab flex min-h-[62px] items-center gap-2 py-2 pl-3 pr-2 [@media(max-width:380px)]:gap-1.5",
                    isCurrent &&
                      "bg-[linear-gradient(90deg,hsl(var(--primary)/.16),transparent_70%)] shadow-[inset_4px_0_0_hsl(var(--primary)),inset_0_0_0_1px_hsl(var(--border))]"
                  )}
                >
                  <button
                    type="button"
                    aria-haspopup="dialog"
                    onClick={() => setSheetId(song.id)}
                    className="-my-1 flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-[2px] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <CoverTile song={song} current={isCurrent} />
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn(
                          "block truncate text-[15px] font-medium leading-tight",
                          isCurrent && "font-semibold text-primary-ink"
                        )}
                      >
                        {song.title}
                      </span>
                      {/* `block truncate`, never `flex`: text-overflow does not apply to
                          flex items, so on a 360 px phone "174 BPM" was cut mid-glyph with
                          no ellipsis. The separators carry their own margin for the same
                          reason (no flex gap). Under 380 px three things tighten together
                          so length · language · BPM fits WHOLE on a 360 px row: the
                          separator margin, the unit word (10 px; the numeral beside it
                          stays 15) and the row's own gap. At 360 the line's box is 122-126
                          px; an English row with a 3-digit tempo was 135 wide ("B…"), the
                          widest is now 122. Wider phones keep the 12.5 px unit and 6 px margins. */}
                      {meta.length > 0 && (
                        <span className="mt-[3px] block truncate text-[12.5px] text-muted-foreground">
                          {meta.flatMap((p, i) =>
                            i === 0
                              ? [p]
                              : [
                                  <span key={`dot-${i}`} aria-hidden className="mx-1.5 [@media(max-width:380px)]:mx-0.5">
                                    ·
                                  </span>,
                                  p,
                                ]
                          )}
                        </span>
                      )}
                    </span>
                  </button>
                  {copyrightControl(song, { readOnly: true })}
                  {previewButton(song)}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* The phone's song sheet: what used to be stacked on every card. Actions that
          open their own dialog (edit, delete → confirm) close this one first, so
          two modals never sit on each other. */}
      <Dialog
        open={!!sheetSong}
        onOpenChange={(o) => {
          if (!o) setSheetId(null);
        }}
      >
        {sheetSong && (
          <DialogContent>
            <DialogHeader>
              {/* a song title as typed: no caps, no italic (DialogTitle would set an
                  English one as the italic caps H2) */}
              <DialogTitle
                className={
                  THAI_RE.test(sheetSong.title)
                    ? undefined
                    : "font-display text-[24px] font-extrabold normal-case not-italic leading-tight tracking-normal [font-synthesis:none]"
                }
              >
                {sheetSong.title}
              </DialogTitle>
              <DialogDescription>
                {[
                  sheetSong.duration_seconds ? formatDuration(sheetSong.duration_seconds) : null,
                  sheetSong.language
                    ? SONG_LANGUAGE_LABELS[sheetSong.language] ?? sheetSong.language
                    : null,
                  sheetSong.bpm ? `${sheetSong.bpm} BPM` : null,
                  sheetSong.category || null,
                  groups.length > 1 ? groupName[sheetSong.group_id] ?? null : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || "ยังไม่มีรายละเอียด"}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              {sheetSong.notes && (
                <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed">
                  {sheetSong.notes}
                </p>
              )}
              <div className="flex items-center justify-between gap-3">
                <span className="eyebrow text-muted-foreground">Rights</span>
                {copyrightControl(sheetSong)}
              </div>
              <div className="space-y-2">
                <span className="eyebrow text-muted-foreground">Audio</span>
                {sheetSong.file_name && (
                  <p className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
                    <FileAudio className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span className="truncate">{sheetSong.file_name}</span>
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  {audioStatus(sheetSong)}
                  {previewButton(sheetSong)}
                </div>
                {localSourceControls(sheetSong)}
              </div>
            </div>

            {canEditSong(sheetSong) && (
              <DialogFooter>
                <Button
                  variant="destructive-outline"
                  onClick={() => {
                    const s = sheetSong;
                    setSheetId(null);
                    onDelete(s);
                  }}
                >
                  <Trash2 className="h-4 w-4" /> ลบเพลง
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    const s = sheetSong;
                    setSheetId(null);
                    openEdit(s);
                  }}
                >
                  <Pencil className="h-4 w-4" /> แก้ไข
                </Button>
              </DialogFooter>
            )}
          </DialogContent>
        )}
      </Dialog>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{form.id ? "Edit Song" : "Add Song"}</DialogTitle>
            <DialogDescription>
              เลือกไฟล์เสียง — ระบบอ่านความยาวอัตโนมัติ และอัปโหลดไฟล์ขึ้นคลาวด์ให้
              เมื่อกดบันทึก (ใช้เล่นใน Live Mode ได้ทุกเครื่อง)
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="song-title">ชื่อเพลง *</Label>
              <Input
                id="song-title"
                value={form.title}
                onChange={(e) =>
                  setForm((f) => ({ ...f, title: e.target.value }))
                }
                placeholder="เช่น Flare Up"
              />
            </div>

            {editGroups.length > 1 && (
              <div className="space-y-2">
                <Label>วง</Label>
                <Select
                  value={form.group_id}
                  onValueChange={(v) =>
                    setForm((f) => ({ ...f, group_id: v }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {editGroups.map((g) => (
                      <SelectItem key={g.id} value={g.id}>
                        {g.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="space-y-2">
              <Label>ไฟล์เสียง (อัปขึ้นคลาวด์ + อ่านความยาว)</Label>
              <input
                ref={fileRef}
                type="file"
                accept="audio/*"
                className="hidden"
                onChange={(e) => onPickFile(e.target.files?.[0])}
              />
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => fileRef.current?.click()}
                  disabled={detecting}
                >
                  {detecting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <FileAudio className="h-4 w-4" />
                  )}
                  เลือกไฟล์
                </Button>
                <span className="truncate text-sm text-muted-foreground">
                  {form.file_name || "ยังไม่ได้เลือกไฟล์"}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="song-duration">ความยาว (m:ss)</Label>
                <Input
                  id="song-duration"
                  value={form.durationStr}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, durationStr: e.target.value }))
                  }
                  placeholder="3:30"
                  className="tabular-nums"
                />
              </div>
              <div className="space-y-2">
                <Label>ภาษา</Label>
                <Select
                  value={form.language}
                  onValueChange={(v) =>
                    setForm((f) => ({ ...f, language: v }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>ไม่ระบุ</SelectItem>
                    {SONG_LANGUAGES.map((l) => (
                      <SelectItem key={l.value} value={l.value}>
                        {l.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="song-category">หมวดหมู่</Label>
                <Input
                  id="song-category"
                  value={form.category}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, category: e.target.value }))
                  }
                  placeholder="เช่น Title / B-side / Cover"
                />
              </div>
              <div className="space-y-2">
                <Label>ลิขสิทธิ์</Label>
                <Select
                  value={form.copyright_status}
                  disabled={!approver}
                  onValueChange={(v) =>
                    setForm((f) => ({
                      ...f,
                      copyright_status: v as CopyrightStatus,
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {COPYRIGHT_KEYS.map((k) => (
                      <SelectItem key={k} value={k}>
                        <span className="inline-flex items-center gap-2">
                          <MetaIcon icon={COPYRIGHT_META[k].icon} className="h-4 w-4 shrink-0" />
                          {COPYRIGHT_META[k].label}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!approver && (
                  <p className="text-xs text-muted-foreground">
                    เฉพาะทีมค่าย/แอดมินเปลี่ยนสถานะลิขสิทธิ์ได้
                  </p>
                )}
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="song-notes">โน้ต</Label>
              <Input
                id="song-notes"
                value={form.notes}
                onChange={(e) =>
                  setForm((f) => ({ ...f, notes: e.target.value }))
                }
                placeholder="รายละเอียดเพิ่มเติม (ถ้ามี)"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              ยกเลิก
            </Button>
            <Button onClick={onSave} disabled={saving}>
              {saving ? "กำลังบันทึก…" : form.id ? "บันทึก" : "เพิ่มเพลง"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {footer}

      {preview.current && (
        <>
          {/* room to scroll the last song, and the page's footer, out from under
              the fixed player — so this stays the LAST thing in the page */}
          <div aria-hidden className="h-20" />
          <LibraryMiniPlayer
            title={preview.current.title}
            position={preview.position}
            duration={preview.duration}
            playing={preview.playing}
            loading={preview.loading}
            onToggle={preview.toggle}
            onClose={preview.stop}
          />
        </>
      )}
    </div>
  );
}
