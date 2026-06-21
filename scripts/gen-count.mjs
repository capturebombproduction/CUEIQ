// One-off dev script: generate the practice metronome's spoken-count samples.
// Cute Japanese-accented FEMALE voice (ja-JP-NanamiNeural) counting "one".."eight",
// so the dance 1-8 count can be scheduled sample-accurately via Web Audio instead
// of laggy live SpeechSynthesis. Output → public/sounds/count/1.mp3 .. 8.mp3.
//
// Run once with the dev dep installed:  node scripts/gen-count.mjs
// (uses Microsoft Edge's free TTS, no API key; the app then ships the mp3s and
//  never needs the network for them.)
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { mkdir, writeFile } from "node:fs/promises";

const VOICE = "ja-JP-NanamiNeural";
const WORDS = ["one", "two", "three", "four", "five", "six", "seven", "eight"];
const OUT_DIR = new URL("../public/sounds/count/", import.meta.url);
const PROSODY = { pitch: "+8%", rate: "default", volume: "default" };

function collect(streamLike) {
  const stream = streamLike?.audioStream ?? streamLike;
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

const tts = new MsEdgeTTS();
await tts.setMetadata(VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
await mkdir(OUT_DIR, { recursive: true });

for (let i = 0; i < WORDS.length; i++) {
  let buf;
  try {
    buf = await collect(tts.toStream(WORDS[i], PROSODY));
  } catch {
    buf = await collect(tts.toStream(WORDS[i])); // fall back without prosody
  }
  const file = new URL(`${i + 1}.mp3`, OUT_DIR);
  await writeFile(file, buf);
  console.log(`  ${i + 1}.mp3  (${WORDS[i]})  ${(buf.length / 1024).toFixed(1)} KB`);
}
console.log("done →", OUT_DIR.pathname);
