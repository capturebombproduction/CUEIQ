// ---------------------------------------------------------------------------
// Roles & permissions
// ---------------------------------------------------------------------------
export type Role =
  | "platform_admin"
  | "tenant_owner"
  | "label_staff"
  | "artist_manager"
  | "sound_engineer"
  | "lighting"
  | "general_staff";

export const ROLE_LABELS: Record<Role, string> = {
  platform_admin: "Platform Admin",
  tenant_owner: "Tenant Owner (เจ้าของค่าย)",
  label_staff: "Label Staff (ทีมค่าย)",
  artist_manager: "Artist Manager (ผู้จัดการวง)",
  sound_engineer: "Sound Engineer (ซาวด์)",
  lighting: "Lighting (ไฟ)",
  general_staff: "General Staff (ทีมงาน)",
};

export const ROLE_SHORT: Record<Role, string> = {
  platform_admin: "Admin",
  tenant_owner: "Owner",
  label_staff: "Label",
  artist_manager: "Manager",
  sound_engineer: "Sound",
  lighting: "Light",
  general_staff: "Staff",
};

/** Roles allowed to sign up themselves in the MVP. */
export const SIGNUP_ROLES: Role[] = [
  "artist_manager",
  "label_staff",
  "sound_engineer",
  "lighting",
  "general_staff",
];

/** Roles that can create / edit shows. Others are read-only. */
export const EDITOR_ROLES: Role[] = [
  "platform_admin",
  "tenant_owner",
  "label_staff",
  "artist_manager",
];

export function canEdit(role: Role | null | undefined): boolean {
  return !!role && EDITOR_ROLES.includes(role);
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
  created_at: string;
  updated_at: string;
}
