// Who drives the show when two devices both believe they are the controller?
//
// พี่'s rule (2026-10-04): the device that STARTED the show is the show — it drives it
// and it sounds it. Every device that opens the page after it only watches, and
// nothing it does reaches the first one. There is no take-over: if the first device
// goes down, it is opened again, and its own snapshot carries the show on.
//
// A device defaults to isController=true when the live page opens, and
// `controllerSince` is stamped ONLY when it actively claimed: it pressed
// เริ่มโชว์. So "null" means "I hold the default flag, I never claimed anything" —
// which is also what a device held after a RELOAD before the crash-recovery
// snapshot learned to carry the claim (a device restored from an older snapshot
// still can).
//
// That is the case this file exists for. Two devices that both restored the same
// running show (a venue power blip, two refreshes) both answer a sync-request
// with fromController=true and controllerSince=null — and the rule "null always
// yields" then made BOTH of them step down, leaving the show with no controller
// at all: Auto stops advancing and next/prev go dead mid-show. Exactly the outcome
// the arbitration was written to prevent, reached through the one input it did not
// consider.
//
// Pure and total: every device must reach the SAME verdict from its own side of
// the exchange, so the tie-break has to be symmetric — see the id comparison.

/** A stretch when a device was not running its page: closed, asleep, reloading. Epoch ms. */
export interface Absence {
  from: number;
  to: number;
}

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
  /** Has this device's show been ended (จบโชว์)? */
  mineEnded?: boolean;
  /** Has theirs? */
  theirsEnded?: boolean;
  /**
   * `theirs` moved into THIS device's clock (their stamp + (my now - their sentAt)),
   * when the message carried a sentAt. See rules 2 and 3.
   */
  theirsAtMyClock?: number | null;
  /** This device's last absence (its own clock), or null. */
  myAbsence?: Absence | null;
  /** The other device's last absence, already moved into THIS device's clock, or null. */
  theirAbsenceAtMyClock?: Absence | null;
  /**
   * The message is the other device RE-ASSERTING its claim at THIS device - it judged
   * the pair and kept the show too. See rule 4.
   */
  theyInsistOnMe?: boolean;
}

/**
 * True when THIS device should step down to a viewer. Exactly one side of any
 * pair gets true (ids are distinct), so the show always ends up with one
 * controller — never two, never none.
 *
 * Order of the rules:
 *  0. A device with a RUNNING SHOW beats one with nothing. See below — this rule
 *     was missing, and its absence could stop a show mid-song.
 *  1. Between two running shows, one still ON beats one that was ended (จบโชว์): an
 *     ended run is a run-through somebody finished, not the show.
 *  2. A run that STARTED WHILE THE OTHER DEVICE WAS AWAY (its page closed, asleep or
 *     reloading) beats that device's run. A claim is a run's START, and under rule 4
 *     an old claim wins - so a phone coming back with this afternoon's rehearsal
 *     would otherwise take tonight's show off the PA that started it. Whoever was
 *     away when the other run began has nothing to defend: the show started without
 *     it. (The first device that reloads mid-show is away for seconds, and nobody can
 *     start a show in those seconds - START is refused while it holds show_authority.)
 *  3. A real claim always beats no claim.
 *  4. Between two real claims the EARLIER wins — the device that started the show
 *     first. A second START (two presses at once, or a device that started its own
 *     show while it could not hear the first and then reconnected) loses, and the
 *     first device is never moved. The stamps come from two CLOCKS (a PA that sat
 *     offline for days drifts minutes), so they are compared CORRECTED: their stamp
 *     plus (my now - their sentAt). Each side's correction carries its own message
 *     latency (always >= 0), and that has one exact consequence: the two sides can
 *     never BOTH yield, and can both KEEP only when the two STARTs were within one
 *     latency of each other. That pair settles on the next exchange - each re-asserts
 *     AT the other (theyInsistOnMe), and a device that kept and is insisted on falls
 *     back to the RAW stamps, the same two numbers on both sides, so exactly one
 *     yields (either winner is fair for two presses at once; agreeing is what
 *     matters). A threshold ("raw when the gap is small") was tried first and has an
 *     edge where both sides yield - a show with no controller.
 *  5. Anything still tied (both unclaimed, or the same millisecond) is settled by
 *     id: the HIGHER id keeps control. Arbitrary, but identical on both devices,
 *     which is the only property that matters — and it is the direction the
 *     same-millisecond case already shipped with.
 *
 * ⚠️ WHY RULE 0 EXISTS. Every live page opens as isController=true with a NULL
 * claim, and a device that reloaded mid-show also holds begun=true with a NULL
 * claim (nothing restored a stamp then). So when a band member merely OPENED the live
 * page while the PA had reloaded at some point, both sides were {mine:null,
 * theirs:null} and the winner was decided by comparing two random uuids — a coin
 * flip. Half the time the phone won, and the "I keep control" branch re-broadcasts
 * ITS state, which for a page that never started anything is INITIAL. The PA then
 * adopts begun:false / currentIndex:0: the audio pauses mid-track, the accumulated
 * clock is gone, and 500ms later the crash-recovery snapshot is deleted because
 * begun is false, so even a reload cannot get the run back. Nobody touched a
 * control. Whether a show is RUNNING is the one fact that outranks a coin flip.
 *
 * Every flag defaults to false / null, which keeps its rule inert for a caller that
 * doesn't pass it (and for a peer on an older build whose payload lacks it).
 */
export function shouldYieldControl({
  mine,
  theirs,
  myId,
  theirId,
  mineBegun = false,
  theirsBegun = false,
  mineEnded = false,
  theirsEnded = false,
  theirsAtMyClock = null,
  myAbsence = null,
  theirAbsenceAtMyClock = null,
  theyInsistOnMe = false,
}: ControllerClaim): boolean {
  if (mineBegun !== theirsBegun) return theirsBegun;
  if (mineBegun && mineEnded !== theirsEnded) return mineEnded;
  if (mine != null && theirs != null) {
    const theirStart = theirsAtMyClock ?? theirs;
    const startedWhileAway = (start: number, a: Absence | null) => a != null && start > a.from && start < a.to;
    const theyStartedWhileIWasAway = startedWhileAway(theirStart, myAbsence);
    const iStartedWhileTheyWereAway = startedWhileAway(mine, theirAbsenceAtMyClock);
    if (theyStartedWhileIWasAway !== iStartedWhileTheyWereAway) return theyStartedWhileIWasAway;
  }
  if (mine == null && theirs == null) return theirId > myId;
  if (mine == null) return true;
  if (theirs == null) return false;
  if (theirsAtMyClock != null) {
    if (theirsAtMyClock < mine) return true;
    if (theirsAtMyClock > mine && !theyInsistOnMe) return false;
  }
  if (theirs !== mine) return theirs < mine;
  return theirId > myId;
}
