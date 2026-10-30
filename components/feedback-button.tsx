"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  MessageSquarePlus,
  Loader2,
  Bug,
  Lightbulb,
  MessageCircle,
  ImagePlus,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { APP_VERSION } from "@/lib/app-version";
import { isQueueableWriteError } from "@/lib/mgmt-outbox";
import { writeErrorText } from "@/lib/write-guard";
import {
  FEEDBACK_IMAGE_EXTS,
  buildFeedbackImagePath,
  uploadEventAudio,
} from "@/lib/audio-remote";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  FEEDBACK_UNREAD_EVENT,
  MyFeedbackList,
  announceFeedbackSent,
} from "@/components/my-feedback-list";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Category = "bug" | "idea" | "other";

const CATS: { value: Category; label: string; icon: typeof Bug }[] = [
  { value: "bug", label: "พบปัญหา/บั๊ก", icon: Bug },
  { value: "idea", label: "ไอเดีย/อยากได้เพิ่ม", icon: Lightbulb },
  { value: "other", label: "อื่น ๆ", icon: MessageCircle },
];

/** A phone screenshot is ~200 KB–2 MB; three of them is plenty to show a bug, and
 *  the cap keeps a stray 40 MB photo out of a bucket whose free tier the whole
 *  label's audio also lives in. */
const MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** Past this a screenshot upload is not coming back — do not hold the report (or
 *  the modal, which covers the whole app) hostage to it. */
const UPLOAD_TIMEOUT_MS = 60_000;

/** The unsent report: what the person typed, its category and the screenshots. */
type Draft = { category: Category; message: string; files: File[] };
const EMPTY_DRAFT: Draft = { category: "bug", message: "", files: [] };

type UnreadState = {
  unread: number;
  setUnread: Dispatch<SetStateAction<number>>;
  draft: Draft;
  setDraft: Dispatch<SetStateAction<Draft>>;
  /** A send of `draft` is still in flight (see FeedbackUnreadProvider). */
  sending: boolean;
  setSending: Dispatch<SetStateAction<boolean>>;
};
const FeedbackUnreadContext = createContext<UnreadState | null>(null);

/**
 * "An answer is waiting" — one count for the whole app shell.
 *
 * This lived inside the floating แจ้งปัญหา button, which was mounted on every page
 * and so could own it. The redesign removed that button: the report form now opens
 * from the More sheet's Feedback tile, which only exists while the sheet is open.
 * Left inside it, the dot would have been fetched only after somebody opened the
 * sheet — i.e. never shown to the person who needed telling. So the count lives
 * here, mounted once by the (app) layout and the desktop shell, and three places
 * read it: the More tab's dot, the header avatar's dot and the Feedback tile.
 *
 * Cheap, once per mount (the layouts persist across navigations), exactly as before.
 *
 * The UNSENT REPORT lives here too, for the same reason. The floating button kept
 * the draft for the layout's lifetime; the tile unmounts with the More sheet (which
 * also closes on every page change). Held inside the tile, a report that failed to
 * send offline — whose toast promises "ข้อความยังอยู่ในกล่อง" — was wiped the moment
 * the member closed the sheet to get back to the show.
 *
 * …and so does the fact that it is BEING SENT (2026-10-27, hunt 6). The dialog invites
 * closing mid-send ("ปิดหน้าต่าง") and the sheet unmounts the tile, so a "sending" flag
 * held in the tile came back false on the next open: the same text with ส่ง enabled
 * while the first send was still uploading its screenshot - pressed again, the report
 * was filed twice, and whatever was typed meanwhile was wiped by the first send's
 * success. The flag lives beside the draft it guards.
 */
