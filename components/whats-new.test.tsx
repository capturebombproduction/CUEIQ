// "มีอะไรใหม่" — said once per device per round, never nagging. The restraint is
// what is pinned: gone for good after "เข้าใจแล้ว", silent when storage refuses,
// and the iPhone-only item only where it applies.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

const device = vi.hoisted(() => ({ ios: false, standalone: false }));
vi.mock("@/lib/platform", () => ({
  isIOS: () => device.ios,
  isStandalone: () => device.standalone,
}));

import { WhatsNew } from "./whats-new";

const KEY = "cueiq:whats-new-seen";

beforeEach(() => {
  localStorage.clear();
  device.ios = false;
  device.standalone = false;
});

const mount = async () => {
  await act(async () => {
    render(<WhatsNew />);
  });
};

describe("WhatsNew", () => {
  it("tells a device that has not seen this round what changed", async () => {
    await mount();
    const card = screen.getByTestId("whats-new");
    expect(card).toHaveTextContent("ก๊อปงาน");
    expect(card).toHaveTextContent("ซ้อมตามเซ็ตลิสต์");
  });

  it("goes for good on เข้าใจแล้ว — this round is remembered", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "เข้าใจแล้ว" }));
    expect(screen.queryByTestId("whats-new")).toBeNull();
    expect(localStorage.getItem(KEY)).toBeTruthy();
  });

  it("stays away on a device that has already read this round", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "ปิด" }));
    const round = localStorage.getItem(KEY)!;
    localStorage.setItem(KEY, round);
    document.body.innerHTML = "";
    await mount();
    expect(screen.queryByTestId("whats-new")).toBeNull();
  });

  it("stays silent when the browser refuses storage — never a card on every visit", async () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    await mount();
    expect(screen.queryByTestId("whats-new")).toBeNull();
    spy.mockRestore();
  });

  it("mentions the home-screen step only in Safari on an iPhone/iPad", async () => {
    await mount();
    expect(screen.getByTestId("whats-new")).not.toHaveTextContent("หน้าจอโฮม");
    document.body.innerHTML = "";
    device.ios = true;
    await mount();
    expect(screen.getByTestId("whats-new")).toHaveTextContent("หน้าจอโฮม");
  });
});
