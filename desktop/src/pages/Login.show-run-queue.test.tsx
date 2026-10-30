// The sign-in screen's "work still on this machine" counts the show-run queue too
// (2026-10-30, hunt 10). It counted only the management outbox, while an offline show's
// run time (จบโชว์) and its running-order presses sit in cueiq-outbox - which no sign-out
// wipes, and which now goes out only for the account that queued it. So the person about
// to type another name has to hear it is there.
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Login } from "./Login";
import { clearMgmtOutbox, enqueueMgmtOp } from "~/data/mgmt-outbox";
import { countQueuedShowRunWork, enqueue } from "@/lib/show-run-outbox";

function deleteDB(name: string): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onblocked = () => resolve();
    req.onerror = () => resolve();
  });
}

function renderLogin() {
  render(
    <MemoryRouter>
      <Login />
    </MemoryRouter>
  );
}

describe("desktop Login — the show-run queue is venue work too", () => {
  beforeEach(async () => {
    window.localStorage.clear();
    await clearMgmtOutbox();
    await deleteDB("cueiq-outbox");
  });

  it("an offline run time alone is enough to say so", async () => {
    await enqueue({ kind: "event_last_run", eventId: "ev1", seconds: 1200, at: 1_761_900_000_000 });
    renderLogin();
    const notice = await screen.findByTestId("queued-work-notice");
    expect(notice).toHaveTextContent("มีงานค้างซิงค์ 1 รายการในเครื่องนี้");
    expect(notice).toHaveTextContent("เข้าสู่ระบบด้วยบัญชีเดิม");
  });

  it("adds it to the management outbox's count", async () => {
    window.localStorage.setItem(
      "sb-kewyqqxohckurwuepucv-auth-token",
      JSON.stringify({ refresh_token: "r", user: { id: "11111111-1111-4111-8111-111111111111" } })
    );
    await enqueueMgmtOp({ kind: "event.delete", base: null, id: "aaaaaaaa-0000-4000-8000-000000000001" });
    await enqueue({ kind: "event_last_run", eventId: "ev1", seconds: 1200, at: 1_761_900_000_000 });
    window.localStorage.clear(); // the session died: auth-js removed it
    renderLogin();
    const notice = await screen.findByTestId("queued-work-notice");
    expect(notice).toHaveTextContent("มีงานค้างซิงค์ 2 รายการในเครื่องนี้");
  });

  it("says nothing when neither queue holds anything", async () => {
    renderLogin();
    await act(async () => {
      await countQueuedShowRunWork();
    });
    expect(screen.queryByTestId("queued-work-notice")).toBeNull();
  });
});
