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

  // …and the button it points at is ON THE CARD. Live Mode and the live show-caller
  // have no header and no tab bar, so the More sheet's Feedback tile — the only other
  // way in — cannot be reached from the very screens a member is mid-show on.
  it("when the report did not land, the card itself opens the แจ้งปัญหา form", async () => {
    h.log.mockResolvedValue(false);
    crash();
    await flush();
    const tile = screen.getByRole("button", { name: /แจ้งปัญหา/ });
    expect(screen.getByTestId("crash-feedback")).toContainElement(tile);
    fireEvent.click(tile);
    expect(await screen.findByRole("dialog", { name: "Feedback" })).toBeInTheDocument();
  });

  it("offers no report form when the capture DID land", async () => {
    crash();
    await flush();
    expect(screen.queryByTestId("crash-feedback")).toBeNull();
    expect(screen.queryByRole("button", { name: /แจ้งปัญหา/ })).toBeNull();
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

// lib/csp.ts ships the policy report-only; these reports are what decides whether
// it can be enforced, so they take the same deduped, RLS-gated path as any error.
describe("ErrorMonitor · CSP reports", () => {
  const violation = (props: Record<string, unknown>) =>
    Object.assign(new Event("securitypolicyviolation"), props);

  afterEach(() => {
    delete (window as { __cspv?: unknown }).__cspv;
  });

  it("logs a violation the browser reports after mount", async () => {
    render(<ErrorMonitor userId={ME} tenantId={TENANT} />);
    await act(async () => {
      document.dispatchEvent(
        violation({ effectiveDirective: "script-src-elem", blockedURI: "inline", sourceFile: "https://x.test/a.js", lineNumber: 3, sample: "alert(1)" })
      );
    });
    expect(h.log).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "csp", message: "CSP script-src-elem blocked inline", url: "https://x.test/a.js:3", stack: "alert(1)" })
    );
  });

  // Most violations happen while the page parses, before React mounts anything:
  // the root layout's pre-paint script keeps them in window.__cspv.
  it("logs the violations buffered before it mounted, once", async () => {
    (window as { __cspv?: unknown[] }).__cspv = [{ d: "connect-src", b: "https://evil.test/x", s: "", l: 0 }];
    const { unmount } = render(<ErrorMonitor userId={ME} tenantId={TENANT} />);
    expect(h.log).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "csp", message: "CSP connect-src blocked https://evil.test/x" })
    );
    unmount();
    h.log.mockClear();
    render(<ErrorMonitor userId={ME} tenantId={TENANT} />);
    expect(h.log).not.toHaveBeenCalled();
  });

  // A refused presigned R2 URL carries X-Amz-Signature in its query.
  it("never stores a blocked URL's query string", async () => {
    render(<ErrorMonitor userId={ME} tenantId={TENANT} />);
    await act(async () => {
      document.dispatchEvent(
        violation({ effectiveDirective: "media-src", blockedURI: "https://b.acct.r2.cloudflarestorage.com/song.mp3?X-Amz-Signature=secret" })
      );
    });
    const arg = (h.log.mock.calls.at(-1) as unknown as [{ message: string }])[0];
    expect(arg.message).toBe("CSP media-src blocked https://b.acct.r2.cloudflarestorage.com/song.mp3");
    expect(JSON.stringify(h.log.mock.calls)).not.toContain("secret");
  });

  it("stops listening on unmount", async () => {
    const { unmount } = render(<ErrorMonitor userId={ME} tenantId={TENANT} />);
    unmount();
    await act(async () => {
      document.dispatchEvent(violation({ effectiveDirective: "img-src", blockedURI: "https://x.test/i.png" }));
    });
    expect(h.log).not.toHaveBeenCalled();
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

// Live Mode and the show-caller have no header and no tab bar since the redesign, so
// a crash there offered ONLY reload — which re-opens the same screen. On the desktop
// (.exe, a HashRouter) quitting the app was the only exit. The card now carries a way
// back to the event page on exactly those screens, and nowhere else.
describe("the way out on the immersive screens", () => {
  const original = window.location;
  function at(loc: { hash: string; pathname: string }) {
    const stub = { ...loc, reload: vi.fn(), assign: vi.fn() };
    Object.defineProperty(window, "location", { configurable: true, value: stub });
    return stub;
  }
  afterEach(() => {
    Object.defineProperty(window, "location", { configurable: true, value: original });
  });

  function crashDesktop(hashRoute: string) {
    return render(
      <AppErrorBoundary userId={ME} tenantId={TENANT} hashRoute={hashRoute}>
        <Boom />
      </AppErrorBoundary>
    );
  }

  it("desktop Live Mode (hash route /events/<id>/live): sets the event's hash and reloads into it", async () => {
    const loc = at({ hash: "#/events/e1/live", pathname: "/" });
    crashDesktop("/events/e1/live");
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "กลับไปหน้างาน" }));
    expect(loc.hash).toBe("#/events/e1");
    expect(loc.reload).toHaveBeenCalled();
    expect(loc.assign).not.toHaveBeenCalled();
  });

  it("desktop show-caller: Quick Show too — the header that carried it is gone there", async () => {
    const loc = at({ hash: "#/events/e1/run-order/live", pathname: "/" });
    crashDesktop("/events/e1/run-order/live");
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Quick Show" }));
    expect(loc.hash).toBe("#/my-show");
    expect(loc.reload).toHaveBeenCalled();
  });

  it("web show-caller (/events/<id>/run-order/live): a full navigation to the event page, no Quick Show", async () => {
    const loc = at({ hash: "", pathname: "/events/e1/run-order/live" });
    crash();
    await flush();
    expect(screen.queryByRole("button", { name: "Quick Show" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "กลับไปหน้างาน" }));
    expect(loc.assign).toHaveBeenCalledWith("/events/e1");
  });

  it.each(["/dashboard", "/events/e1", "/events/e1/run-order"])(
    "an ordinary page (%s) keeps the card as it was, web and desktop",
    async (path) => {
      at({ hash: "", pathname: path });
      crash();
      await flush();
      expect(screen.getByText("โหลดหน้าใหม่")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "กลับไปหน้างาน" })).toBeNull();
      cleanup();
      crashDesktop(path);
      await flush();
      expect(screen.queryByRole("button", { name: "กลับไปหน้างาน" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Quick Show" })).toBeNull();
    }
  );
});
