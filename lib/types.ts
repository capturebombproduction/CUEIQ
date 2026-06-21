// ---------------------------------------------------------------------------
// Roles & permissions  (Phase 1 RBAC — two-tier model)
//
// TENANT tier (tenant_members.role) = label-wide standing:
//   admin / ceo / label_staff have real label-wide power (see ADMIN/LABEL_WIDE/
//   APPROVER role sets). artist_manager / member at the TENANT level are an INERT
//   baseline — a band-scoped user keeps one of these so they belong to the tenant,
//   but their real power comes from their per-band group_roles row.
// GROUP tier (group_roles.role) = per-band standing: artist_manager (Ar) | member.
// See lib/permissions.ts for the effective per-group permission helpers.
// ---------------------------------------------------------------------------
export type Role =
  | "admin"
  | "ceo"
  | "label_staff"
  | "artist_manager"
  | "member";

/** Per-band role stored in group_roles.role. */
export type GroupRole = "artist_manager" | "member";

export const ROLE_LABELS: Record<Role, string> = {
  admin: "Admin (ผู้ดูแลระบบ)",
  ceo: "CEO (ผู้บริหาร)",
  label_staff: "Label Staff (ทีมค่าย)",
  artist_manager: "Artist Manager (ผู้จัดการวง)",
  member: "Member (สมาชิกวง)",
};

export const ROLE_SHORT: Record<Role, string> = {
  admin: "Admin",
  ceo: "CEO",
  label_staff: "Label",
  artist_manager: "Ar",
  member: "Member",
};

export const GROUP_ROLE_LABELS: Record<GroupRole, string> = {
  artist_manager: "Artist Manager (ผู้จัดการวง)",
  member: "Member (สมาชิกวง)",
};

/** Tenant roles with full label-wide edit power. */
export const ADMIN_ROLES: Role[] = ["admin"];
/** Tenant roles that can SEE every band (label-wide visibility). */
export const LABEL_WIDE_ROLES: Role[] = ["admin", "ceo", "label_staff"];
/** Tenant roles that can approve/reject songs + events. */
export const APPROVER_ROLES: Role[] = ["admin", "label_staff"];

export function isTenantAdmin(role: Role | null | undefined): boolean {
  return !!role && ADMIN_ROLES.includes(role);
}
export function isLabelWide(role: Role | null | undefined): boolean {
  return !!role && LABEL_WIDE_ROLES.includes(role);
}
export function isApprover(role: Role | null | undefined): boolean {
  return !!role && APPROVER_ROLES.includes(role);
}

/**
 * Tenant-tier editor check. Under the new model only `admin` has blanket
 * label-wide edit rights — per-band Ar editing is resolved in lib/permissions.ts.
 * Phase 2 replaces remaining UI call sites with the group-aware helpers.
 */
export function canEdit(role: Role | null | undefined): boolean {
  return isTenantAdmin(role);
}

// ---------------------------------------------------------------------------
// Event types & module presets
// ---------------------------------------------------------------------------
export type EventType = "idol" | "live_band" | "wedding" | "corporate";

export interface EventModules {
  micMap: boolean;
  soundCheck: boolean;
  booth: boolean;
  photo: boolean;
  costume: boolean;
  guest: boolean;
}

export const EVENT_TYPES: Record<
  EventType,
  { label: string; modules: EventModules }
> = {
  idol: {
    label: "Idol / Artist (ไอดอล/ศิลปิน)",
    modules: {
      micMap: true,
      soundCheck: true,
      booth: true,
      photo: true,
      costume: true,
      guest: true,
    },
  },
  live_band: {
    label: "Live Band (วงดนตรี)",
    modules: {
      micMap: true,
      soundCheck: true,
      booth: false,
      photo: false,
      costume: false,
      guest: true,
    },
  },
  wedding: {
    label: "Wedding (งานแต่ง)",
    modules: {
      micMap: false,
      soundCheck: false,
      booth: false,
      photo: false,
      costume: false,
      guest: true,
    },
  },
  corporate: {
    label: "Corporate (งานองค์กร)",
    modules: {
      micMap: false,
      soundCheck: false,
      booth: false,
      photo: false,
      costume: false,
      guest: false,
    },
  },
};

// ---------------------------------------------------------------------------
// Group / event status
// ---------------------------------------------------------------------------
export type GroupStatus =
  | "draft"
  | "in_progress"
  | "pending_review"
  | "approved"
  | "rejected"
  | "overdue";

export const STATUS_META: Record<
  GroupStatus,
  { label: string; emoji: string; variant: "secondary" | "warning" | "success" | "destructive" | "default" }
