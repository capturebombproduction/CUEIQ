// Proves the two things about test/fakes/supabase.ts that are most likely to be
// subtly wrong, because both fail as a TIMEOUT pointing at the component rather
// than as an assertion pointing here:
//
//  1. the BUILDER is thenable at every stage — not just after .single(). The
//     desktop Crew page ends its chain at .order() and calls .then() on it; a
//     builder that only resolves at a terminal leaves that page loading for ever.
//  2. a handler recorded by the channel fake really reaches the component's
//     callback, and the .subscribe() status callback really fires the component's
//     SUBSCRIBED branch. Everything the two-device handoff tests do rests on that.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useEffect, useState } from "react";
import { render, screen, act } from "@testing-library/react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { liveTopic, privateChannel } from "@/lib/realtime";
import {
  makeSupabaseFake,
  instrumentMediaElements,
  makeSession,
  ok,
  offline,
  type SupabaseFake,
} from "@/test/fakes/supabase";

// vi.mock factories are hoisted above every binding in this file, so the holder
// has to be hoisted with them — a plain `let supa` is in its TDZ when the
// component's own import of the client module runs.
const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));

let supa: SupabaseFake;
beforeEach(() => {
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
});

/** A miniature of the pattern shared by setlist-builder.tsx, live-mode.tsx and
 *  crew.tsx: one chain-and-.then() read, one broadcast subscription, one
 *  sync-request sent from the SUBSCRIBED branch. */
function Probe({ eventId }: { eventId: string }) {
  const [count, setCount] = useState<number | null>(null);
  const [liveItemId, setLiveItemId] = useState<string | null>(null);
  useEffect(() => {
    const supabase = createClient();
    supabase
      .from("setlist_items")
      .select("*")
      .eq("event_id", eventId)
      .order("sort_order", { ascending: true })
      .then(({ data, error }) => {
        if (!error) setCount((data ?? []).length);
      });
    const ch = privateChannel(supabase as unknown as SupabaseClient, liveTopic(eventId));
    ch.on("broadcast", { event: "state" }, ({ payload }) => {
      setLiveItemId(payload?.begun ? (payload.currentItemId ?? null) : null);
    });
    ch.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        ch.send({ type: "broadcast", event: "sync-request", payload: { sender: "probe" } });
      }
    });
    return () => {
      supabase.removeChannel(ch);
    };
  }, [eventId]);
  return (
    <div>
      <span data-testid="count">{count === null ? "loading" : String(count)}</span>
      <span data-testid="live">{liveItemId ?? "none"}</span>
    </div>
  );
}

describe("makeQueryFake — the builder resolves at every stage of the chain", () => {
  beforeEach(() => {
    supa.setTable("songs", ok([{ id: "s1" }, { id: "s2" }]));
  });

  it("awaits after .select, after a filter, after a modifier, and off a bare .then", async () => {
    expect((await supa.from("songs").select("id")).data).toHaveLength(2);
    expect((await supa.from("songs").select("id").eq("group_id", "g1")).data).toHaveLength(2);
    expect(
      (await supa.from("songs").select("id").eq("group_id", "g1").order("title")).data
    ).toHaveLength(2);
    expect(
      (await supa.from("songs").select("*").in("id", ["s1"]).is("audio_path", null).limit(5).range(0, 4))
        .data
    ).toHaveLength(2);

    // crew.tsx: no await, no terminal — .then() straight off .order().
    let viaThen: unknown = null;
    await supa
      .from("songs")
      .select("*")
      .eq("tenant_id", "t1")
      .order("sort_order", { ascending: true })
      .then(({ data }) => {
        viaThen = data;
      });
    expect(viaThen).toHaveLength(2);

    expect(supa.callsTo("songs").every((c) => c.settled)).toBe(true);
  });

  it("reduces the terminals the way postgrest does", async () => {
    expect((await supa.from("songs").select("id").maybeSingle()).data).toEqual({ id: "s1" });
    // two rows for .single() is an error, not a row — the app branches on it
    expect((await supa.from("songs").select("id").single()).error?.code).toBe("PGRST116");
    supa.setTable("songs", ok([]));
    expect((await supa.from("songs").select("id").maybeSingle()).data).toBeNull();
  });

  it("records the verb, the filters and whether .select() followed a write", async () => {
    await supa.from("setlist_items").update({ title: "x" }).eq("id", "i1").select("id");
    const updated = supa.lastCall("setlist_items");
    expect(updated?.verb).toBe("update");
    expect(updated?.values).toEqual({ title: "x" });
    expect(updated?.eq).toEqual({ id: "i1" });
    expect(updated?.selectAfterWrite).toBe(true);

    await supa.from("setlist_items").delete().in("id", ["i1", "i2"]);
    const deleted = supa.lastCall("setlist_items");
    expect(deleted?.verb).toBe("delete");
    expect(deleted?.selectAfterWrite).toBe(false);
    expect(deleted?.filters).toEqual([{ op: "in", column: "id", value: ["i1", "i2"] }]);
  });

  it("plays a per-table queue in order and keeps status 0 for a dead network", async () => {
    supa.setTable("events", [ok([{ id: "e1" }]), offline()]);
    expect((await supa.from("events").select("*")).data).toHaveLength(1);
    const second = await supa.from("events").update({ name: "n" }).eq("id", "e1").select("id");
    // status 0 = no response at all, which is what makes the app QUEUE the write
    // instead of throwing it away (lib/mgmt-outbox.ts isQueueableWriteError).
    expect(second.status).toBe(0);
    expect(second.error?.message).toMatch(/fetch/i);
  });

  it("defers the next read of any table when given no table name", async () => {
    const gate = supa.defer();
    let settled = false;
    void supa
      .from("songs")
      .select("*")
      .then(() => {
        settled = true;
      });
    await act(async () => {});
    expect(gate.pending).toBe(true);
    expect(settled).toBe(false);
    await act(async () => {
      gate.resolve(ok([{ id: "s1" }]));
    });
    expect(settled).toBe(true);
    // the defer is spent — the table's own script answers the next call
    expect((await supa.from("songs").select("*")).data).toHaveLength(2);
  });

  it("holds a read open until the test resolves it — the component stays loading", async () => {
    const gate = supa.defer("setlist_items");
    render(<Probe eventId="e1" />);
    await act(async () => {});
    expect(gate.taken).toBe(true);
    expect(screen.getByTestId("count")).toHaveTextContent("loading");

    await act(async () => {
      gate.resolve(ok([{ id: "a" }, { id: "b" }, { id: "c" }]));
    });
    expect(screen.getByTestId("count")).toHaveTextContent("3");
  });
});

