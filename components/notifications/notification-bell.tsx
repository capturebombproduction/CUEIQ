"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, Check, BellRing, Loader2, Ban } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { applicationServerKeyMatches } from "@/lib/push-key-match";
import { urlBase64ToUint8Array, vapidPublicKey } from "@/lib/push-client";
import { enablePush as subscribeToPush } from "@/lib/push-subscribe";
import { hasLiveSession } from "@/lib/auth-session";
import { wroteNothing, noRowsMessage } from "@/lib/write-guard";
import {
  acknowledgeUnsavedWork,
  commitFocusedField,
  unsavedWork,
  unsavedWorkMessageFor,
} from "@/lib/dirty-guard";
import {
  eventIdFromLink,
  mayMarkRead,
  notificationReachability,
  UNREACHABLE_NOTE,
} from "@/lib/dead-link";
import { cn, safeInternalPath } from "@/lib/utils";

interface NotifRow {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  read_at: string | null;
  created_at: string;
}

type PushState = "unsupported" | "default" | "on" | "denied";

// How long a click may wait for the reachability probe that is already in flight
// before it gives up and fails open. A tap must never hang on a venue AP that is
// associated but black-holed — the same bound the rest of the venue code puts on a
// round trip it cannot afford to wait out (live-mode's device-claim race).
const PROBE_WAIT_MS = 1500;

// Read through a try/catch: the bundler inlines this literal (web = the build env,
// desktop = vite `define`) — see lib/push-client.ts for why reading it must stay
// inside a function, and lib/push-subscribe.ts for the subscribe sequence this
// component no longer owns alone.
const VAPID_PUBLIC = vapidPublicKey();

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "เมื่อสักครู่";
  if (m < 60) return `${m} นาทีที่แล้ว`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ชม.ที่แล้ว`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} วันก่อน`;
  return new Date(iso).toLocaleDateString("th-TH", { day: "numeric", month: "short" });
}

