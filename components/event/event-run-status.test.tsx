import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import {
  makeSupabaseFake,
  makeSession,
  ok,
  fail,
  anonEmpty,
  type SupabaseFake,
} from "@/test/fakes/supabase";
import type { RunSeqLive } from "@/components/event/event-live-caller";
import { EventRunStatusCard } from "./event-run-status";

// ─────────────────────────────────────────────────────────────────────────────
// THE BAND'S OWN COUNTDOWN, AND THE EMPTY ANSWER THAT ERASES IT.
//
// This card is a projection of run_sequence that re-reads on exactly the three
// events a token refresh is most likely to have just failed on: the socket
// (re)subscribing, the tab coming back into view after a phone was pocketed, and
// the network returning. In that window supabase-js signs with the ANON key —
// silently, no error — and RLS answers the select with zero rows. Believing that
// answer replaces "คิวคุณ — รอเล่น · อีก 12:30" with "วงนี้ยังไม่ถูกผูกกับลำดับใน
// คิวงาน", mid-festival, for a band waiting to go on.
//
// lib/read-guard.ts keepOnUntrustedEmpty is what refuses it — and until this file
// existed the helper had no production caller at all, so its seven unit tests
// could not go red for any regression on this screen. These tests are the trace
// from a real reconnect to that function: delete the `if (await
// keepOnUntrustedEmpty(...)) return;` line in refetch() and "keeps this band's
// slot" fails.
//
// Both directions are pinned from one fixture, because the KEEP half alone would
// also pass on a card that simply never applied a refetch:
//   • no provable session → the empty answer is refused, rows survive;
//   • provable session    → the same empty answer is believed, rows go.
// ─────────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));

const EVENT_ID = "9f3a1c8e-2b4d-4a91-8c7e-1f2a3b4c5d6e";
const TENANT = "t1";
const FEST = "A Lot Of Tone Fest";
const FEST_DATE = "2026-08-09";

function seqRow(over: Partial<RunSeqLive> = {}): RunSeqLive {
  return {
    id: "r1",
    sort_order: 1,
    title: "Seishin Kakumei",
    kind: "band",
    planned_start: "18:00",
    planned_end: "18:30",
    buffer_seconds: 0,
    linked_event_id: null,
    actual_start: null,
    actual_end: null,
    status: "pending",
    offset_min: null,
    ...over,
  };
}

/** The festival order as this band's page first receives it: someone else on
 *  stage, our slot still pending. */
const ORDER: RunSeqLive[] = [
  seqRow({ id: "r0", sort_order: 1, title: "วงเปิด", status: "done", planned_start: "17:00" }),
  seqRow({ id: "r1", sort_order: 2, linked_event_id: EVENT_ID, planned_start: "18:00" }),
];

let supa: SupabaseFake;

beforeEach(() => {
  supa = makeSupabaseFake({ session: makeSession(), script: { run_sequence: ok(ORDER) } });
  h.supa = supa;
});

function renderCard(rows: RunSeqLive[] = ORDER) {
  return render(
    <EventRunStatusCard
      rows={rows}
      selfEventId={EVENT_ID}
      tenantId={TENANT}
      eventName={FEST}
      eventDate={FEST_DATE}
    />
  );
}

/** Which of the four self-slot states the card is painting. "unlinked" is the one
 *  an untrusted empty read produces. */
function selfState(): string | null {
  return document.querySelector("[data-cueiq-self]")?.getAttribute("data-cueiq-self") ?? null;
}

/** Cause the refetch the way the venue does — the socket reporting SUBSCRIBED.
 *  Nothing in the fake fires on its own. */
async function reconnect() {
  const ch = supa.allChannels[0];
  expect(ch, "the card never opened its run-order channel").toBeDefined();
  await act(async () => {
    ch.setStatus("SUBSCRIBED");
  });
}

describe("EventRunStatusCard — an empty read is not an empty running order", () => {
  it("keeps this band's slot when the empty answer cannot be proved signed", async () => {
    renderCard();
    expect(selfState()).toBe("pending");

    // The reconnect window: auth-js has cached a failed refresh, so the select
    // goes out as anon and RLS answers [] with no error.
    supa.auth.setSession(null);
    supa.setTable("run_sequence", anonEmpty());
    await reconnect();

    expect(selfState()).toBe("pending");
    expect(supa.auth.getSession).toHaveBeenCalled();
  });

  it("believes the SAME empty answer once the session is provable", async () => {
    // The other half, and the reason the test above is not just "never update":
    // a running order that really was cleared must still reach the screen.
    renderCard();
    supa.setTable("run_sequence", anonEmpty());
    await reconnect();

    expect(selfState()).toBe("unlinked");
  });

  it("applies a real refetch — our slot going live reaches the card", async () => {
    renderCard();
    supa.setTable(
      "run_sequence",
      ok([
        ORDER[0],
        seqRow({
          id: "r1",
          sort_order: 2,
          linked_event_id: EVENT_ID,
          status: "live",
          actual_start: "2026-08-09T18:02:00+07:00",
        }),
      ])
    );
    await reconnect();

    expect(selfState()).toBe("live");
  });

  it("keeps the slot when the refetch ERRORS, and never asks auth about it", async () => {
    renderCard();
    supa.setTable("run_sequence", fail("canceling statement due to statement timeout", 500));
    await reconnect();

    expect(selfState()).toBe("pending");
    // A failed read is the caller's own error branch — paying a getSession() round
    // trip for it on venue wifi is the cost this split exists to avoid.
    expect(supa.auth.getSession).not.toHaveBeenCalled();
  });

  it("accepts an empty answer when there is no order to lose", async () => {
    // A band whose festival genuinely has no running order yet must still see the
    // empty state — even offline, and without a getSession() round trip.
    renderCard([]);
    expect(selfState()).toBe("unlinked");

    supa.auth.setSession(null);
    supa.setTable("run_sequence", anonEmpty());
    await reconnect();

    expect(selfState()).toBe("unlinked");
    expect(supa.auth.getSession).not.toHaveBeenCalled();
  });
});