describe("makeChannelFake — a recorded handler reaches the component", () => {
  it("delivers a broadcast the test fires, and runs the SUBSCRIBED branch", async () => {
    render(<Probe eventId="e1" />);
    await act(async () => {});

    const ch = supa.channelFor(liveTopic("e1"));
    expect(ch).toBeDefined();
    // private topic, self-echo off — the contract lib/realtime.ts promises
    expect(ch?.config).toEqual({ config: { private: true, broadcast: { self: false } } });
    expect(screen.getByTestId("live")).toHaveTextContent("none");

    // The component registered exactly one broadcast handler for "state" …
    expect(ch?.handlers).toHaveLength(1);
    // … and firing it drives the component's own callback.
    await act(async () => {
      expect(ch?.emit("state", { begun: true, currentItemId: "item-7" })).toBe(1);
    });
    expect(screen.getByTestId("live")).toHaveTextContent("item-7");

    // A handler registered for a DIFFERENT event must not receive it.
    await act(async () => {
      expect(ch?.emit("setlist-changed", { at: 1 })).toBe(0);
    });
    expect(screen.getByTestId("live")).toHaveTextContent("item-7");

    // Nothing has been sent yet: subscribe() does not fire a status by itself.
    expect(ch?.sent).toHaveLength(0);
    await act(async () => {
      ch?.setStatus("SUBSCRIBED");
    });
    expect(ch?.lastSent()?.event).toBe("sync-request");
  });

  it("hands the same channel back for an open topic and drops it on removeChannel", () => {
    const { unmount } = render(<Probe eventId="e1" />);
    const first = supa.channelFor(liveTopic("e1"));
    // RealtimeClient reuses an open topic — desktop/src/data/mgmt-outbox.ts
    // matches on the "realtime:" prefixed topic to find it.
    expect(supa.getChannels().find((c) => c.topic === `realtime:${liveTopic("e1")}`)).toBe(first);
    expect(supa.channel(liveTopic("e1"))).toBe(first);

    unmount();
    expect(first?.removed).toBe(true);
    expect(supa.getChannels()).toHaveLength(0);
  });
});

describe("makeAuthFake — a black-holed getSession", () => {
  it("never settles until released, then answers with the session", async () => {
    supa.auth.hang("getSession");
    let settled = false;
    void supa.auth.getSession().then(() => {
      settled = true;
    });
    await act(async () => {});
    expect(settled).toBe(false);

    supa.auth.release("getSession");
    await act(async () => {});
    expect(settled).toBe(true);
    expect((await supa.auth.getSession()).data.session?.access_token).toBeTruthy();
  });

  it("pushes auth events at live listeners only", () => {
    const seen: string[] = [];
    const { data } = supa.auth.onAuthStateChange((event) => seen.push(event));
    supa.auth.emit("SIGNED_OUT", null);
    data.subscription.unsubscribe();
    supa.auth.emit("SIGNED_IN", makeSession());
    expect(seen).toEqual(["SIGNED_OUT"]);
    expect(supa.auth.unsubscribedCount()).toBe(1);
  });
});

describe("instrumentMediaElements — per-instance, on elements never in the DOM", () => {
  it("tells the primary from the secondary during a pre-roll swap", async () => {
    const media = instrumentMediaElements();
    // exactly what live-mode.tsx does in its effect: two elements, no document
    const primary = new Audio();
    const secondary = new Audio();
    expect(media.first()).toBe(primary);
    expect(media.second()).toBe(secondary);

    primary.src = "blob:on-air";
    await primary.play();
    secondary.src = "blob:pre-roll";
    secondary.currentTime = 12;

    expect(media.state(primary)).toMatchObject({ src: "blob:on-air", paused: false, currentTime: 0 });
    expect(media.state(secondary)).toMatchObject({
      src: "blob:pre-roll",
      paused: true,
      currentTime: 12,
    });
    expect(media.callsFor(secondary).map((c) => c.type)).toEqual(["src", "currentTime"]);
    expect(primary.paused).toBe(false);
    expect(secondary.paused).toBe(true);

    // autoplay refusal, the reason Live Mode has a "แตะเพื่อเล่นเสียงต่อ" rescue
    media.rejectPlay();
    await expect(secondary.play()).rejects.toBeTruthy();
    expect(media.state(secondary).paused).toBe(true);

    media.restore();
    expect(HTMLMediaElement.prototype.play).not.toBe(media.play);
  });
});
