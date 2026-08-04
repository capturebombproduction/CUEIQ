// "An empty read is not an empty table" has a twin that costs more:
// A WRITE THAT REPORTED NO ERROR BUT TOUCHED NO ROW DID NOT HAPPEN.
//
// supabase-js substitutes the ANON key whenever getSession() returns null — an
// expired access token whose refresh failed, which auth-js then caches for a
// minute, i.e. exactly the minute a venue reconnect lands in. PostgREST applies
// the UPDATE policy, matches zero rows, and answers 204 with `error: null`. An
// `if (!error) success` reads that as saved.
//
// It is worse than the read version. A failed read shows nothing and the user
// retries. A failed write shows a green toast, the edit stays on screen looking
// saved, and the truth only surfaces later — on the next load, or at the venue,
// when the run sheet prints the old durations. In one case the app went further
// and DELETED the queued offline copy on the strength of that fake success.
//
// The cure is one line at each write: ask for the rows back and check them.
//   const { data, error } = await supabase.from(t).update(p).eq("id", id).select("id");
//   if (error) …network path…
//   if (wroteNothing(data)) toast.error(await noRowsMessage());
import { hasLiveSession } from "@/lib/auth-session";

/** True when the write landed on nothing. `null` data (an errored call) is not
 *  this case — the caller's error branch owns that. */
export function wroteNothing(rows: unknown[] | null | undefined): boolean {
  return Array.isArray(rows) && rows.length === 0;
}

/**
 * Why did it touch no row? Only two answers are possible once the request
 * demonstrably reached the server, and they need different actions from the user,
 * so don't guess: ask whether we still hold a session.
 */
export async function noRowsMessage(): Promise<string> {
  const live = await hasLiveSession();
  return live
    ? "ไม่มีสิทธิ์แก้รายการนี้ หรือรายการถูกลบไปแล้ว — โหลดหน้าใหม่แล้วลองอีกครั้ง"
    : "เซสชันหมดอายุ ระบบจึงยังไม่ได้บันทึก — เข้าสู่ระบบใหม่แล้วบันทึกอีกครั้ง";
}