export function FeedbackUnreadProvider({
  userId,
  children,
}: {
  userId?: string | null;
  children: React.ReactNode;
}) {
  const [unread, setUnread] = useState(0);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [sending, setSending] = useState(false);
  // A list that read (or stamped) this person's answers says how many are unread now -
  // the /feedback page's own list included (FEEDBACK_UNREAD_EVENT). Newer than the
  // mount read below whenever it arrives after that read STARTED.
  const listSaidRef = useRef(0);
  useEffect(() => {
    const onUnread = (e: Event) => {
      const n = (e as CustomEvent<number>).detail;
      if (typeof n !== "number") return;
      listSaidRef.current += 1;
      setUnread(n);
    };
    window.addEventListener(FEEDBACK_UNREAD_EVENT, onUnread);
    return () => window.removeEventListener(FEEDBACK_UNREAD_EVENT, onUnread);
  }, []);
  useEffect(() => {
    if (!userId) return;
    let alive = true;
    const asked = listSaidRef.current;
    createClient()
      .from("feedback")
      .select("id")
      .eq("user_id", userId)
      .not("reply", "is", null)
      .is("reply_seen_at", null)
      .then(({ data }) => {
        // a list that answered meanwhile knows better than this read
        if (alive && data && listSaidRef.current === asked) setUnread(data.length);
      });
    return () => {
      alive = false;
    };
  }, [userId]);
  return (
    <FeedbackUnreadContext.Provider value={{ unread, setUnread, draft, setDraft, sending, setSending }}>
      {children}
    </FeedbackUnreadContext.Provider>
  );
}

/** Unread answers waiting for this account (0 outside a FeedbackUnreadProvider). */
export function useFeedbackUnread(): number {
  return useContext(FeedbackUnreadContext)?.unread ?? 0;
}

/**
 * In-app feedback / bug-report channel — open to EVERY logged-in user (the point
 * is to gather real-use feedback from band members during live shows). Stores into
 * public.feedback with the page + build auto-attached so the team can fix the
 * right spot. Self-contained (Supabase + R2, no external service).
 *
 * ⚠️ ONE FILE, TWO APPS. The desktop shell mounts this exact module through vite's
 * "@" → repo-root alias, so everything here must work under file:// in Electron:
 * no Next imports, and the Supabase client stays imported as `@/lib/supabase/client`
 * (aliased to the desktop's localStorage-backed client — a relative import would
 * silently make every query run as ANON).
 *
 * SINCE 2026-08-31 IT IS A TWO-WAY CHANNEL. Five reports sat in the table for two
 * months, three of them fixed, and not one person who wrote in was ever told —
 * which is how a feedback channel dies. "ที่ส่งไปแล้ว" shows the author their own
 * reports and the admin's answer, and the button carries a dot when an answer is
 * waiting. Attachments were asked for by name on 2026-08-13.
 *
 * SINCE THE REDESIGN (v2) IT IS A TILE, never a floating button: it renders as the
 * Feedback tile of the account panel's destinations grid, and its unread count
 * comes from FeedbackUnreadProvider above.
 */
