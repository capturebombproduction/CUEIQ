// Hunt 3 (2026-10-27), shell-1 / admin-5: reading an answered report on /feedback (where the
// "ทีมงานตอบฟีดแบคของคุณแล้ว" push lands) stamps reply_seen_at on the server but the
// shell's unread count (More-tab dot, avatar dot, Feedback tile) never came down:
// app/(app)/feedback/page.tsx renders <MyFeedbackList userId=…/> with NO onSeen
// (every list now says the count on window - FEEDBACK_UNREAD_EVENT).
import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { makeSupabaseFake, ok } from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));

import { FeedbackUnreadProvider, useFeedbackUnread } from "@/components/feedback-button";
import { MyFeedbackList } from "@/components/my-feedback-list";

afterEach(() => cleanup());

function Dot() {
  return <span data-testid="unread">{useFeedbackUnread()}</span>;
}

const ROW = {
  id: "f1",
  category: "bug",
  message: "เสียงไม่เล่น",
  status: "done",
  created_at: "2026-10-27T10:00:00Z",
  reply: "แก้แล้วครับ",
  replied_at: "2026-10-27T11:00:00Z",
  reply_seen_at: null,
  images: [],
};

describe("/feedback page read of an answer", () => {
  it("brings the shell's unread count down", async () => {
    const supa = makeSupabaseFake({
      script: {
        feedback: (c: { verb: string }) => (c.verb === "update" ? ok([{ id: "f1" }]) : ok([ROW])),
      },
    });
    h.supa = supa;
    render(
      <FeedbackUnreadProvider userId="u1">
        <Dot />
        {/* exactly what app/(app)/feedback/page.tsx renders */}
        <MyFeedbackList userId="u1" />
      </FeedbackUnreadProvider>
    );
    await waitFor(() => expect(screen.getByTestId("unread").textContent).toBe("1"));
    // the list stamps the answer as read
    await waitFor(() => expect(supa.callsTo("feedback", "update")).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByTestId("unread").textContent).toBe("0");
  });
});
