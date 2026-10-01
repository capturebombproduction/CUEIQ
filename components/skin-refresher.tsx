"use client";

import { useEffect } from "react";
import { refreshSavedAccent } from "@/lib/accent";

/**
 * Brings a band colour saved under older tokens up to date, once per app load.
 *
 * This used to ride on AccentPicker's mount, which was fine while the picker sat in
 * the header of every page. The redesign moved the colour swatches into the account
 * panel, whose contents only exist while it is open — so "on every page" quietly
 * became "after somebody opens the panel", and a device would keep painting the old
 * skin's overrides indefinitely. Mounted in the root layout and the desktop shell
 * instead; renders nothing.
 */
export function SkinRefresher() {
  useEffect(() => {
    refreshSavedAccent();
  }, []);
  return null;
}
