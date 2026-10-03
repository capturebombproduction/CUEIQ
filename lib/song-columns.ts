// The songs columns a SHOW needs: every column except `cover`.
//
// songs.cover (0044) is a ~10 K-char data URL per song. Seishin's 36 covers came to
// ~360 K chars, 14x the rest of their song rows put together. Only the Library and
// the practice room's Now Playing draw a cover, so the event bundle - the event page,
// Live Mode, the run sheet, every router.refresh() of them, and on the desktop the
// localStorage read-cache, which shares its few MB with the saved sign-in - reads
// this list instead of "*". lib/song-columns.test.ts keeps it in step with the Song
// type, so a column added there cannot quietly go missing here.
//
// ONE string literal on purpose: postgrest-js types a .select() by parsing the
// literal, and a concatenated string widens to `string`, which it cannot parse.
export const SONG_SHOW_COLUMNS =
  "id, tenant_id, group_id, title, file_name, duration_seconds, language, category, copyright_status, notes, audio_path, audio_name, audio_expires_at, bpm, created_at, updated_at";
