// The event page's hero (spec G.3) replaced four rows of buttons with one, and the
// header's run-on line of date / times / venue with tiles. What is pinned here:
// what LEADS (the dashboard ticket's rule, so the two screens never disagree), the
// call time said once, and that a bare cached row — the desktop renders this from
// its offline bundle — draws instead of crashing.
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { EventHero } from "./event-hero";

const show = {
  id: "e1",
  name: "SEISHIN KAKUMEI 1st Oneman Live — RED REVOLUTION",
  venue: "Lido Connect Hall 2",
  event_date: "2026-10-04",
  show_start_time: "18:00:00",
  hard_out_time: "19:00:00",
  status: "approved",
  event_type: "idol",
  group: { name: "Seishin Kakumei", color: "#A62A1C" },
};

const actions = () => screen.getAllByRole("link").filter((a) => !a.getAttribute("target"));

describe("EventHero", () => {
  it("before the show day the band practises: ซ้อมตามเซ็ต leads, Live Mode beside it", () => {
    render(<EventHero event={show} callTime="16:00:00" leadLive={false} practiceRoomHref="/events/room/practice" />);
    const [lead, second] = actions();
    expect(lead).toHaveTextContent("ซ้อมตามเซ็ต");
    expect(lead).toHaveAttribute("href", "/events/room/practice");
    expect(second).toHaveTextContent("Live Mode");
    expect(second).toHaveAttribute("href", "/events/e1/live");
  });

  // "ซ้อมตามเซ็ต" is the ticket's word for the band's ROOM. With no room known the
  // button opens the Training list — so it must not promise the set.
  it("with no room known it opens the Training list and says ห้องซ้อม, not ซ้อมตามเซ็ต", () => {
    render(<EventHero event={show} callTime="16:00:00" leadLive={false} practiceRoomHref={null} />);
    const [lead] = actions();
    expect(lead).toHaveAttribute("href", "/practice");
    expect(lead).toHaveTextContent("ห้องซ้อม");
    expect(screen.queryByText("ซ้อมตามเซ็ต")).toBeNull();
  });

  it("on the show day (or for an admin) Live Mode leads, alone", () => {
    render(<EventHero event={show} callTime="16:00:00" leadLive />);
    const links = actions();
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveTextContent("Live Mode");
    expect(screen.queryByText("ซ้อมตามเซ็ต")).toBeNull();
  });

  it("gives the day, the call, the stage and the hard out — and a call that IS the stage time once", () => {
    const { container, rerender } = render(<EventHero event={show} callTime="16:00:00" leadLive />);
    const tiles = () => [...container.querySelectorAll(".well")].map((t) => t.textContent);
    expect(tiles()).toEqual(["Sun04Oct", "นัด16:00", "ขึ้นเวที18:00", "Hard Out19:00"]);
    rerender(<EventHero event={show} callTime="18:00:00" leadLive />);
    expect(tiles()).toEqual(["Sun04Oct", "ขึ้นเวที18:00", "Hard Out19:00"]);
  });

  it("names the show whole for a screen reader, the poster being decoration", () => {
    render(<EventHero event={show} callTime={null} leadLive />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(show.name);
  });

  it("draws a bare cached row — no date, no times, no band — without an error", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(<EventHero event={{ id: "x", name: "แคช" }} callTime={null} leadLive />);
      const hero = screen.getByRole("region", { name: "Event" });
      expect(within(hero).getAllByText("—").length).toBeGreaterThanOrEqual(3);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});
