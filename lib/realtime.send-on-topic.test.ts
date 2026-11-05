// 2026-11-05, hunt 13 (build-1). The "tell Live" senders (show form, practice room, library,
// outboxes) used to JOIN a short-lived channel of their own and remove it a moment later. The
// REAL realtime-js keeps one channel per topic and hands the open one to whoever asks, so a
// screen opening the same topic inside that window got the sender's channel, its subscribe()
// never called back, and the sender's removal tore it down: Live sat on "กำลังเชื่อม…" deaf to
// every phone until a reload. These tests run the real RealtimeClient on a transport that
// never opens (a slow venue link: every join stays pending), with fetch faked for the REST send.
import { describe, it, expect, vi, afterEach } from "vitest";
import { RealtimeClient } from "@supabase/realtime-js";
import { liveTopic, privateChannel, sendOnTopic } from "@/lib/realtime";

class NeverOpenSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 0;
  binaryType = "arraybuffer";
  onopen: unknown = null;
  onclose: unknown = null;
  onerror: unknown = null;
  onmessage: unknown = null;
  constructor(public url: string) {}
  send() {}
  close() {
    this.readyState = 3;
  }
}

const SHOW = "6f93d7ba-d74c-4cc6-85d0-d4c3493bb859";

function makeClient(fetchImpl: (url: string, init: RequestInit) => Promise<Response>) {
  const fetch = vi.fn(fetchImpl);
  const rt = new RealtimeClient("ws://localhost/realtime/v1", {
    params: { apikey: "test" },
    transport: NeverOpenSocket as unknown as typeof WebSocket,
    fetch: fetch as unknown as typeof globalThis.fetch,
  });
  // the shape the app's helpers take (SupabaseClient's channel methods → realtime)
  const sb = {
    channel: (t: string, o?: object) => rt.channel(t, o as never),
    getChannels: () => rt.getChannels(),
    removeChannel: (ch: Parameters<typeof rt.removeChannel>[0]) => rt.removeChannel(ch),
  };
  return { rt, sb, fetch };
}

const accepted = () => Promise.resolve(new Response(null, { status: 202 }));
const sentEvents = (fetch: ReturnType<typeof vi.fn>) =>
  fetch.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)).messages[0]);

afterEach(() => {
  vi.useRealTimers();
});

describe("sendOnTopic: a one-off notice never takes a screen's channel down", () => {
  it("with no screen on the topic: sent once over REST, as a private message, and nothing is left open", async () => {
    const { rt, sb, fetch } = makeClient(accepted);
    await sendOnTopic(sb, liveTopic(SHOW), "setlist-changed", { at: 1 });
    expect(sentEvents(fetch)).toEqual([
      { topic: liveTopic(SHOW), event: "setlist-changed", payload: { at: 1 }, private: true },
    ]);
    expect(rt.getChannels()).toEqual([]);
  });

  it("a screen already on the topic: the notice rides its channel, which stays open and keeps its join", async () => {
    const { rt, sb, fetch } = makeClient(accepted);
    const page = privateChannel(sb, liveTopic(SHOW));
    page.on("broadcast", { event: "state" }, () => {});
    page.subscribe(vi.fn());
    await sendOnTopic(sb, liveTopic(SHOW), "setlist-changed", { at: 2 });
    expect(sentEvents(fetch).map((m) => m.event)).toEqual(["setlist-changed"]); // not joined yet → REST
    expect(rt.getChannels()).toEqual([page]);
    expect(page.state).toBe("joining");
  });

  it("a screen that opens the topic while the notice is on its way gets a normal join, and keeps its channel", async () => {
    vi.useFakeTimers();
    let answer: (r: Response) => void = () => {};
    const { rt, sb } = makeClient(() => new Promise<Response>((r) => (answer = r)));
    const sending = sendOnTopic(sb, liveTopic(SHOW), "setlist-changed", { at: 3 });
    // Live (or the Setlist tab) mounts now - realtime hands it the sender's channel object
    const page = privateChannel(sb, liveTopic(SHOW));
    page.on("broadcast", { event: "state" }, () => {});
    page.subscribe(vi.fn());
    expect(page.state).toBe("joining"); // its subscribe() ran the join: its status callback is armed
    answer(new Response(null, { status: 202 }));
    await sending;
    // past any sender's own clean-up timer (the page's join times out meanwhile on this dead
    // link, and realtime retries it - what matters is that the channel is still the page's)
    await vi.advanceTimersByTimeAsync(11_000);
    expect(rt.getChannels()).toContain(page);
  });

  it("a send that never answers gives up after its limit and still leaves nothing open", async () => {
    vi.useFakeTimers();
    const { rt, sb } = makeClient(() => new Promise<Response>(() => {}));
    let done = false;
    void sendOnTopic(sb, liveTopic(SHOW), "setlist-changed", { at: 4 }).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(9_000);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(done).toBe(true);
    expect(rt.getChannels()).toEqual([]);
  });

  it("a client that throws never reaches the caller", async () => {
    const sb = {
      channel: () => {
        throw new Error("boom");
      },
      getChannels: () => [],
      removeChannel: vi.fn(),
    };
    await expect(sendOnTopic(sb as never, liveTopic(SHOW), "x", {})).resolves.toBeUndefined();
  });
});
