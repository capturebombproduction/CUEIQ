// The break timer (spec §G.6): the running break is the shared Countdown (a
// role="timer" in Barlow, never a bespoke span) inside a ring that empties as the
// break runs out — and its controls are 44 px keys with names.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { BreakTimer } from "./break-timer";

afterEach(() => {
  vi.useRealTimers();
});

const C = 2 * Math.PI * 60;

describe("BreakTimer", () => {
  it("counts down on the shared Countdown inside a ring that empties with it", () => {
    vi.useFakeTimers();
    render(<BreakTimer />);
    fireEvent.click(screen.getByRole("button", { name: /เวลาพัก/ }));
    fireEvent.click(screen.getByRole("button", { name: /^5\s*นาที$/ }));

    const timer = screen.getByRole("timer");
    expect(timer.textContent).toBe("5:00");
    expect(timer.className).toMatch(/\bcd\b/);
    const ring = screen.getByTestId("break-ring");
    expect(Number(ring.getAttribute("stroke-dashoffset"))).toBeCloseTo(0, 3);

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByRole("timer").textContent).toBe("4:00");
    expect(Number(ring.getAttribute("stroke-dashoffset"))).toBeCloseTo(C * (60 / 300), 1);
  });

  it("its keys say what they do", () => {
    vi.useFakeTimers();
    render(<BreakTimer />);
    fireEvent.click(screen.getByRole("button", { name: /เวลาพัก/ }));
    fireEvent.click(screen.getByRole("button", { name: /^5\s*นาที$/ }));
    expect(screen.getByRole("button", { name: "หยุดเวลาพักชั่วคราว" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "เริ่มนับใหม่จากต้น" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "ปิดเวลาพัก" }));
    expect(screen.queryByRole("timer")).toBeNull();
  });
});
