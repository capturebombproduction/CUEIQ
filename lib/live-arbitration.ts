// Who drives the show when two devices both believe they are the controller?
//
// พี่'s rule (2026-10-04): the device that STARTED the show is the show — it drives it
// and it sounds it. Every device that opens the page after it only watches, and
// nothing it does reaches the first one. There is no take-over: if the first device
// goes down, it is opened again, and its own snapshot carries the show on.
//
// A device defaults to isController=true when the live page opens, and
// `controllerSince` is stamped ONLY when it actively claimed: it pressed เริ่มโชว์.
// That stamp is the RUN's identity - the crash-recovery snapshot carries it, so the
// first device that reloads comes back as the same run. "null" means "I hold the
// default flag, I never claimed anything".
//
// What this decides, and what it deliberately does NOT:
//
//  - A device RUNNING a show against one with nothing: the idle one steps down (it is
//    a page that merely opened - it becomes a viewer of the show).
//  - The SAME run on two devices (two tabs restored from one snapshot; equal stamps)
//    or two runs nobody can tell apart (no stamps): one steps down and watches the
//    very same show - the tab that OPENED later (the copy; both tabs share one clock,
//    so the comparison is exact), else by id.
//  - TWO DIFFERENT RUNS (a phone back with this afternoon's rehearsal; a phone that
//    started its own show while it could not hear the PA; two STARTs at once): NOBODY
//    steps down. "conflict" - both keep what they run and both say so on screen, and a
//    person resets the one that is not the show. Every automatic answer here was tried
//    and each one, somewhere, took the show off the device that started it (an old
//    claim winning, clocks that disagree by minutes, a device that was away, two
//    devices yielding at once and leaving the show with no driver). Two devices that
//    disagree about which show is THE show cannot settle it between themselves
//    without one of them being moved, and moving the first device is the one thing
//    the rule forbids.
//
// Pure and total: every device reaches the SAME verdict from its own side of the
// exchange (yield on one side means keep on the other; conflict on both).

export type ControlVerdict = "keep" | "yield" | "conflict";

export interface ControllerClaim {
  /** When THIS device claimed control (epoch ms) - its run's START - or null if it never did. */
  mine: number | null;
  /** The other device's claim stamp, or null. */
  theirs: number | null;
  /** This device's broadcast id. */
  myId: string;
  /** The other device's broadcast id. */
  theirId: string;
  /** Is a show actually RUNNING on this device (LiveState.begun)? */
  mineBegun?: boolean;
  /** Is one running on theirs? */
  theirsBegun?: boolean;
  /** When THIS page opened (epoch ms) - the same run on two tabs: the first keeps it. */
  mineOpenedAt?: number | null;
  /** When theirs did. */
  theirsOpenedAt?: number | null;
}

/**
 * What THIS device does about another device that says it controls.
 *
 * ⚠️ WHY "A RUNNING SHOW BEATS NOTHING" COMES FIRST. Every live page opens as
 * isController=true with a NULL claim. Decided by comparing two random ids, a phone
 * that merely OPENED the page won half the time against a PA that had reloaded
 * mid-show, re-broadcast its own INITIAL state as the authority, and the PA adopted
 * begun:false — the audio paused mid-track and the accumulated clock was gone.
 * Whether a show is RUNNING is the one fact that outranks a coin flip. (The flag
 * defaults to false for a peer on an older build whose payload lacks `begun`.)
 */
export function settleControl({
  mine,
  theirs,
  myId,
  theirId,
  mineBegun = false,
  theirsBegun = false,
  mineOpenedAt = null,
  theirsOpenedAt = null,
}: ControllerClaim): ControlVerdict {
  if (mineBegun !== theirsBegun) return theirsBegun ? "yield" : "keep";
  // before any show nobody controls a show: both keep START, the first to press it is first
  if (!mineBegun) return "keep";
  if (mine != null && theirs != null && mine !== theirs) return "conflict";
  if (mine == null && theirs != null) return "yield";
  if (mine != null && theirs == null) return "keep";
  // the same run on two tabs, or no claim on either: the page that opened FIRST keeps it
  // (the one the operator has been using; "who is sounding" is false on every MC row
  // and Manual cue), else one id
  if (mineOpenedAt != null && theirsOpenedAt != null && mineOpenedAt !== theirsOpenedAt) {
    return theirsOpenedAt < mineOpenedAt ? "yield" : "keep";
  }
  return theirId > myId ? "yield" : "keep";
}
