// The header's update chip: present only when there is something to press, says what the
// press will do on THIS platform, follows the main process's state live, and leaves every
// decision that can quit the app to main (apply() — the native confirm lives there).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { UpdateChip } from "./update-chip";

const base: CueiqUpdateState = {
  state: "uptodate",
  current: "0.1.24",
  latest: "0.1.24",
  percent: null,
  url: null,
  platform: "win32",
};

let listeners: ((s: CueiqUpdateState) => void)[] = [];
let current: CueiqUpdateState;
const apply = vi.fn(async () => current);

function install(state: Partial<CueiqUpdateState>) {
  current = { ...base, ...state };
  listeners = [];
  (window as unknown as { cueiqNative: Partial<CueiqNative> }).cueiqNative = {
    isElectron: true,
    updates: {
      get: async () => current,
      check: async () => current,
      apply,
      onChange: (cb) => {
        listeners.push(cb);
        return () => {
          listeners = listeners.filter((l) => l !== cb);
        };
      },
    },
  };
}
const push = (state: Partial<CueiqUpdateState>) =>
  act(() => {
    current = { ...current, ...state };
    listeners.forEach((l) => l(current));
  });

beforeEach(() => apply.mockClear());
afterEach(() => {
  delete (window as unknown as { cueiqNative?: unknown }).cueiqNative;
});

describe("UpdateChip", () => {
  it("renders nothing in a browser (no bridge) and nothing when there is no update", async () => {
    const { container, unmount } = render(<UpdateChip />);
    expect(container.innerHTML).toBe("");
    unmount();
    install({ state: "uptodate" });
    const second = render(<UpdateChip />);
    await act(async () => {});
    expect(second.container.innerHTML).toBe("");
  });

  it("Windows: a newer version is one press to download, then progress, then one press to install", async () => {
    install({ state: "available", latest: "0.1.25" });
    render(<UpdateChip />);
    const chip = await screen.findByRole("button", { name: /อัปเดต\s*0\.1\.25/ });
    fireEvent.click(chip);
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));

    push({ state: "downloading", percent: 42 });
    expect(screen.getByRole("status").textContent).toMatch(/กำลังโหลด\s*42%/);
    expect(screen.queryByRole("button")).toBeNull(); // nothing to press mid-download

    push({ state: "ready", percent: 100 });
    fireEvent.click(screen.getByRole("button", { name: /ติดตั้ง\s*0\.1\.25/ }));
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(2));
  });

  it("Mac that can replace itself: the same อัปเดต → n% → ติดตั้ง as Windows", async () => {
    install({ state: "available", latest: "0.1.26", platform: "darwin", url: "https://example.test/x.dmg", manual: false });
    render(<UpdateChip />);
    const chip = await screen.findByRole("button", { name: /อัปเดต\s*0\.1\.26/ });
    expect(chip.getAttribute("title")).not.toMatch(/\.dmg/);
    fireEvent.click(chip);
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    push({ state: "downloading", percent: 7 });
    expect(screen.getByRole("status").textContent).toMatch(/กำลังโหลด\s*7%/);
    push({ state: "ready", percent: 100 });
    fireEvent.click(screen.getByRole("button", { name: /ติดตั้ง\s*0\.1\.26/ }));
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(2));
  });

  it("Mac that cannot (run from the .dmg, an older release…): the press is a download of the .dmg, worded as such", async () => {
    install({ state: "available", latest: "0.1.25", platform: "darwin", url: "https://example.test/x.dmg", manual: true });
    render(<UpdateChip />);
    const chip = await screen.findByRole("button", { name: /ดาวน์โหลด\s*0\.1\.25/ });
    expect(chip.getAttribute("title")).toMatch(/\.dmg/);
    fireEvent.click(chip);
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
  });

  it("a release that appears while the app is open shows up without a restart, and an error hides it", async () => {
    install({ state: "uptodate" });
    render(<UpdateChip />);
    await act(async () => {});
    expect(screen.queryByTestId("update-chip")).toBeNull();
    push({ state: "available", latest: "0.1.26" });
    expect(screen.getByRole("button", { name: /0\.1\.26/ })).toBeTruthy();
    push({ state: "error" });
    expect(screen.queryByTestId("update-chip")).toBeNull();
  });

  it("a second press while the first is still answering does not call main twice", async () => {
    let release!: () => void;
    apply.mockImplementationOnce(() => new Promise<CueiqUpdateState>((r) => (release = () => r(current))));
    install({ state: "available", latest: "0.1.25" });
    render(<UpdateChip />);
    const chip = await screen.findByRole("button", { name: /อัปเดต/ });
    fireEvent.click(chip);
    fireEvent.click(chip);
    expect(apply).toHaveBeenCalledTimes(1);
    await act(async () => release());
  });
});
