// Where a row's track sits in Live Mode before anyone touches it.
//
// A track's level is per device (components/event/live-mode.tsx keeps a soundcheck per event
// in localStorage). This is the level a device starts from when it has none of its own for
// that row: an MC row's music is a bed under the talking, so it starts where the MC fade key
// takes a song - พี่ 2026-10-17: "ตั้งความดังพื้นฐานไว้ที่ค่า MC ของระบบ". Everything else
// starts at full.
import type { SetlistKind } from "./types";

/** The MC fade key's level, and where an MC row's music starts (percent). */
export const MC_LEVEL = 30;

/** The level a row's track starts at on a device that has not set one (0-100). */
export function baseLevel(kind: SetlistKind | string | null | undefined): number {
  return kind === "mc" ? MC_LEVEL : 100;
}
