// The white-screen handler, and the one sentence it is allowed to say.
//
// It told every user "ระบบบันทึกปัญหานี้ไว้ให้แล้ว" unconditionally, while
// logClientError swallowed every failure of its own. On 2026-09-04 `client_errors`
// had held zero rows for the life of the app, and that unchecked promise is
// exactly why nobody could tell a healthy silence from a blind one. Same class as
// lib/write-guard.ts — a write that reported no error but touched no row did not
// happen — except this one was said out loud, to a person, at the worst moment of
// their day.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup, fireEvent } from "@testing-library/react";

const h = vi.hoisted(() => ({
  log: vi.fn<() => Promise<boolean>>(async () => true),
}));
vi.mock("@/lib/client-log", () => ({ logClientError: h.log }));

import { AppErrorBoundary, ErrorMonitor } from "@/components/error-monitor";

const ME = "11111111-1111-4111-8111-111111111111";
const TENANT = "22222222-2222-4222-8222-222222222222";

function Boom(): React.ReactElement {
  throw new Error("render exploded");
}

/** React logs the caught error to console.error; that is expected here and would
 *  otherwise bury the real output. */
let quiet: ReturnType<typeof vi.spyOn>;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function crash() {
  return render(
    <AppErrorBoundary userId={ME} tenantId={TENANT}>
      <Boom />
    </AppErrorBoundary>
  );
}

beforeEach(() => {
  h.log.mockClear();
  h.log.mockResolvedValue(true);
  quiet = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  quiet.mockRestore();
  cleanup();
});

describe("AppErrorBoundary", () => {
  it("catches a render crash and offers a reload instead of a blank page", async () => {
    crash();
    expect(screen.getByText("เกิดข้อผิดพลาดบางอย่าง")).toBeInTheDocument();
    expect(screen.getByText("โหลดหน้าใหม่")).toBeInTheDocument();
    await flush();
  });

  it("reports the crash with the stack, as kind 'react'", async () => {
    crash();
    await flush();
    expect(h.log).toHaveBeenCalledTimes(1);
    expect(h.log).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: ME,
        tenantId: TENANT,
        kind: "react",
        message: "render exploded",
      })
    );
  });

  // THE POINT OF THE FILE.
  it("claims the report was saved ONLY once the write says so", async () => {
    crash();
    // …before the answer arrives it promises nothing.
    expect(screen.getByTestId("crash-note").textContent).not.toContain("บันทึก");
    await flush();
    expect(screen.getByTestId("crash-note").textContent).toContain(
      "ระบบบันทึกปัญหานี้ไว้ให้แล้ว"
    );
  });

  it("ADMITS it when the report did not land, and points at แจ้งปัญหา", async () => {
    h.log.mockResolvedValue(false);
    crash();
    await flush();
    const note = screen.getByTestId("crash-note").textContent ?? "";
    expect(note).not.toContain("ระบบบันทึกปัญหานี้ไว้ให้แล้ว");
    expect(note).toContain("ไม่สำเร็จ");
    // The channel a human actually reads — the reason แจ้งปัญหา was made two-way.
    expect(note).toContain("แจ้งปัญหา");
  });

  it("still renders the crash screen when the logger itself rejects", async () => {
    h.log.mockRejectedValue(new Error("logger down"));
    crash();
    await flush();
    expect(screen.getByText("เกิดข้อผิดพลาดบางอย่าง")).toBeInTheDocument();
  });

  it("renders children untouched when nothing throws", () => {
    render(
      <AppErrorBoundary userId={ME} tenantId={TENANT}>
        <p>ทุกอย่างปกติ</p>
      </AppErrorBoundary>
    );
    expect(screen.getByText("ทุกอย่างปกติ")).toBeInTheDocument();
    expect(h.log).not.toHaveBeenCalled();
  });
});

describe("ErrorMonitor", () => {
  it("captures an uncaught window error", async () => {
    render(<ErrorMonitor userId={ME} tenantId={TENANT} />);
    await act(async () => {
      window.dispatchEvent(
        new ErrorEvent("error", {
          message: "ระเบิด",
          error: new Error("ระเบิด"),
          filename: "app.js",
          lineno: 4,
          colno: 2,
        })
      );
    });
    expect(h.log).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "error", message: "ระเบิด", url: "app.js:4:2" })
    );
  });

  it("captures an unhandled rejection", async () => {
    render(<ErrorMonitor userId={ME} tenantId={TENANT} />);
    await act(async () => {
      const e = new Event("unhandledrejection") as Event & { reason: unknown };
      e.reason = new Error("promise พัง");
      window.dispatchEvent(e);
    });
    expect(h.log).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "unhandledrejection", message: "promise พัง" })
    );
  });

  // A listener that outlives its component would keep reporting under a signed-out
  // user id after the layout remounts.
  it("removes its listeners on unmount", async () => {
    const { unmount } = render(<ErrorMonitor userId={ME} tenantId={TENANT} />);
    unmount();
    await act(async () => {
      window.dispatchEvent(new ErrorEvent("error", { message: "after unmount" }));
    });
    expect(h.log).not.toHaveBeenCalled();
  });

  it("renders nothing", () => {
    const { container } = render(<ErrorMonitor userId={ME} tenantId={TENANT} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("the reload button", () => {
  it("reloads the page", async () => {
    const reload = vi.fn();
    const original = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...original, reload },
    });
    crash();
    await flush();
    fireEvent.click(screen.getByText("โหลดหน้าใหม่"));
    expect(reload).toHaveBeenCalled();
    Object.defineProperty(window, "location", { configurable: true, value: original });
  });
});
