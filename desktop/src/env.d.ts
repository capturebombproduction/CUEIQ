/// <reference types="vite/client" />
// Pull in the repo-root module declarations the reused lib needs (soundtouchjs
// ships no types — used by lib/practice-audio.ts, reused on the Training page).
/// <reference path="../../types/soundtouchjs.d.ts" />
// The Electron native-bridge typing (window.cueiqNative) now lives at the repo
// root so the web build shares it — see types/cueiq-native.d.ts.
/// <reference path="../../types/cueiq-native.d.ts" />