export function NotificationBell({
  userId,
  tenantId,
}: {
  userId: string;
  tenantId: string;
}) {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const [items, setItems] = useState<NotifRow[]>([]);
  const [open, setOpen] = useState(false);
  const [pushState, setPushState] = useState<PushState>("default");
  const [pushBusy, setPushBusy] = useState(false);
  // Which of the events these items link to can this user actually OPEN — TAGGED
  // WITH THE QUESTION IT ANSWERS (`key` is the eventIdKey the probe was fired for).
  // A bare set was wrong: a brand-new item's event id got judged against the
  // PREVIOUS probe's set, so an approval that arrived on the 45s poll painted greyed
  // with "งานนี้ถูกลบไปแล้ว" and refused to open until the next probe landed — a false
  // "deleted" on the one item the user was waiting for. Clearing the state from
  // inside the probe effect does not fix that: effects run AFTER paint, so the stale
  // answer still reaches the screen. Comparing keys during render makes an id nobody
  // has asked about yet "unknown" (→ navigate, the documented fail-open) from the
  // very first render that contains it.
  //
  // null = "we don't know" and MUST behave exactly like the app did before
  // (navigate); see the probe effect below for why null is the honest answer more
  // often than it looks.
  const [probe, setProbe] = useState<{
    key: string;
    ids: ReadonlySet<string>;
  } | null>(null);
  // The probe REQUEST — the same promise `probe` above is set from, tagged with the
  // same question, kept so a click that lands while it is still on the wire can wait
  // for this answer instead of guessing. State is no use for that: it only exists
  // after the request resolves, and the window this bug lives in is the window
  // before it does. See openItem.
  const probeRunRef = useRef<{
    key: string;
    run: Promise<ReadonlySet<string> | null>;
  } | null>(null);
  // Bumped to re-ask a question that came back untrusted — see the probe effect.
  const [probeNonce, setProbeNonce] = useState(0);
  // Did the last probe answer `null`? Held in a ref rather than read off `probe` so
  // the retry listener below can subscribe once instead of re-subscribing every time
  // a probe resolves.
  const probeUntrustedRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // How many rows the last TRUSTED read returned — see load() for why an empty
  // answer that would erase a non-empty bell is not trusted on its own.
  const countRef = useRef(0);

  const unread = items.filter((i) => !i.read_at).length;

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("notifications")
      .select("id, type, title, body, link, read_at, created_at")
      .order("created_at", { ascending: false })
      .limit(30);
    if (!data) return;
    // An empty read is not an empty table. This poll fires every 45s and on every
    // focus — including the moment a venue reconnect lands, when supabase-js has
    // fallen back to the anon key (getSession() null, a failed refresh cached for a
    // minute) and RLS answers `[]` with error: null. Replacing a bell that HAD items
    // with that answer wipes the list and the unread badge for no reason. A first,
    // genuinely empty load is both cheap and correct to accept — only refuse to
    // REPLACE content with emptiness, and only until we've confirmed the session.
    if (data.length === 0 && countRef.current > 0 && !(await hasLiveSession())) return;
    countRef.current = data.length;
    setItems(data as NotifRow[]);
  }, [supabase]);

  // initial load + poll on focus/visibility + a slow interval (no realtime: RLS
  // postgres_changes don't deliver on the publishable key, so we poll).
  useEffect(() => {
    load();
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    const iv = setInterval(load, 45000);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      clearInterval(iv);
    };
  }, [load]);

  // The distinct event ids these items point at, as a stable string so the probe
  // below re-runs when the SET changes and not merely because the 45s poll handed
  // us a fresh array with identical contents.
  const eventIdKey = useMemo(() => {
    const ids = new Set<string>();
    for (const n of items) {
      const id = eventIdFromLink(n.link);
      if (id) ids.add(id);
    }
    return Array.from(ids).sort().join(",");
  }, [items]);

  // An answer that was given for a DIFFERENT set of ids is not an answer to this
  // question — it is "don't know". See the comment on `probe`.
  const viewableEventIds = probe && probe.key === eventIdKey ? probe.ids : null;

  // Which of those events are still readable by this user.
  //
  // WHY THIS EXISTS: notifications.link is plain text with no FK to events
  // (0021_notifications.sql) and deleting an event deletes only the event, so every
  // deleted show leaves its approve/reject notifications pointing at a row that is
  // gone. Production carries 8 such rows right now, and for one Ar account they are
  // the ENTIRE bell: clicking marked them read FIRST and then dropped the user on a
  // 404, so the only content that account had vanished into a page that does not
  // exist. Deleting the rows would not fix it — deleting an event will keep making
  // them — so the render path is where this belongs.
  //
  // WHY THE ANSWER IS OFTEN "DON'T KNOW": this read is RLS-scoped, and an id that
  // comes back missing means EITHER the event was deleted OR this user may not see
  // that band. Both end at notFound(), so both must stop the click — but an empty
  // read is not an empty table. supabase-js substitutes the anon key whenever
  // getSession() returns null (a failed refresh is cached for a minute — exactly the
  // window a venue reconnect lands in) and RLS then answers `[]` with error: null.
  // Believing that would gray out every item in a perfectly healthy bell. So a
  // wholly-empty answer is only trusted after hasLiveSession() confirms we still
  // have a session; a partial answer proves it by itself.
  //
  // AND "DON'T KNOW" IS NOT A VERDICT TO KEEP. Nothing else here can re-ask:
  // eventIdKey is a primitive that the 45s poll rebuilds to the SAME string, and the
  // bell lives in the header, so it survives every in-app navigation — one untrusted
  // answer would otherwise hold for the whole session, greying switched off and every
  // tap re-navigating without clearing the badge (mayMarkRead("unknown") is false).
  // probeNonce re-asks. It is bumped only from focus/visibility (see below), which is
  // when a session that had gone stale has usually been refreshed, and being
  // user-driven it cannot turn into a poll.
  useEffect(() => {
    const ids = eventIdKey ? eventIdKey.split(",") : [];
    if (ids.length === 0) {
      probeRunRef.current = null;
      probeUntrustedRef.current = false;
      setProbe(null);
      return;
    }
    let cancelled = false;
    // One promise, two consumers: the state below (which drives the greying) and
    // openItem (which may need the answer before the state exists). It resolves to
    // null for every untrustworthy outcome, which is the same "don't know" the state
    // carries as null — one rule, written once.
    const run: Promise<ReadonlySet<string> | null> = (async () => {
      const { data, error } = await supabase.from("events").select("id").in("id", ids);
      if (error || !data) return null;
      if (data.length === 0 && !(await hasLiveSession())) return null;
      return new Set(data.map((r) => r.id as string)) as ReadonlySet<string>;
    })().catch(() => null);
    probeRunRef.current = { key: eventIdKey, run };
    void run.then((viewable) => {
      if (cancelled) return;
      probeUntrustedRef.current = !viewable;
      setProbe(viewable ? { key: eventIdKey, ids: viewable } : null);
    });
    return () => {
      cancelled = true;
    };
  }, [eventIdKey, probeNonce, supabase]);

  // Re-ask ONLY after an untrusted answer, and only on the same focus/visibility
  // signals the notification poll already uses. Deliberately not a timer: a probe
  // that succeeded must not be re-run (a later `null` would throw away a trusted
  // answer), and a backgrounded tab must not talk to the network at all.
  useEffect(() => {
    const retry = () => {
      if (probeUntrustedRef.current && document.visibilityState === "visible") {
        setProbeNonce((n) => n + 1);
      }
    };
    window.addEventListener("focus", retry);
    document.addEventListener("visibilitychange", retry);
    return () => {
      window.removeEventListener("focus", retry);
      document.removeEventListener("visibilitychange", retry);
    };
  }, []);

  // detect Web Push availability/state (no SW in dev → "unsupported")
  useEffect(() => {
    (async () => {
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !VAPID_PUBLIC) {
        setPushState("unsupported");
        return;
      }
      if (Notification.permission === "denied") return setPushState("denied");
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) return setPushState("unsupported");
      const sub = await reg.pushManager.getSubscription();
      if (
        sub &&
        !applicationServerKeyMatches(
          sub.options.applicationServerKey,
          urlBase64ToUint8Array(VAPID_PUBLIC)
        )
      ) {
        // Bound to a VAPID key the server has since rotated away from — this
        // subscription looks alive (permission stays "granted") but push can
        // never land on it again. Drop it so the enable button reappears and
        // mints a fresh one against the current key.
        await sub.unsubscribe().catch(() => {});
        try {
          await supabase.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
        } catch {
          // best-effort — if the row survives, the server prunes it as "gone"
          // on its next send attempt (lib/push.ts treats the rotation's 403 as gone)
        }
        setPushState("default");
        return;
      }
      setPushState(sub ? "on" : "default");
    })().catch(() => setPushState("unsupported"));
  }, [supabase]);

  // On sign-out (any path — the bell lives in the header, so it sees the auth
  // event) release this device's push subscription: otherwise on a shared device
  // the previous user's pushes keep popping up for whoever holds the tablet, and
  // the next user's enable-push hits an RLS conflict on the stale endpoint row.
  // The DB row can't be deleted here (the session is already gone when the event
  // fires) — the server prunes it as "gone" on its next send. For an eager row
  // delete, cleanupPushOnSignOut() (push-cleanup.ts) runs BEFORE auth.signOut().
  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event !== "SIGNED_OUT") return;
      void (async () => {
        if (!("serviceWorker" in navigator)) return;
        const reg = await navigator.serviceWorker.getRegistration();
        const sub = await reg?.pushManager.getSubscription();
        if (sub) await sub.unsubscribe();
        setPushState("default");
      })().catch(() => {});
    });
    return () => data.subscription.unsubscribe();
  }, [supabase]);

  // close the panel on an outside click
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  async function openItem(n: NotifRow) {
    // A dead target must not be able to destroy the item. The old order was
    // mark-read-then-navigate, so clicking one of these cleared it from the unread
    // count on the way to a 404 — for the Ar account whose whole bell is dead rows,
    // that erased everything the app had to show them. Bail BEFORE the write and
    // before closing the panel, and say why in Thai.
    //
    // AND WAIT FOR THE PROBE RATHER THAN GUESS. The guard above only ever fixed the
    // steady state. The probe is a SECOND, strictly sequential round trip: on mount
    // items is empty, so no probe is fired; the notifications SELECT lands, the
    // unread badge paints — which is precisely what makes someone tap — and only
    // then does the events read go out. For that whole window viewableEventIds is
    // null, every item answers "unknown", and the click fell straight through to the
    // old mark-read-then-404. On venue wifi that is 1-3s of every page load, and it
    // reopens each time a new item brings a new id into the set. So when we do not
    // know yet, await the request that is ALREADY in flight for these very ids — no
    // extra round trip, bounded so a black-holed AP cannot hang a tap.
    let viewable = viewableEventIds;
    if (!viewable) {
      const pending = probeRunRef.current;
      if (pending && pending.key === eventIdKey) {
        viewable = await Promise.race([
          pending.run,
          new Promise<null>((resolve) => {
            setTimeout(() => resolve(null), PROBE_WAIT_MS);
          }),
        ]);
      }
    }
    const reach = notificationReachability(n.link, viewable);
    if (reach === "gone") {
      toast.error(UNREACHABLE_NOTE, {
        description: "การแจ้งเตือนนี้ยังอยู่ในรายการ แต่กดเปิดไม่ได้แล้ว",
      });
      return;
    }
    // ASK BEFORE ANY SIDE EFFECT. router.push is programmatic, so the event
    // workspace's anchor guard cannot see it — the same blind spot the sign-out
    // button has, and opening a notification is a completely ordinary way to walk
    // away from a half-saved call sheet. It has to come BEFORE the panel closes and
    // before the read_at write: cancelling the confirm after those would leave the
    // item marked read for a navigation that never happened.
    //
    // Snapshot first, then commit — blurring the focused field starts a save, and
    // asking about the guard's own write would put a dialog in front of every bell
    // tap (see lib/dirty-guard.ts unsavedWorkMessageFor).
    const beforeUnsaved = unsavedWork();
    commitFocusedField();
    const unsaved = unsavedWorkMessageFor(beforeUnsaved);
    if (unsaved && !window.confirm(unsaved)) return;
    if (unsaved) acknowledgeUnsavedWork();

    setOpen(false);
    // Still "unknown" after that wait (the probe errored, timed out, or was refused
    // as untrustworthy): navigate anyway — failing open is the documented behaviour
    // and a wrong 404 is a Thai page with a way back — but do NOT mark it read.
    // mayMarkRead() carries that asymmetry and the reason for it.
    if (!n.read_at && mayMarkRead(reach)) {
      const now = new Date().toISOString();
      setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, read_at: now } : x)));
      // await before navigating — router.push tears the page down and would
      // cancel an in-flight PATCH, leaving the row unread on the next load.
      // …and ask for the row back: a write that reported no error but touched no
      // row did not happen (an anon-key fallback after a dead session gets a 204
      // and error: null from PostgREST), and the optimistic dot above would then be
      // the only thing claiming this was read.
      const { data, error } = await supabase
        .from("notifications")
        .update({ read_at: now })
        .eq("id", n.id)
        .select("id");
      if (error || wroteNothing(data)) {
        setItems((prev) =>
          prev.map((x) => (x.id === n.id ? { ...x, read_at: n.read_at } : x))
        );
        if (!error) toast.error(await noRowsMessage());
      }
    }
    // n.link is server-set (always internal), but navigate only to an in-app path
    // as defense-in-depth — never follow an external URL from a stored row.
    const dest = safeInternalPath(n.link, "");
    if (!dest) return;
    router.push(dest);
  }

  async function markAllRead() {
    if (unread === 0) return;
    const now = new Date().toISOString();
    // Keep the pre-optimistic list, exactly as openItem does for its one row. The
    // revert CANNOT be delegated to load(): in the very case this check exists for —
    // supabase-js on the anon key after a failed refresh — the UPDATE matches 0 rows
    // (204, error: null) AND the SELECT inside load() comes back `[]`, which load()
    // correctly refuses to believe (an empty read is not an empty table), so it
    // returns early without calling setItems. The optimistic all-read state would
    // then survive with nothing written: badge 0, every row still unread in the
    // table, and on the next reload they all come back. A write that reported no
    // error but touched no row did not happen — so put the list back ourselves and
    // still call load() to pick up the server's answer when it is trustworthy.
    const before = items;
    setItems((prev) => prev.map((x) => (x.read_at ? x : { ...x, read_at: now })));
    // No toast here on purpose: a second tab (or the phone in a pocket) legitimately
    // marks these read first, and a scary red message for that is worse than silence.
    const { data, error } = await supabase
      .from("notifications")
      .update({ read_at: now })
      .is("read_at", null)
      .select("id");
    if (error || wroteNothing(data)) {
      setItems(before);
      await load();
    }
  }

  // The sequence itself lives in lib/push-subscribe.ts — the nudge starts the same
  // one, and two copies would drift (the shared-device retry in one and not the
  // other is exactly the difference nobody notices until an iPad stops receiving).
  async function enablePush() {
    if (pushState === "unsupported" || !VAPID_PUBLIC) {
      toast.error("อุปกรณ์นี้ยังเปิดแจ้งเตือนเด้งไม่ได้ (ลองติดตั้งแอปลงหน้าจอโฮมก่อน)");
      return;
    }
    setPushBusy(true);
    try {
      const res = await subscribeToPush({ supabase, userId, tenantId });
      if (res.ok) {
        setPushState("on");
        toast.success("เปิดแจ้งเตือนเด้งบนอุปกรณ์นี้แล้ว 🔔");
        return;
      }
      if (res.reason === "denied") {
        setPushState(Notification.permission === "denied" ? "denied" : "default");
        toast.error("ยังไม่ได้อนุญาตแจ้งเตือน");
        return;
      }
      if (res.reason === "unsupported") {
        setPushState("unsupported");
        toast.error("อุปกรณ์นี้ยังเปิดแจ้งเตือนเด้งไม่ได้ (ลองติดตั้งแอปลงหน้าจอโฮมก่อน)");
        return;
      }
      toast.error("เปิดแจ้งเตือนเด้งไม่สำเร็จ", { description: res.message });
    } finally {
      setPushBusy(false);
    }
  }

  return (
    <div className="relative" ref={rootRef}>
      <Button
        variant="ghost"
        size="icon"
        title="การแจ้งเตือน"
        onClick={() => setOpen((o) => !o)}
        className="relative"
      >
        <Bell className="h-4 w-4" />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold leading-none text-destructive-foreground">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
        <span className="sr-only">การแจ้งเตือน</span>
      </Button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-80 max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="text-sm font-semibold">การแจ้งเตือน</span>
            {unread > 0 && (
              <button
                type="button"
                onClick={markAllRead}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <Check className="h-3 w-3" /> อ่านทั้งหมด
              </button>
            )}
          </div>

          <div className="max-h-[60vh] overflow-y-auto">
            {items.length === 0 ? (
              <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                ยังไม่มีการแจ้งเตือน
              </p>
            ) : (
              items.map((n) => {
                // "gone" = the event behind this item can't be opened (deleted, or
                // another band's). Keep the item — its title and body are still the
                // only record that anything happened — but mark it plainly and let
                // the click say so instead of navigating into a 404.
                const gone =
                  notificationReachability(n.link, viewableEventIds) === "gone";
                return (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => openItem(n)}
                    aria-disabled={gone}
                    className={cn(
                      "flex w-full flex-col gap-0.5 border-b px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-muted/60",
                      !n.read_at && "bg-primary/5",
                      gone && "cursor-not-allowed opacity-60"
                    )}
                  >
                    <div className="flex items-start gap-2">
                      {!n.read_at && (
                        <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" />
                      )}
                      <span className={cn("flex-1 text-sm", !n.read_at && "font-medium")}>
                        {n.title}
                      </span>
                    </div>
                    {n.body && (
                      <span className="pl-4 text-xs text-muted-foreground">{n.body}</span>
                    )}
                    {gone && (
                      <span className="flex items-center gap-1 pl-4 text-[10px] text-muted-foreground">
                        <Ban className="h-3 w-3 shrink-0" />
                        {UNREACHABLE_NOTE}
                      </span>
                    )}
                    <span className="pl-4 text-[10px] text-muted-foreground/80">
                      {relTime(n.created_at)}
                    </span>
                  </button>
                );
              })
            )}
          </div>

          {/* Web Push opt-in (per device) */}
          <div className="border-t px-3 py-2">
            {pushState === "on" ? (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <BellRing className="h-3.5 w-3.5 text-success" /> เปิดแจ้งเตือนเด้งบนอุปกรณ์นี้แล้ว
              </p>
            ) : pushState === "denied" ? (
              <p className="text-xs text-muted-foreground">
                เบราว์เซอร์บล็อกการแจ้งเตือนไว้ — เปิดได้ที่ตั้งค่าเว็บไซต์
              </p>
            ) : pushState === "unsupported" ? (
              <p className="text-xs text-muted-foreground">
                เด้งถึงเครื่องได้เมื่อติดตั้งแอปลงหน้าจอโฮม (มือถือ) แล้วเปิดจากไอคอนแอป
              </p>
            ) : (
              <button
                type="button"
                onClick={enablePush}
                disabled={pushBusy}
                className="flex w-full items-center justify-center gap-1.5 rounded-md bg-primary/10 py-1.5 text-xs font-medium text-primary hover:bg-primary/15 disabled:opacity-60"
              >
                {pushBusy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <BellRing className="h-3.5 w-3.5" />
                )}
                เปิดแจ้งเตือนเด้งถึงเครื่อง
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
