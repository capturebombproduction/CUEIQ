import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "CueIQ",
    short_name: "CueIQ",
    description: "Show & Event Management Platform for idol and artist shows.",
    start_url: "/dashboard",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#4f46e5",
    // NOT locked to portrait. A show is run in landscape — Live Mode's next-up
    // prep card (mics, props, the cue note) is `landscape:` only, and the run sheet
    // and Overview tables are built for the wider viewport. An installed Android
    // copy pinned to portrait could never reach any of it, whatever the operator
    // did with the device. (iOS ignores this field, so it only ever hurt Android.)
    orientation: "any",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
