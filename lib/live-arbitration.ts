// Who drives the show when two devices both believe they are the controller?
//
// A device defaults to isController=true when the live page opens, and
// `controllerSince` is stamped ONLY when it actively claimed: it pressed
// เริ่มโชว์ or ขอควบคุม. So "null" means "I hold the default flag, I never
// claimed anything" — which is also what a device holds after a RELOAD, because
// the crash-recovery snapshot restores `begun` but nothing restores a claim.
//
// That is the case this file exists for. Two devices that both restored the same
// running show (a venue power blip, two refreshes) both answer a sync-request
// with fromController=true and controllerSince=null — and the rule "null always
// yields" then made BOTH of them step down, leaving the show with no controller
// at all: Auto stops advancing, next/prev go dead, and someone has to notice and
// press ขอควบคุม mid-show. Exactly the outcome the arbitration was written to
// prevent, reached through the one input it did not consider.
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
}

/**
 * True when THIS device should step down to a viewer. Exactly one side of any
 * pair gets true (ids are distinct), so the show always ends up with one
 * controller — never two, never none.
 *
 * Order of the rules:
 *  1. A real claim always beats no claim.
 *  2. Between two real claims the MORE RECENT wins — an intentional ขอควบคุม
 *     refreshes its stamp, and taking control is meant to work.
 *  3. Anything still tied (both unclaimed, or the same millisecond) is settled by
 *     id: the HIGHER id keeps control. Arbitrary, but identical on both devices,
 *     which is the only property that matters — and it is the direction the
 *     same-millisecond case already shipped with, so only the both-null case
 *     changes behaviour here.
 */
export function shouldYieldControl({ mine, theirs, myId, theirId }: ControllerClaim): boolean {
  if (mine == null && theirs == null) return theirId > myId;
  if (mine == null) return true;
  if (theirs == null) return false;
  if (theirs !== mine) return theirs > mine;
  return theirId > myId;
}

export interface StepDownContext {
  /** This device's claim stamp (null = default/restored flag, never claimed). */
  mine: number | null;
  /** The winner's claim stamp, already corrected into this device's clock, or null. */
  theirsAtMyClock: number | null;
  /** Did THIS device resume a running show from its own local snapshot? */
  resumedOwnSnapshot: boolean;
  /** When this page instance opened (epoch ms). */
  mountedAt: number;
}

/**
 * When a device steps down, does its sound go too?
 *
 * Default YES — เครื่องเสียงคุมคนเดียว: whoever took control had to turn their own
 * output on to do it, so the audio moves there and a stale speaker must not keep
 * playing against the new controller's clock.
 *
 * The exception is the reloaded speaker. A device that resumed this show from its
 * OWN snapshot and never claimed anything is not being taken over — it is handing
 * its default flag back to the incumbent it was already following. Muting it there
 * is what silenced a reloaded PA mid-show. But if the winner's claim is NEWER than
 * this page's own life, that is a real, deliberate take-control that happened after
 * we loaded, and then the sound does move.
 */
export function shouldMuteOnStepDown({
  mine,
  theirsAtMyClock,
  resumedOwnSnapshot,
  mountedAt,
}: StepDownContext): boolean {
  const resumedThisShow = mine == null && resumedOwnSnapshot;
  const freshClaim = theirsAtMyClock != null && theirsAtMyClock > mountedAt;
  return !resumedThisShow || freshClaim;
}
