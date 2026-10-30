// Which queued presses the board leaves off (2026-10-30, hunt 11): foreignRunSeqRows.
//
// The board laid every un-parked press over the server rows, another account's too - presses a
// flush here never sends (hunt 10). The rows it now leaves off are exactly the units doFlush
// skips: groupRunSeqPresses over the whole queue, owner by unitOwner, judged by
// queuedByAnotherAccount. A unit mixing accounts, or holding an op with no owner, replays for
// whoever is signed in - so it stays on the board.
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { foreignRunSeqRows, groupRunSeqPresses, mergeOp, type RunSeqOp } from "@/lib/run-order-outbox";

const A = "aaaaaaaa-0000-4000-8000-00000000000a";
const B = "bbbbbbbb-0000-4000-8000-00000000000b";

function signIn(userId: string | null) {
  window.localStorage.removeItem("sb-testref-auth-token");
  if (userId)
    window.localStorage.setItem(
      "sb-testref-auth-token",
      JSON.stringify({ access_token: "t", refresh_token: "r", user: { id: userId } })
    );
}
const op = (rowId: string, presses: string[], owner?: string, conflict?: boolean): RunSeqOp => ({
  rowId,
  festival: "F",
  patch: { status: "live" },
  expect: { status: "pending" },
  label: rowId,
  queuedAt: 1,
  presses,
  ...(owner ? { owner } : {}),
  ...(conflict ? { conflict } : {}),
});

beforeEach(() => signIn(null));

describe("foreignRunSeqRows", () => {
  it("another account's whole unit - its parked rows too - and nothing of this account's", () => {
    signIn(B);
    const rows = foreignRunSeqRows([op("r1", ["pA"], A), op("r2", ["pA"], A), op("r3", ["pB"], B), op("r9", ["pA2"], A, true)]);
    expect([...rows].sort()).toEqual(["r1", "r2", "r9"]);
  });

  it("a unit that mixes accounts or holds an owner-less op is nobody's: it stays on the board", () => {
    signIn(B);
    expect(foreignRunSeqRows([op("r1", ["pA"], A), op("r2", ["pA", "pB"]), op("r3", ["pB"], B)]).size).toBe(0);
    expect(foreignRunSeqRows([op("r1", ["pA"], A), op("r2", ["pA"])]).size).toBe(0);
  });

  it("nobody readable signed in, or an older op with no owner: nothing is foreign (as before)", () => {
    expect(foreignRunSeqRows([op("r1", ["pA"], A)]).size).toBe(0);
    signIn(B);
    expect(foreignRunSeqRows([op("r1", [])]).size).toBe(0);
  });

  // ตาที่ 3 on hunt 11 asked: can THIS account's press end up in a unit with another account's
  // PARKED op (the helper groups the whole queue, parked included - as doFlush does), and be
  // hidden from the board as "บัญชีอื่น"? No: a press on a parked row replaces that record
  // (mergeOp takes the new press, its owner and its press ids only), and a unit with any op of
  // this account's - or with no owner - is never foreign.
  it("this account's press on a row another account's press PARKED on is this account's, on the board", () => {
    signIn(B);
    const parkedA = op("r2", ["pA"], A, true);
    const pressB = op("r2", ["pB"], B);
    const record = mergeOp(parkedA, pressB);
    expect(record.owner).toBe(B);
    expect(record.conflict).toBeFalsy();
    expect(record.presses).toEqual(["pB"]);
    // beside the rest of A's parked press on another row: still two units, and only A's is foreign
    const queue = [op("r1", ["pA"], A, true), record];
    expect(groupRunSeqPresses(queue)).toHaveLength(2);
    expect([...foreignRunSeqRows(queue)]).toEqual(["r1"]);
  });
});
