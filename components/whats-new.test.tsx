// "มีอะไรใหม่" — said once per device per round, never nagging. The restraint is
// what is pinned: gone for good after "เข้าใจแล้ว", back for a NEW round, silent
// when storage refuses, and editor-only items only for editors.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { WhatsNew } from "./whats-new";

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
