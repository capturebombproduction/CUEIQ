"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Plus,
  Pencil,
  Trash2,
  Music2,
  FileAudio,
  Loader2,
  Search,
  CloudUpload,
  CloudOff,
  Volume2,
  Clock3,
  Lock,
  FolderInput,
  Undo2,
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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

const NONE = "__none__";
const COPYRIGHT_KEYS = Object.keys(COPYRIGHT_META) as CopyrightStatus[];

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
}: {
  tenantId: string;
  groups: Group[];
  initialSongs: Song[];
  perms: Perms;
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

  const groupName = useMemo(
    () => Object.fromEntries(groups.map((g) => [g.id, g.name])),
    [groups]
  );

  // Lazy cleanup: a temporary (ad-hoc) song past its expiry is purged when the
  // library is opened — file from R2 + the row (linked setlist items lose the
  // link via on-delete-set-null). No background job needed.
  useEffect(() => {
    const now = Date.now();
    const isExpired = (s: Song) =>
      !!s.audio_expires_at && new Date(s.audio_expires_at).getTime() < now;
    const expired = initialSongs.filter(isExpired);
    if (expired.length === 0) return;
    (async () => {
      // DB rows delete first (one shot, mirroring onDelete) — if that fails,
      // leave everything intact and retry on the next open. R2 files only go
      // after the rows are confirmed gone, so a failed delete never leaves a
      // surviving row pointing at a missing file.
      // ...and "confirmed gone" has to mean rows came back, not merely that no
      // error did. This sweep runs on every library open, so it also runs during
      // the anon minute after a reconnect, where the DELETE is RLS-filtered to
      // zero rows with error:null — and the loop below would then delete masters
      // from R2 for rows that are still there, pointing at files that no longer
      // exist. Retrying next open is free; deleting the bytes is not.
      const { data, error } = await supabase
        .from("songs")
        .delete()
        .in("id", expired.map((s) => s.id))
        .select("id");
      if (error || wroteNothing(data)) return;
      const deleted = new Set((data ?? []).map((r) => (r as { id: string }).id));
      for (const s of expired) {
        if (s.audio_path && deleted.has(s.id)) removeEventAudio(s.audio_path).catch(() => {});
      }
      setSongs((prev) => prev.filter((s) => !(isExpired(s) && deleted.has(s.id))));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  }, [songs, groupFilter, copyFilter, query]);

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
      toast.success(form.id ? "บันทึกเพลงแล้ว" : "เพิ่มเพลงแล้ว 🎵");
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
          ? `⚠️ เพลงนี้ถูกใช้อยู่ใน ${used} รายการของงาน — ลบแล้วงานพวกนั้นจะไม่มีไฟล์เพลงนี้`
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
      toast.success("อัปโหลดไฟล์เพลงขึ้นคลังแล้ว 🎵");
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
      toast.success("ใช้ไฟล์ในเครื่องนี้เป็นแหล่งเล่นแล้ว 📁", {
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
      toast.success("กลับไปใช้ต้นฉบับ (R2) แล้ว ☁");
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
  async function promoteSong(song: Song) {
    setSongs((prev) =>
      prev.map((s) => (s.id === song.id ? { ...s, audio_expires_at: null } : s))
    );
    const { error } = await supabase
      .from("songs")
      .update({ audio_expires_at: null })
      .eq("id", song.id);
    if (error) {
      toast.error("เก็บถาวรไม่สำเร็จ", { description: error.message });
      setSongs((prev) =>
        prev.map((s) =>
          s.id === song.id ? { ...s, audio_expires_at: song.audio_expires_at } : s
        )
      );
    } else {
      toast.success("เก็บเป็นเพลงถาวรแล้ว");
    }
  }

  // Days left before a temporary (ad-hoc) audio file expires, or null if permanent.
  const tempDaysLeft = (song: Song) =>
    song.audio_expires_at
      ? Math.max(
          0,
          Math.ceil(
            (new Date(song.audio_expires_at).getTime() - Date.now()) / 86400000
          )
        )
      : null;

  // Per-song render pieces shared by the desktop table and the mobile cards so
  // the two layouts can never drift apart.
  function audioStatus(song: Song) {
    const busy = audioBusy[song.id];
    const hasAudio = !!song.audio_path;
    const songEditable = canEditSong(song);
    const tempLeft = tempDaysLeft(song);
    if (busy) {
      return (
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {busy === "up" ? "กำลังอัป…" : "กำลังลบ…"}
        </span>
      );
    }
    // ⭐#1 step 6 — picked offline, bytes held on this device. Says so plainly
    // instead of "ไม่มีไฟล์เสียง" (a song that has never had a master would
    // otherwise look untouched right after the user just gave it a file).
    if (pendingUploads.has(song.id)) {
      return (
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge
            variant="secondary"
            className="gap-1"
            title="เก็บไฟล์ไว้ในเครื่องนี้แล้ว — เล่นบนเครื่องนี้ได้เลย และจะอัปขึ้นคลังให้เองเมื่อเน็ตกลับ"
          >
            <CloudOff className="h-3 w-3" /> รออัปโหลด
          </Badge>
          {songEditable && (
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9"
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
        <div className="flex flex-wrap items-center gap-1.5">
          {tempLeft != null ? (
            <Badge variant="secondary" className="gap-1">
              <Clock3 className="h-3 w-3" /> ชั่วคราว {tempLeft}ว.
            </Badge>
          ) : (
            <span className="flex items-center gap-1 text-xs font-medium text-green-600">
              <Volume2 className="h-3.5 w-3.5" /> มีไฟล์
            </span>
          )}
          {songEditable && (
            <>
              {tempLeft != null && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  title="เก็บเป็นเพลงถาวร (ไม่ให้หมดอายุ)"
                  onClick={() => promoteSong(song)}
                >
                  <Lock className="h-3.5 w-3.5" />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                title="เปลี่ยนไฟล์เสียง"
                onClick={() => {
                  audioTargetRef.current = song;
                  audioFileRef.current?.click();
                }}
              >
                <CloudUpload className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-destructive hover:text-destructive"
                title="ลบไฟล์เสียง"
                onClick={() => removeSongAudio(song)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </>
          )}
        </div>
      );
    }
    if (songEditable) {
      return (
        <Button
          variant="outline"
          size="sm"
          className="h-7"
          onClick={() => {
            audioTargetRef.current = song;
            audioFileRef.current?.click();
          }}
        >
          <CloudUpload className="h-3.5 w-3.5" /> อัปไฟล์
        </Button>
      );
    }
    return <span className="text-xs text-muted-foreground">—</span>;
  }

  function copyrightControl(song: Song) {
    const cr = COPYRIGHT_META[song.copyright_status];
    if (approver) {
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
        >
          <Badge
            variant={cr.variant}
            className="cursor-pointer transition hover:opacity-80"
          >
            {cr.emoji} {cr.label}
          </Badge>
        </button>
      );
    }
    return (
      <Badge variant={cr.variant}>
        {cr.emoji} {cr.label}
      </Badge>
    );
  }

  function rowActions(song: Song) {
    if (!canEditSong(song)) return null;
    return (
      <>
        <Button variant="ghost" size="icon" onClick={() => openEdit(song)}>
          <Pencil className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="text-destructive hover:text-destructive"
          onClick={() => onDelete(song)}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </>
    );
  }

  return (
    <div className="space-y-4">
      {/* hidden input for per-song audio upload to R2 (separate from the
          dialog's duration-detect picker) */}
      <input
        ref={audioFileRef}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={(e) => onPickAudioFile(e.target.files?.[0])}
      />
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="ค้นหาเพลง / หมวดหมู่ / โน้ต…"
            className="pl-9"
          />
        </div>
        {groups.length > 1 && (
          <div className="w-40">
            <Select value={groupFilter} onValueChange={setGroupFilter}>
              <SelectTrigger>
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
        <div className="w-40">
          <Select value={copyFilter} onValueChange={setCopyFilter}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">ลิขสิทธิ์: ทั้งหมด</SelectItem>
              <SelectItem value="cleared">✅ ถูกต้อง</SelectItem>
              <SelectItem value="pending">🕒 รอตรวจ</SelectItem>
              <SelectItem value="rejected">⛔ ถูกปฏิเสธ</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="tabular-nums text-xs text-muted-foreground">
            {visible.length} เพลง
          </span>
          {canEditAny && (
            <Button onClick={openAdd}>
              <Plus className="h-4 w-4" /> เพิ่มเพลง
            </Button>
          )}
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed py-16 text-center">
          <Music2 className="h-10 w-10 text-muted-foreground" />
          {songs.length === 0 ? (
            <>
              <p className="text-muted-foreground">ยังไม่มีเพลงในคลัง</p>
              {canEditAny && (
                <Button variant="outline" onClick={openAdd}>
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
          {/* Desktop / tablet: full table */}
          <div className="hidden rounded-lg border md:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>เพลง</TableHead>
                <TableHead className="w-24 text-right tabular-nums">
                  ความยาว
                </TableHead>
                <TableHead className="w-44">เสียง (คลาวด์)</TableHead>
                <TableHead className="w-20">ภาษา</TableHead>
                <TableHead className="w-32">หมวดหมู่</TableHead>
                <TableHead className="w-28">ลิขสิทธิ์</TableHead>
                {groups.length > 1 && <TableHead className="w-28">วง</TableHead>}
                {canEditAny && <TableHead className="w-20" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((song) => (
                  <TableRow key={song.id}>
                    <TableCell>
                      <div className="font-medium">{song.title}</div>
                      {/* โน้ตของเพลง — until now it was write-only (visible only by
                          reopening the edit dialog). Clamped so a long note can't
                          blow the row height up; the full text stays reachable via
                          the tooltip, and the mobile card prints it whole. */}
                      {song.notes && (
                        <div
                          className="line-clamp-2 whitespace-pre-wrap break-words text-xs text-muted-foreground"
                          title={song.notes}
                        >
                          {song.notes}
                        </div>
                      )}
                      {song.file_name && (
                        <div className="flex items-center gap-1 text-xs text-muted-foreground">
                          <FileAudio className="h-3 w-3" />
                          {song.file_name}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {song.duration_seconds
                        ? formatDuration(song.duration_seconds)
                        : "—"}
                    </TableCell>
                    <TableCell>
                      <div className="space-y-1.5">
                        {audioStatus(song)}
                        {localSourceControls(song)}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {song.language
                        ? SONG_LANGUAGE_LABELS[song.language] ?? song.language
                        : "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {song.category || "—"}
                    </TableCell>
                    <TableCell>{copyrightControl(song)}</TableCell>
                    {groups.length > 1 && (
                      <TableCell className="text-muted-foreground">
                        {groupName[song.group_id] ?? "—"}
                      </TableCell>
                    )}
                    {canEditAny && (
                      <TableCell>
                        <div className="flex justify-end gap-1">
                          {rowActions(song)}
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
              ))}
            </TableBody>
          </Table>
          </div>

          {/* Mobile: one card per song so nothing scrolls sideways */}
          <div className="space-y-3 md:hidden">
            {visible.map((song) => (
              <div
                key={song.id}
                className="space-y-3 rounded-lg border bg-card p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium leading-tight">{song.title}</div>
                    {/* Full text, no clamp: a card grows, and a phone has no
                        hover to reveal a tooltip with the rest. */}
                    {song.notes && (
                      <div className="mt-0.5 whitespace-pre-wrap break-words text-xs text-muted-foreground">
                        {song.notes}
                      </div>
                    )}
                    {song.file_name && (
                      <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                        <FileAudio className="h-3 w-3 shrink-0" />
                        <span className="truncate">{song.file_name}</span>
                      </div>
                    )}
                  </div>
                  {canEditAny && (
                    <div className="flex shrink-0 gap-1">{rowActions(song)}</div>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
                  <span className="tabular-nums">
                    ⏱{" "}
                    {song.duration_seconds
                      ? formatDuration(song.duration_seconds)
                      : "—"}
                  </span>
                  {song.language && (
                    <span>
                      {SONG_LANGUAGE_LABELS[song.language] ?? song.language}
                    </span>
                  )}
                  {song.category && <span>{song.category}</span>}
                  {groups.length > 1 && groupName[song.group_id] && (
                    <span>{groupName[song.group_id]}</span>
                  )}
                </div>

                <div className="space-y-2 border-t pt-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    {audioStatus(song)}
                    {copyrightControl(song)}
                  </div>
                  {localSourceControls(song)}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{form.id ? "แก้ไขเพลง" : "เพิ่มเพลง"}</DialogTitle>
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
                        {COPYRIGHT_META[k].emoji} {COPYRIGHT_META[k].label}
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
    </div>
  );
}
