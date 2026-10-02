import type { Config } from "tailwindcss";
import preset from "./tailwind.preset";

// Theme, colours, radii, animations and plugins come from the shared preset (also
// used by desktop/tailwind.config.ts); this file says only where to look for classes.
const config: Config = {
  darkMode: ["class"],
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    // Tailwind reads every string in a scanned file as a class candidate, so the
    // fixtures and assertions in a test shipped as real CSS rules.
    "!./**/*.test.{js,ts,jsx,tsx}",
  ],
  presets: [preset],
};
export default config;
