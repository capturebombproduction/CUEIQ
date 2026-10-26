/** Where a snapshot with a failed table goes (app/api/cron/backup): kept for a look,
 *  never offered as "the latest backup" (lib/r2.ts listBackups) and never counted
 *  against the good ones the prune keeps. */
export const PARTIAL_BACKUP_PREFIX = "backups/partial/";