export function FeedbackButton({
  userId,
  tenantId,
}: {
  userId?: string | null;
  tenantId?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"new" | "mine">("new");
  // No provider → no count and no fetch: the shells always mount one, and a
  // second, private fetch here would be a second source of truth for one dot.
  const shared = useContext(FeedbackUnreadContext);
  // "Sending" is the shell's too, like the draft it guards (see FeedbackUnreadProvider):
  // a tile reopened mid-send must still know the draft is on its way.
  const [localBusy, setLocalBusy] = useState(false);
  const busy = shared ? shared.sending : localBusy;
  const setBusy = shared?.setSending ?? setLocalBusy;
  const unread = shared?.unread ?? 0;
  const setUnread: Dispatch<SetStateAction<number>> = shared?.setUnread ?? (() => {});
  // The draft is the shell's (see FeedbackUnreadProvider), so it outlives this tile;
  // a local one only where no provider is mounted.
  const [localDraft, setLocalDraft] = useState<Draft>(EMPTY_DRAFT);
  const setDraft = shared?.setDraft ?? setLocalDraft;
  const { category, message, files } = shared?.draft ?? localDraft;
  const setCategory = (c: Category) => setDraft((d) => ({ ...d, category: c }));
  const setMessage = (m: string) => setDraft((d) => ({ ...d, message: m }));
  const setFiles = (next: SetStateAction<File[]>) =>
    setDraft((d) => ({ ...d, files: typeof next === "function" ? next(d.files) : next }));
  // Remount the list on each submit so a brand-new report shows without reopening.
  const [listRev, setListRev] = useState(0);
  const fileInput = useRef<HTMLInputElement | null>(null);
  // Object URLs for the not-yet-uploaded previews, revoked on replace/unmount.
  const previews = useRef(new Map<File, string>());

  const previewUrl = (f: File) => {
    let u = previews.current.get(f);
    if (!u) {
      u = URL.createObjectURL(f);
      previews.current.set(f, u);
    }
    return u;
  };
  useEffect(() => {
    const held = previews.current;
    return () => {
      held.forEach((u) => URL.revokeObjectURL(u));
      held.clear();
    };
  }, []);

  function addFiles(picked: FileList | null) {
    if (!picked?.length) return;
    const room = MAX_IMAGES - files.length;
    if (room <= 0) {
      toast.error(`แนบได้สูงสุด ${MAX_IMAGES} รูป`);
      return;
    }
    const accepted: File[] = [];
    for (const f of Array.from(picked).slice(0, room)) {
      const ext = /\.([a-z0-9]+)$/i.exec(f.name)?.[1]?.toLowerCase() ?? "";
      if (!f.type.startsWith("image/") && !(FEEDBACK_IMAGE_EXTS as readonly string[]).includes(ext)) {
        toast.error("แนบได้เฉพาะรูปภาพ", { description: f.name });
        continue;
      }
      if (f.size > MAX_IMAGE_BYTES) {
        toast.error("รูปใหญ่เกินไป (เกิน 8 MB)", { description: f.name });
        continue;
      }
      accepted.push(f);
    }
    if (accepted.length) setFiles((prev) => [...prev, ...accepted]);
  }

  function removeFile(f: File) {
    const u = previews.current.get(f);
    if (u) {
      URL.revokeObjectURL(u);
      previews.current.delete(f);
    }
    setFiles((prev) => prev.filter((x) => x !== f));
  }

  if (!userId || !tenantId) return null;

  async function submit() {
    const msg = message.trim();
    if (msg.length < 3) {
      toast.error("พิมพ์รายละเอียดสักนิดนะครับ");
      return;
    }
    setBusy(true);
    try {
      // Bytes FIRST, row second: the row then lists only what actually landed, so
      // "ที่ส่งไปแล้ว" never shows a placeholder for a picture that was never
      // uploaded. An upload that fails must not cost the person their report —
      // the words are the valuable part — so it is reported and the text still goes.
      const keys: string[] = [];
      let uploadFailures = 0;
      for (const f of files) {
        const key = buildFeedbackImagePath(tenantId!, userId!, f.name);
        try {
          // BOUNDED TIGHTER. uploadEventAudio's own deadline is sized for 88 MB
          // masters (two minutes at the least); on a black-holed venue AP this dialog
          // would sit that long in front of the whole app — including a running show
          // — with every way out disabled. A screenshot is a few hundred KB: past a
          // minute it is not coming back.
          await Promise.race([
            uploadEventAudio(key, f, f.type),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("upload timeout")), UPLOAD_TIMEOUT_MS)
            ),
          ]);
          keys.push(key);
        } catch {
          uploadFailures += 1;
        }
      }

      const supabase = createClient();
      const { error } = await supabase.from("feedback").insert({
        tenant_id: tenantId,
        user_id: userId,
        category,
        message: msg.slice(0, 4000),
        images: keys,
        context: {
          path:
            typeof location !== "undefined"
              ? location.pathname + location.hash
              : null,
          commit: APP_VERSION,
          ua:
            typeof navigator !== "undefined"
              ? navigator.userAgent.slice(0, 300)
              : null,
        },
      });
      // A refused insert in Thai (2026-10-30, hunt 10): sent as anon - a laptop just woken,
      // its token refresh not through yet - feedback_insert's check failed and the toast read
      // 'new row violates row-level security policy for table "feedback"'. Network failures
      // keep their own message, so the offline toast below still recognises them. Not
      // writeErrorText's "โหลดหน้าใหม่": a reload wipes the typed text (it lives in memory).
      if (error)
        throw new Error(
          writeErrorText(error) !== error.message
            ? "เซสชันหมดอายุชั่วคราว ข้อความยังอยู่ — รอสักครู่แล้วกดส่งอีกครั้ง"
            : error.message
        );
      if (uploadFailures > 0) {
        toast.warning(`ส่งข้อความแล้ว แต่แนบรูปไม่สำเร็จ ${uploadFailures} รูป`, {
          description: "ลองส่งรูปอีกครั้งเมื่อสัญญาณดีขึ้นได้ครับ",
        });
      } else {
        toast.success("ส่งฟีดแบคแล้ว — ขอบคุณมากครับ 🙏");
      }
      setMessage("");
      setCategory("bug");
      files.forEach((f) => {
        const u = previews.current.get(f);
        if (u) URL.revokeObjectURL(u);
        previews.current.delete(f);
      });
      setFiles([]);
      setOpen(false);
      setListRev((n) => n + 1);
      // …and every other mounted list (the /feedback page's own) re-reads too.
      announceFeedbackSent();
    } catch (e) {
      // A venue with no signal is this button's NORMAL habitat (see the doc
      // comment above) — a bare "TypeError: Failed to fetch" toast title reads
      // as gibberish to a band member and the report is then just lost. Detect
      // the network case the same way the outbox call sites do and give it a
      // Thai headline; the typed text stays in the box either way (only the
      // success path above clears it), so nothing is lost to retype later.
      const msg = e instanceof Error ? e.message : null;
      const onLine = typeof navigator === "undefined" || navigator.onLine !== false;
      if (isQueueableWriteError(msg, onLine)) {
        toast.error("ออฟไลน์อยู่ — ส่งไม่สำเร็จ", {
          description: "ข้อความยังอยู่ในกล่อง ลองส่งอีกครั้งเมื่อเน็ตกลับมา",
        });
      } else {
        toast.error("ส่งไม่สำเร็จ", { description: msg ?? undefined });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {/* The More sheet's Feedback tile. `title` doubles as the tests' handle
          (/แจ้งปัญหา|มีคำตอบ/). With an answer waiting the tile says so in words and
          carries a red rail + dot — never colour alone. */}
      <button
        type="button"
        title={unread > 0 ? "มีคำตอบจากทีมงาน" : "ส่งฟีดแบค / แจ้งปัญหา"}
        onClick={() => setOpen(true)}
        className={cn(
          "well relative flex min-h-[94px] w-full flex-col items-start rounded-[2px] p-3 text-left transition-colors duration-2 hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          unread > 0 && "shadow-[inset_3px_0_0_hsl(var(--notify))]"
        )}
      >
        <MessageCircle className="h-[22px] w-[22px] text-primary-ink" aria-hidden />
        {unread > 0 && (
          <i
            data-testid="feedback-unread-dot"
            aria-hidden
            className="dot right-3 top-3 h-2.5 w-2.5 shadow-[0_0_0_2px_hsl(var(--muted))]"
          />
        )}
        <span className="caps mt-2 text-[19px] leading-none tracking-[.03em]">Feedback</span>
        <span
          className={cn(
            "mt-1 text-[11.5px] leading-snug",
            unread > 0 ? "font-semibold text-foreground" : "text-faint"
          )}
        >
          {unread > 0 ? `แจ้งปัญหา · มีคำตอบใหม่ ${unread}` : "แจ้งปัญหา"}
        </span>
      </button>

      {/* NOT gated on `busy`. While an attachment was uploading, this modal sealed
          itself shut — Escape, the overlay and the X all inert, both footer buttons
          disabled — and its overlay covers the entire app, Live Mode included. The
          send button stays disabled so closing cannot double-submit; the upload and
          its toast simply finish in the background. */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Feedback</DialogTitle>
            <DialogDescription>
              เจอบั๊ก อยากได้อะไรเพิ่ม หรือใช้แล้วติดตรงไหน บอกได้เลย — ทีมจะเอาไปพัฒนาต่อ
            </DialogDescription>
          </DialogHeader>

          {/* Plain buttons rather than Radix Tabs: the fewer contexts this dialog
              needs, the fewer ways it can white-screen the desktop app. */}
          <div className="seg">
            <button
              type="button"
              onClick={() => setTab("new")}
              className={cn("transition-colors duration-2", tab === "new" && "on")}
            >
              ส่งใหม่
            </button>
            <button
              type="button"
              data-testid="feedback-tab-mine"
              onClick={() => setTab("mine")}
              className={cn("transition-colors duration-2", tab === "mine" && "on")}
            >
              ที่ส่งไปแล้ว
              {unread > 0 && (
                <span className="num inline-grid h-[18px] min-w-[18px] place-items-center rounded-full bg-notify px-1 text-[13px] leading-none text-notify-foreground">
                  {unread}
                </span>
              )}
            </button>
          </div>

          {tab === "new" ? (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>ประเภท</Label>
                <div className="flex flex-wrap gap-2">
                  {CATS.map((c) => {
                    const Icon = c.icon;
                    return (
                      <button
                        key={c.value}
                        type="button"
                        onClick={() => setCategory(c.value)}
                        disabled={busy}
                        aria-pressed={category === c.value}
                        className={cn(
                          "chip chip-lg transition-colors duration-2",
                          category === c.value ? "chip-solid" : "chip-neutral"
                        )}
                      >
                        <Icon aria-hidden /> {c.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="fb-msg">รายละเอียด</Label>
                <textarea
                  id="fb-msg"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  // what is on its way cannot change under it: the success clears this
                  // box, and anything typed during the send went with it (2026-10-27)
                  disabled={busy}
                  rows={5}
                  placeholder="อธิบายสั้น ๆ ก็ได้ครับ เช่น กดปุ่มนี้แล้วเสียงไม่เล่น…"
                  // the one raw textarea in the app, so it needs the 16px-on-phones
                  // rule components/ui/textarea.tsx carries — and this is the field
                  // people type into FROM a phone, to report the bug they just hit
                  className="min-h-[96px] w-full rounded-[3px] bg-card px-3.5 py-2.5 text-base leading-relaxed shadow-[inset_0_0_0_1.5px_hsl(var(--input))] placeholder:text-faint focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_2px_hsl(var(--ring))] disabled:opacity-60 sm:text-sm"
                />
              </div>

              <div className="space-y-1.5">
                <Label>รูปประกอบ (ไม่บังคับ)</Label>
                <div className="flex flex-wrap items-center gap-2">
                  {files.map((f) => (
                    <div key={`${f.name}-${f.size}-${f.lastModified}`} className="relative">
                      {/* eslint-disable-next-line @next/next/no-img-element -- local
                          blob preview; next/image cannot take one and does not exist
                          in the Electron renderer this file also runs in. */}
                      <img
                        src={previewUrl(f)}
                        alt={f.name}
                        className="h-20 w-20 rounded-md border object-cover"
                      />
                      <button
                        type="button"
                        title="เอารูปนี้ออก"
                        onClick={() => removeFile(f)}
                        disabled={busy}
                        className="absolute -right-1.5 -top-1.5 rounded-full bg-destructive p-0.5 text-destructive-foreground shadow"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                  {files.length < MAX_IMAGES && (
                    <button
                      type="button"
                      data-testid="feedback-add-image"
                      onClick={() => fileInput.current?.click()}
                      disabled={busy}
                      className="flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-md border border-dashed text-xs text-muted-foreground transition-colors hover:bg-muted"
                    >
                      <ImagePlus className="h-4 w-4" />
                      แนบรูป
                    </button>
                  )}
                  <input
                    ref={fileInput}
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      addFiles(e.target.files);
                      e.target.value = ""; // so the same file can be picked again
                    }}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  แนบหน้าที่เปิดอยู่ + รุ่นแอปให้อัตโนมัติ เพื่อให้แก้ได้ตรงจุด · รูปได้สูงสุด {MAX_IMAGES} รูป
                </p>
              </div>
            </div>
          ) : (
            <MyFeedbackList
              key={listRev}
              userId={userId}
              onSeen={(n) => setUnread((u) => Math.max(0, u - n))}
            />
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {tab === "mine" ? "ปิด" : busy ? "ปิดหน้าต่าง" : "ยกเลิก"}
            </Button>
            {tab === "new" && (
              <Button onClick={submit} disabled={busy}>
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <MessageSquarePlus className="h-4 w-4" />
                )}
                ส่ง
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
