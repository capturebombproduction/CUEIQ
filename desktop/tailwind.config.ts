import type { Config } from "tailwindcss";
import preset from "../tailwind.preset";

// The theme is the web app's own preset (../tailwind.preset.ts), not a mirror of it,
// so the look cannot drift. Content paths point at both the desktop src and the
// reused web components at the repo root.
const config: Config = {
  darkMode: ["class"],
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
    "../components/**/*.{js,ts,jsx,tsx}",
    "../lib/**/*.{js,ts,jsx,tsx}",
    // A test's fixtures are strings too, and Tailwind would ship them as classes.
    "!./src/**/*.test.{js,ts,jsx,tsx}",
    "!../components/**/*.test.{js,ts,jsx,tsx}",
    "!../lib/**/*.test.{js,ts,jsx,tsx}",
  ],
  presets: [preset],
};
export default config;
