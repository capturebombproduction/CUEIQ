"use client";

import { useEffect, useSyncExternalStore } from "react";

/**
 * ONE floating slot at the bottom of the screen: 8px above the tab bar (and the
 * home indicator) below lg. Three things pin themselves there — the Library preview
 * player, the event editors' sticky save bars and the push nudge — and they used to
 * land on the same pixels. The nudge sits outside <main> at z-50, the player inside
 * <main>'s stacking context at z-40 and the save bars at z-30, so the nudge covered
 * whichever of them was up: on a phone, play / pause and ปิดตัวเล่น could not be
 * tapped (and the preview could not be stopped) until the nudge was dismissed, and
 * on every width from 360 to 1440 it sat over ดูสรุปงาน / บันทึก.
 *
 * So the slot has a holder. The player HOLDS it while it is on screen, and so do
 * the save bars (the workspace's, while it is shown; the event form's, while it is
 * mounted); the nudge only shows while nobody holds it. The nudge is the one that
 * waits because it is the one that can: it is a once-per-device question with no
 * deadline, while the player and the save bar are the things the person is using
 * right now. A module-level count rather than a React context because they live in
 * different trees (the holder inside a page, the nudge in the shell) and the
 * desktop shell mounts neither provider.
 */
let holders = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Take the slot; the returned function gives it back (once, however often called). */
export function holdBottomSlot(): () => void {
  holders += 1;
  emit();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders -= 1;
    emit();
  };
}

/** Hold the slot for as long as the calling component is mounted. */
export function useHoldBottomSlot(): void {
  useEffect(() => holdBottomSlot(), []);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** True while something holds the slot. Server render: free. */
export function useBottomSlotTaken(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => holders > 0,
    () => false
  );
}
