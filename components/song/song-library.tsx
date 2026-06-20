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
  Volume2,
  Clock3,
  Lock,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { detectAudioDuration } from "@/lib/audio";
import {
  buildSongAudioPath,
  uploadEventAudio,
  removeEventAudio,
} from "@/lib/audio-remote";
import { formatDuration, parseDurationToSeconds } from "@/lib/time";
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

const NONE = "__none__";
const COPYRIGHT_KEYS = Object.keys(COPYRIGHT_META) as CopyrightStatus[];

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
  editable,
}: {
  tenantId: string;
  groups: Group[];
  initialSongs: Song[];
  editable: boolean;
}) {
  const supabase = createClient();
  const [songs, setSongs] = useState<Song[]>(initialSongs);
  const [groupFilter, setGroupFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [copyFilter, setCopyFilter] = useState<string>("all");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm(groups[0]?.id ?? ""));
  const [saving, setSaving] = useState(false);
  const [detecting, setDetecting] = useState(false);
  // file picked in the add/edit dialog — uploaded to R2 on save (one-step add+upload)
  const [pickedFile, setPickedFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // per-song audio upload (to R2). audioBusy[songId] = which op is running.
  const [audioBusy, setAudioBusy] = useState<Record<string, "up" | "del">>({});
  const audioFileRef = useRef<HTMLInputElement>(null);
  const audioTargetRef = useRef<Song | null>(null);

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
      for (const s of expired) {
        if (s.audio_path) removeEventAudio(s.audio_path).catch(() => {});
        await supabase.from("songs").delete().eq("id", s.id);
      }
      setSongs((prev) => prev.filter((s) => !isExpired(s)));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return songs.filter((s) => {
      if (groupFilter !== "all" && s.group_id !== groupFilter) return false;
      if (copyFilter !== "all" && s.copyright_status !== copyFilter) return false;
      if (
        needle &&
        ![s.title, s.category, s.file_name]
          .filter(Boolean)
          .some((x) => (x as string).toLowerCase().includes(needle))
      )
        return false;
      return true;
    });
  }, [songs, groupFilter, copyFilter, query]);

  function openAdd() {
    setPickedFile(null);
    setForm(emptyForm(groups[0]?.id ?? ""));
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
      copyright_status: form.copyright_status,
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
        toast.error("บันทึกไม่สำเร็จ", { description: error?.message });
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
        toast.error("เพิ่มเพลงไม่สำเร็จ", { description: error?.message });
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
    const warn =
      used > 0
        ? `\n\n⚠️ เพลงนี้ถูกใช้อยู่ใน ${used} รายการของงาน — ลบแล้วงานพวกนั้นจะไม่มีไฟล์เพลงนี้`
        : "";
    if (!window.confirm(`ลบเพลง "${song.title}" ออกจากคลัง?${warn}`)) return;
    const snapshot = songs;
    setSongs((prev) => prev.filter((s) => s.id !== song.id));
    const { error } = await supabase.from("songs").delete().eq("id", song.id);
    if (error) {
      toast.error("ลบไม่สำเร็จ", { description: error.message });
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
    const { error } = await supabase
      .from("songs")
      .update({ copyright_status: status })
      .eq("id", song.id);
    if (error) {
      toast.error("เปลี่ยนสถานะไม่สำเร็จ", { description: error.message });
      setSongs((prev) =>
        prev.map((s) =>
          s.id === song.id ? { ...s, copyright_status: song.copyright_status } : s
        )
      );
    }
  }

  // Tell any open Live Mode (same band) that a song's audio changed, so it
  // re-resolves in real time. Group-scoped broadcast → reaches every device.
  function broadcastSongsChanged(groupId: string) {
    const ch = supabase.channel(`songs:${groupId}`);
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
  async function uploadSongAudio(song: Song, file: File) {
    setAudioBusy((b) => ({ ...b, [song.id]: "up" }));
    try {
      const prevPath = song.audio_path ?? null;
      const path = buildSongAudioPath(song.tenant_id, song.group_id, song.id, file.name);
      await uploadEventAudio(path, file, file.type);
      const { error } = await supabase
        .from("songs")
        .update({ audio_path: path, audio_name: file.name, audio_expires_at: null })
        .eq("id", song.id);
      if (error) throw error;
      setSongs((prev) =>
        prev.map((s) =>
          s.id === song.id
            ? { ...s, audio_path: path, audio_name: file.name, audio_expires_at: null }
            : s
        )
      );
      if (prevPath && prevPath !== path) removeEventAudio(prevPath).catch(() => {});
      broadcastSongsChanged(song.group_id); // live update any open Live Mode
      toast.success("อัปโหลดไฟล์เพลงขึ้นคลังแล้ว 🎵");
    } catch (e) {
      toast.error("อัปโหลดไม่สำเร็จ", {
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

  async function onPickAudioFile(file: File | undefined) {
    const song = audioTargetRef.current;
    if (audioFileRef.current) audioFileRef.current.value = "";
    if (!file || !song) return;
    await uploadSongAudio(song, file);
  }

  async function removeSongAudio(song: Song) {
    if (!song.audio_path) return;
    if (!window.confirm(`ลบไฟล์เสียงของ "${song.title}"? (ข้อมูลเพลงยังอยู่)`)) return;
    setAudioBusy((b) => ({ ...b, [song.id]: "del" }));
    const path = song.audio_path;
    try {
      const { error } = await supabase
        .from("songs")
        .update({ audio_path: null, audio_name: null, audio_expires_at: null })
        .eq("id", song.id);
      if (error) throw error;
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
            placeholder="ค้นหาเพลง / หมวดหมู่…"
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
          {editable && (
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
              {editable && (
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
        <div className="rounded-lg border">
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
                {editable && <TableHead className="w-20" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((song) => {
                const cr = COPYRIGHT_META[song.copyright_status];
                const busy = audioBusy[song.id];
                const hasAudio = !!song.audio_path;
                const tempLeft = song.audio_expires_at
                  ? Math.max(
                      0,
                      Math.ceil(
                        (new Date(song.audio_expires_at).getTime() - Date.now()) /
                          86400000
                      )
                    )
                  : null;
                return (
                  <TableRow key={song.id}>
                    <TableCell>
                      <div className="font-medium">{song.title}</div>
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
                      {busy ? (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          {busy === "up" ? "กำลังอัป…" : "กำลังลบ…"}
                        </span>
                      ) : hasAudio ? (
                        <div className="flex items-center gap-1.5">
                          {tempLeft != null ? (
                            <Badge variant="secondary" className="gap-1">
                              <Clock3 className="h-3 w-3" /> ชั่วคราว {tempLeft}ว.
                            </Badge>
                          ) : (
                            <span className="flex items-center gap-1 text-xs font-medium text-green-600">
                              <Volume2 className="h-3.5 w-3.5" /> มีไฟล์
                            </span>
                          )}
                          {editable && (
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
                      ) : editable ? (
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
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {song.language
                        ? SONG_LANGUAGE_LABELS[song.language] ?? song.language
                        : "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {song.category || "—"}
                    </TableCell>
                    <TableCell>
                      {editable ? (
                        <button
                          type="button"
                          onClick={() => {
                            const order: CopyrightStatus[] = [
                              "pending",
                              "cleared",
                              "rejected",
                            ];
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
                      ) : (
                        <Badge variant={cr.variant}>
                          {cr.emoji} {cr.label}
                        </Badge>
                      )}
                    </TableCell>
                    {groups.length > 1 && (
                      <TableCell className="text-muted-foreground">
                        {groupName[song.group_id] ?? "—"}
                      </TableCell>
                    )}
                    {editable && (
                      <TableCell>
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => openEdit(song)}
                          >
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
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
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

            {groups.length > 1 && (
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
                    {groups.map((g) => (
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