> = {
  draft: { label: "Draft", emoji: "⚪", variant: "secondary" },
  in_progress: { label: "In Progress", emoji: "🟡", variant: "warning" },
  pending_review: { label: "Pending Review", emoji: "🟠", variant: "warning" },
  approved: { label: "Approved", emoji: "🟢", variant: "success" },
  rejected: { label: "Rejected", emoji: "🔴", variant: "destructive" },
  overdue: { label: "Overdue", emoji: "⛔", variant: "destructive" },
};

// ---------------------------------------------------------------------------
// Schedule items
// ---------------------------------------------------------------------------
export type ScheduleKind =
  | "on_location"
  | "dressing_room"
  | "stb"
  | "sound_check"
  | "costume"
  | "stage"
  | "booth"
  | "photo"
  | "other";

export const SCHEDULE_KIND_LABELS: Record<ScheduleKind, string> = {
  on_location: "On Location (ถึงสถานที่)",
  dressing_room: "Dressing Room (ห้องแต่งตัว)",
  stb: "Standby Time (STB)",
  sound_check: "Sound Check",
  costume: "Costume (เปลี่ยนชุด)",
  stage: "Stage (ขึ้นเวที)",
  booth: "Booth / High-touch / แฟนไซน์",
  photo: "Photo Session",
  other: "อื่นๆ",
};

// ---------------------------------------------------------------------------
// Setlist items
// ---------------------------------------------------------------------------
export type SetlistKind =
  | "song"
  | "mc"
  | "se"
  | "instrument"
  | "interlude"
  | "guest";

export const SETLIST_KIND_LABELS: Record<SetlistKind, string> = {
  song: "เพลง (Song)",
  mc: "MC (พูดคุย)",
  se: "SE (Sound Effect)",
  instrument: "Instrument (บรรเลง)",
  interlude: "Interlude / VTR",
  guest: "Guest / Special",
};

export const SETLIST_KIND_SHORT: Record<SetlistKind, string> = {
  song: "SONG",
  mc: "MC",
  se: "SE",
  instrument: "INST",
  interlude: "INT",
  guest: "GUEST",
};

/** Per-song mic usage stored as jsonb on a setlist item. */
export interface MicSlot {
  mic: string; // mic number / label, e.g. "1"
  member: string; // member name / nickname
}

// ---------------------------------------------------------------------------
// Database row shapes
// ---------------------------------------------------------------------------
export interface Profile {
  id: string;
  email: string | null;
  full_name: string | null;
  role: Role | null;
  created_at: string;
}

export interface Tenant {
  id: string;
  name: string;
  slug: string | null;
  logo_url: string | null;
  created_at: string;
}

export interface TenantMember {
  id: string;
  tenant_id: string;
  user_id: string;
  role: Role;
  created_at: string;
}

export interface Group {
  id: string;
  tenant_id: string;
  name: string;
  color: string | null;
  skin: string | null; // brand hex that themes the app on this band's pages (null = none)
  exempt_from_deadline: boolean;
  self_photo: boolean; // true = band sets its own photo time (has own photographer); false = label staff fills it
  contact_name: string | null; // band's point of contact (shown on the staff schedule export)
  contact_phone: string | null;
  created_at: string;
}

/** Label-wide crew member for the staff schedule export (ช่างภาพ / ประสานงาน / …). */
export interface StaffContact {
  id: string;
  tenant_id: string;
  name: string;
  role: string;
  phone: string;
  sort_order: number;
  created_at: string;
}

export interface Member {
  id: string;
  tenant_id: string;
  group_id: string;
  name: string;
  nickname: string | null;
  mic_number: number | null;
  color: string | null;
  sort_order: number;
  created_at: string;
}

