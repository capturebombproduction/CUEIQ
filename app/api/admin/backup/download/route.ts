import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/queries";
import { isAdmin } from "@/lib/permissions";
import { isMasterAdminEmail } from "@/lib/master-admin";
import { listBackups, presignBackupGet, r2Configured } from "@/lib/r2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Master-Admin-only download of a DB snapshot from R2. The snapshot is the WHOLE
// database (every tenant's rows, incl. profiles + push-subscription secrets), so a
// tenant admin role is not enough — only the code-protected Master Admin account
// may fetch it (middleware skips /api, so we re-check here). Signs a SHORT-LIVED
// GET restricted to the backups/ prefix — it can never sign the audio masters or
// another object. Defaults to the newest snapshot; an explicit ?key must still be
// a real backups/ object.
export async function GET(req: Request) {
  const ws = await getWorkspace();
  if (!ws.user || !isAdmin(ws.perms) || !isMasterAdminEmail(ws.user.email)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!r2Configured()) {
    return NextResponse.json({ error: "R2 not configured" }, { status: 503 });
  }

  const backups = await listBackups();
  if (backups.length === 0) {
    return NextResponse.json({ error: "no backups yet" }, { status: 404 });
  }

  const requested = new URL(req.url).searchParams.get("key");
  const key =
    requested && backups.some((b) => b.key === requested) ? requested : backups[0].key;

  const url = await presignBackupGet(key, 60);
  return NextResponse.redirect(url);
}
