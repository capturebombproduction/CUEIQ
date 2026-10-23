import { describe, it, expect, beforeEach } from "vitest";

// 2026-10-24: a session that dies on its own (refresh token revoked from another device,
// a captive portal's 4xx) no longer wipes this queue (desktop/src/App.tsx,
// lib/sign-out-intent.ts). What makes keeping it safe is the owner check: nobody else
// may see or flush it, and its owner gets it back on signing in again. The sign-in
// screen counts it regardless of owner — but only AFTER a deliberate sign-out's wipe.

import {
  clearMgmtOutbox,
  enqueueMgmtOp,
  pendingMgmtCount,
  queuedMgmtWorkCount,
} from "./mgmt-outbox";

const STORED = "sb-kewyqqxohckurwuepucv-auth-token";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

function signedInAs(id: string | null) {
  window.localStorage.clear();
  if (id) window.localStorage.setItem(STORED, JSON.stringify({ refresh_token: "r", user: { id } }));
}

beforeEach(async () => {
  signedInAs(null);
  await clearMgmtOutbox();
});

describe("the outbox after a session died on its own", () => {
  it("keeps A's queue for A alone: invisible signed out and to B, back when A signs in", async () => {
    signedInAs(A);
    await enqueueMgmtOp({ kind: "event.delete", base: null, id: "aaaaaaaa-0000-4000-8000-000000000001" });
    expect(await pendingMgmtCount()).toBe(1);

    signedInAs(null); // auth-js removed the stored session; nothing wiped the queue
    expect(await pendingMgmtCount()).toBe(0);
    expect(await queuedMgmtWorkCount()).toBe(1);

    signedInAs(B);
    expect(await pendingMgmtCount()).toBe(0);

    signedInAs(A);
    expect(await pendingMgmtCount()).toBe(1);
  });

  it("the sign-in screen's count reads after a deliberate sign-out's wipe, not before it", async () => {
    signedInAs(A);
    await enqueueMgmtOp({ kind: "event.delete", base: null, id: "aaaaaaaa-0000-4000-8000-000000000002" });
    signedInAs(null);
    // App.tsx fires the wipe without awaiting it, and the sign-in screen mounts and
    // counts straight after — the count must not see what is about to be wiped.
    void clearMgmtOutbox();
    expect(await queuedMgmtWorkCount()).toBe(0);
  });
});
