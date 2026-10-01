// The install icon must outlive the header that hosts it.
//
// Chrome fires `beforeinstallprompt` ONCE per document load and never again on a
// same-document navigation. Since the redesign, ChromeGate unmounts the header — and
// the install button in it — on Live Mode and the show-caller. With the captured
// event kept in the button's own state, a member on Android Chrome who opened Live
// and tapped back (a client-side navigation) lost the install icon until a full
// reload, though the spec says install never folds away.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent, cleanup } from "@testing-library/react";
import { InstallButton } from "./install-button";

type PromptEvent = Event & { prompt: ReturnType<typeof vi.fn> };

/** What Chrome dispatches: cancelable, with a one-shot prompt(). */
function offerInstall(): PromptEvent {
  const e = new Event("beforeinstallprompt", { cancelable: true }) as PromptEvent;
  e.prompt = vi.fn(async () => {});
  act(() => {
    window.dispatchEvent(e);
  });
  return e;
}

const icon = () => screen.queryByRole("button", { name: "ติดตั้งแอป" });

beforeEach(() => {
  // the module's capture is per document; start every test with none held
  act(() => {
    window.dispatchEvent(new Event("appinstalled"));
  });
});

describe("InstallButton — the deferred prompt outlives the header", () => {
  it("offers one-tap install when Chrome offers it, and keeps Chrome's own banner away", () => {
    render(<InstallButton />);
    expect(icon()).toBeNull();
    const e = offerInstall();
    expect(e.defaultPrevented).toBe(true);
    expect(icon()).toBeInTheDocument();
  });

  it("is still there after the header unmounts and remounts (into Live and back)", () => {
    const first = render(<InstallButton />);
    offerInstall();
    expect(icon()).toBeInTheDocument();
    first.unmount(); // ChromeGate on /events/<id>/live
    render(<InstallButton />); // back on the event page — Chrome does not fire again
    expect(icon()).toBeInTheDocument();
  });

  it("catches the event even when the document opened with no header mounted (a push into Live)", () => {
    offerInstall(); // nothing mounted yet
    render(<InstallButton />);
    expect(icon()).toBeInTheDocument();
  });

  it("uses the prompt once: after a tap no copy offers it again", async () => {
    const e = offerInstall();
    render(<InstallButton />);
    await act(async () => {
      fireEvent.click(icon()!);
    });
    expect(e.prompt).toHaveBeenCalledTimes(1);
    expect(icon()).toBeNull();
    cleanup();
    render(<InstallButton />);
    expect(icon()).toBeNull();
  });

  it("goes when the app gets installed", () => {
    render(<InstallButton />);
    offerInstall();
    act(() => {
      window.dispatchEvent(new Event("appinstalled"));
    });
    expect(icon()).toBeNull();
  });
});