export interface EventRow {
  id: string;
  tenant_id: string;
  group_id: string;
  name: string;
  event_date: string | null;
  venue: string | null;
  event_type: EventType;
  show_start_time: string | null; // "HH:MM:SS"
  hard_out_time: string | null; // "HH:MM:SS"
  status: GroupStatus;
  notes: string | null;
  map_url: string | null;
  costume_theme: string | null;
  share_token: string | null; // public read-only run-sheet link token (null = not shared)
  share_expires_at: string | null; // share link expiry (ISO; null = never)
  deadline: string | null; // when the setlist must be finalized (ISO; null = none)
  deadline_note: string | null;
  last_run_seconds: number | null; // accumulated run time saved by "จบโชว์" (null = none)
  last_run_at: string | null; // when that run time was saved (ISO)
  is_template: boolean; // true = a "แม่แบบ" reference event (hidden from lists, no completeness churn)
  is_practice: boolean; // true = a "ห้องซ้อม" practice room (hidden from lists; opened in the practice player, not Live Mode)
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScheduleItem {
  id: string;
  tenant_id: string;
  event_id: string;
  kind: ScheduleKind;
  label: string | null;
  location: string | null;
  start_time: string | null; // "HH:MM:SS"
  end_time: string | null; // "HH:MM:SS"
  notes: string | null;
  sort_order: number;
}

export interface SetlistItem {
  id: string;
  tenant_id: string;
  event_id: string;
  kind: SetlistKind;
  title: string;
  duration_seconds: number;
  buffer_before_seconds: number;
  buffer_after_seconds: number;
  mic_slots: MicSlot[];
  notes: string | null;
  sort_order: number;
  song_id?: string | null; // linked library song — the audio source (null = ad-hoc/none)
  audio_path?: string | null; // legacy: per-item R2 key (older items; new audio lives on the song)
  audio_name?: string | null; // legacy: original filename for the per-item audio
  loop_audio?: boolean; // loop the BGM to fill this item's time, fading out to end on time (MC etc.)
}

export interface MicAssignment {
  id: string;
  tenant_id: string;
  event_id: string;
  mic_number: number;
  holder_name: string;
  order_index: number;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Song Library (Phase 2)
// ---------------------------------------------------------------------------
export type CopyrightStatus = "cleared" | "pending" | "rejected";

export const COPYRIGHT_META: Record<
  CopyrightStatus,
  { label: string; emoji: string; variant: "success" | "warning" | "destructive" }
> = {
  cleared: { label: "ถูกต้อง", emoji: "✅", variant: "success" },
  pending: { label: "รอตรวจ", emoji: "🕒", variant: "warning" },
  rejected: { label: "ถูกปฏิเสธ", emoji: "⛔", variant: "destructive" },
};

/** Language options for the song library (stored as the `value` code). */
export const SONG_LANGUAGES: { value: string; label: string }[] = [
  { value: "th", label: "ไทย" },
  { value: "jp", label: "ญี่ปุ่น" },
  { value: "kr", label: "เกาหลี" },
  { value: "en", label: "อังกฤษ" },
  { value: "other", label: "อื่นๆ" },
];

export const SONG_LANGUAGE_LABELS: Record<string, string> = Object.fromEntries(
  SONG_LANGUAGES.map((l) => [l.value, l.label])
);

/** A named section point on a library song (Intro/Verse/Hook/custom) for practice. */
export interface SongMarker {
  id: string;
  tenant_id: string;
  group_id: string;
  song_id: string;
  label: string;
  position_seconds: number;
  sort_order: number;
  created_by: string | null;
  created_at: string;
}

/** Common section presets offered when adding a marker (custom labels also allowed). */
export const MARKER_PRESETS = [
  "Intro",
  "Verse",
  "Pre",
  "Hook",
  "Bridge",
  "Solo",
  "Outro",
] as const;

// ---------------------------------------------------------------------------
// Practice journal (Practice Mode Slice 3)
// ---------------------------------------------------------------------------
export type PracticeVisibility = "shared" | "staff";
export type PracticeCategory = "note" | "problem" | "summary" | "homework";

export const PRACTICE_CATEGORY_META: Record<
  PracticeCategory,
  { label: string; emoji: string }
> = {
  note: { label: "บันทึก", emoji: "📝" },
  problem: { label: "ปัญหา", emoji: "⚠️" },
  summary: { label: "สรุป", emoji: "✅" },
  homework: { label: "การบ้าน", emoji: "📌" },
};

export interface PracticeLog {
  id: string;
  tenant_id: string;
  group_id: string;
  event_id: string;
  log_date: string; // "YYYY-MM-DD"
  author_id: string | null;
  visibility: PracticeVisibility;
  category: PracticeCategory;
  body: string;
  target_member_id: string | null;
  done: boolean;
  created_at: string;
  updated_at: string;
}

export interface PracticeRun {
  id: string;
  tenant_id: string;
  group_id: string;
  event_id: string;
  song_id: string | null;
  song_title: string;
  seconds: number;
  last_speed: number;
  log_date: string;
  created_by: string | null;
  created_at: string;
}

export interface PracticeAttendance {
  id: string;
  tenant_id: string;
  group_id: string;
  event_id: string;
  log_date: string;
  member_id: string;
  present: boolean;
  created_at: string;
}

export interface Song {
  id: string;
  tenant_id: string;
  group_id: string;
  title: string;
  file_name: string | null;
  duration_seconds: number;
  language: string | null;
  category: string | null;
  copyright_status: CopyrightStatus;
  notes: string | null;
  audio_path?: string | null; // R2 object key for this song's audio (null = no file yet)
  audio_name?: string | null; // original filename, for display
  audio_expires_at?: string | null; // null = permanent; timestamp = temp (ad-hoc), auto-cleaned after
  bpm?: number | null; // tempo for the practice metronome (null = unset)
  created_at: string;
  updated_at: string;
}
