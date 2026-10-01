import type { MetadataRoute } from "next";
import { THEME_COLOR } from "@/lib/theme-mode";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "CueIQ",
    short_name: "CueIQ",
    description: "Show & Event Management Platform for idol and artist shows.",
    start_url: "/dashboard",
    display: "standalone",
    // The splash an installed app shows while it boots, and its title bar: the dark
    // page colour, so a launch at a dark venue does not flash white first.
    background_color: THEME_COLOR.dark,
    theme_color: THEME_COLOR.dark,
    // NOT locked to portrait. A show is run in landscape — Live Mode's next-up
    // prep card (mics, props, the cue note) is `landscape:` only, and the run sheet
    // and Overview tables are built for the wider viewport. An installed Android
    // copy pinned to portrait could never reach any of it, whatever the operator
    // did with the device. (iOS ignores this field, so it only ever hurt Android.)
    orientation: "any",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // Maskable: Android crops home-screen icons to its own shape, and without a
      // maskable entry it shrinks the "any" icon onto a white plate instead. The
      // same file qualifies — it is full-bleed band colour, and the waveform's
      // farthest pixel is 202px from the centre of 512, inside the 204.8px safe
      // circle the maskable spec guarantees (checked against the PNG's pixels).
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
