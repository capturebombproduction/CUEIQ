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

export interface ControllerClaim {
  /** When THIS device claimed control (epoch ms), or null if it never actively did. */
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
  /**
   * `theirs` moved into THIS device's clock (their stamp + (my now - their sentAt)),
   * when the message carried a sentAt. See rule 2.
   */
  theirsAtMyClock?: number | null;
}

/**
 * Two claims further apart than this, once the other device's clock is corrected
 * into ours, are judged on the corrected times. Closer than this they are judged on
 * the raw stamps. Far above a message's latency, far below a show.
 */
export const CLAIM_SKEW_TRUST_MS = 10_000;

/**
 * True when THIS device should step down to a viewer. Exactly one side of any
 * pair gets true (ids are distinct), so the show always ends up with one
 * controller — never two, never none.
 *
 * Order of the rules:
 *  0. A device with a RUNNING SHOW beats one with nothing. See below — this rule
 *     was missing, and its absence could stop a show mid-song.
 *  1. A real claim always beats no claim.
 *  2. Between two real claims the EARLIER wins — the device that started the show
 *     first. A second START (two presses at once, or a device that started its own
 *     show while it could not hear the first and then reconnected) loses, and the
 *     first device is never moved. The stamps come from two CLOCKS: a PA that sat
 *     offline for days drifts minutes, and judged raw, a fast-clocked PA would lose
 *     to a phone that started a minute after it. So a gap wider than
 *     CLAIM_SKEW_TRUST_MS after correcting their clock into ours is judged on the
 *     corrected times - both sides see the same wide gap, with opposite signs, and
 *     agree. A narrow gap (two presses at once) is judged on the RAW stamps: the
 *     correction carries a message's latency, which could tip the two sides into
 *     different verdicts there, and the raw pair is the same two numbers on both.
 *  3. Anything still tied (both unclaimed, or the same millisecond) is settled by
 *     id: the HIGHER id keeps control. Arbitrary, but identical on both devices,
 *     which is the only property that matters — and it is the direction the
 *     same-millisecond case already shipped with.
 *
 * ⚠️ WHY RULE 0 EXISTS. Every live page opens as isController=true with a NULL
 * claim, and a device that reloaded mid-show also holds begun=true with a NULL
 * claim (nothing restores a stamp). So when a band member merely OPENED the live
 * page while the PA had reloaded at some point, both sides were {mine:null,
 * theirs:null} and the winner was decided by comparing two random uuids — a coin
 * flip. Half the time the phone won, and the "I keep control" branch re-broadcasts
 * ITS state, which for a page that never started anything is INITIAL. The PA then
 * adopts begun:false / currentIndex:0: the audio pauses mid-track, the accumulated
 * clock is gone, and 500ms later the crash-recovery snapshot is deleted because
 * begun is false, so even a reload cannot get the run back. Nobody touched a
 * control. Whether a show is RUNNING is the one fact that outranks a coin flip.
 *
 * Both flags default to false, which keeps the rule inert for any caller that
 * doesn't pass them (and for a peer on an older build whose payload has no
 * `begun`) — such a pair falls through to exactly the previous behaviour.
 */
export function shouldYieldControl({
  mine,
  theirs,
  myId,
  theirId,
  mineBegun = false,
  theirsBegun = false,
  theirsAtMyClock = null,
}: ControllerClaim): boolean {
  if (mineBegun !== theirsBegun) return theirsBegun;
  if (mine == null && theirs == null) return theirId > myId;
  if (mine == null) return true;
  if (theirs == null) return false;
  if (theirsAtMyClock != null && Math.abs(theirsAtMyClock - mine) > CLAIM_SKEW_TRUST_MS) {
    return theirsAtMyClock < mine;
  }
  if (theirs !== mine) return theirs < mine;
  return theirId > myId;
}
