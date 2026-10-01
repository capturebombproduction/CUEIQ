// "มีอะไรใหม่" — said once per device per round, never nagging. The restraint is
// what is pinned: gone for good after "เข้าใจแล้ว", back for a NEW round, silent
// when storage refuses, and editor-only items only for editors.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { WhatsNew, markWhatsNewSeen } from "./whats-new";

const KEY = "cueiq:whats-new-seen";

beforeEach(() => {
  localStorage.clear();
});

const mount = async (canEdit = true) => {
  await act(async () => {
    render(<WhatsNew canEdit={canEdit} />);
  });
};

describe("WhatsNew", () => {
  it("tells a device that has not seen this round what changed", async () => {
    await mount();
    const card = screen.getByTestId("whats-new");
    expect(card).toHaveTextContent("ก๊อปงาน");
    expect(card).toHaveTextContent("ซ้อมตามเซ็ตลิสต์");
  });

  it("tells a PHONE where sign-out went — and only the web below lg, where the More tab exists", async () => {
    // 1023, not 639: the tab bar (and More) shows below lg, so a landscape phone or
    // a portrait iPad has it too. The old "⋯ top right" no longer exists anywhere.
    const mm = vi.spyOn(window, "matchMedia").mockImplementation(
      (q: string) => ({ matches: q.includes("max-width: 1023px"), media: q }) as MediaQueryList
    );
    await mount();
    expect(screen.getByTestId("whats-new")).toHaveTextContent("ออกจากระบบ");
    expect(screen.getByTestId("whats-new")).toHaveTextContent("“More”");
    expect(screen.getByTestId("whats-new")).not.toHaveTextContent("⋯");
    document.body.innerHTML = "";
    localStorage.clear();
    (window as unknown as { cueiqNative?: unknown }).cueiqNative = {}; // the desktop app
    await mount();
    expect(screen.getByTestId("whats-new")).not.toHaveTextContent("ออกจากระบบ");
    delete (window as unknown as { cueiqNative?: unknown }).cueiqNative;
    mm.mockRestore();
  });

  it("does not mention the More tab on a wide screen, where there is no tab bar", async () => {
    await mount(); // the test DOM's matchMedia matches nothing — a wide screen
    expect(screen.getByTestId("whats-new")).not.toHaveTextContent("ออกจากระบบ");
  });

  it("comes back for the 2026-10-01 round on a device that closed the 09-28 one", async () => {
    localStorage.setItem(KEY, "2026-09-28");
    await mount(false);
    expect(screen.getByTestId("whats-new")).toHaveTextContent("ปุ่ม “ซ้อม”");
  });

  it("goes for good on เข้าใจแล้ว — this round is remembered", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "เข้าใจแล้ว" }));
    expect(screen.queryByTestId("whats-new")).toBeNull();
    document.body.innerHTML = "";
    await mount();
    expect(screen.queryByTestId("whats-new")).toBeNull();
  });

  it("the X closes it for good too", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "ปิด" }));
    document.body.innerHTML = "";
    await mount();
    expect(screen.queryByTestId("whats-new")).toBeNull();
  });

  it("comes back for a NEW round on a device that closed an older one", async () => {
    localStorage.setItem(KEY, "2020-01-01"); // an earlier round, already read
    await mount();
    expect(screen.getByTestId("whats-new")).toBeInTheDocument();
  });

  it("stays silent when the browser refuses storage — never a card on every visit", async () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    await mount();
    expect(screen.queryByTestId("whats-new")).toBeNull();
    spy.mockRestore();
  });

  it("does not tell someone who cannot edit about editors' buttons", async () => {
    await mount(false);
    const card = screen.getByTestId("whats-new");
    expect(card).not.toHaveTextContent("ก๊อปงาน");
    expect(card).not.toHaveTextContent("เติมให้พอดี");
    expect(card).toHaveTextContent("ซ้อมตามเซ็ตลิสต์"); // members practise
  });
});

// The same round is also readable from the More sheet's What's New tile, and the
// More tab carries a dot until it is read. Read in either place, it is read
// everywhere — a card that stays up after the sheet showed it, or a dot that stays
// after the card was closed, would teach people to ignore both.
describe("WhatsNew — one round, read once, wherever it was read", () => {
  it("goes when the round is read from the More sheet, without a reload", async () => {
    await mount();
    expect(screen.getByTestId("whats-new")).toBeInTheDocument();
    act(() => markWhatsNewSeen());
    expect(screen.queryByTestId("whats-new")).toBeNull();
    expect(localStorage.getItem(KEY)).toBe("2026-10-01");
  });

  it("closing the card tells the rest of the app (the More dot listens for this)", async () => {
    const heard = vi.fn();
    window.addEventListener("cueiq:whats-new-seen", heard);
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "เข้าใจแล้ว" }));
    expect(heard).toHaveBeenCalledTimes(1);
    window.removeEventListener("cueiq:whats-new-seen", heard);
  });
});
