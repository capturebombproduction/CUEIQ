import { describe, expect, it } from "vitest";
import type { Group } from "@/lib/types";
import {
  canApprove,
  canCreateAnyEvent,
  canEditAnyGroup,
  canEditGroup,
  canEditPhotoTime,
  canLiveEdit,
  canOpenEventDetail,
  canViewGroup,
  canViewLibrary,
  canViewOverview,
  editableGroups,
  groupRoleOf,
  isAdmin,
  isLabelWideUser,
  makePerms,
  viewableGroups,
} from "./permissions";

// Two bands. Every "can this user touch band X?" rule is exercised against the
// band they belong to AND a band they don't, so a regression that leaks one
// band's data/edit rights to another user fails here.
const A = "band-a";
const B = "band-b";
const g = (id: string): Group => ({ id, tenant_id: "t1", name: id } as unknown as Group);
const groups = [g(A), g(B)];

// One Perms per role in the model (see lib/types ADMIN_ROLES / LABEL_WIDE_ROLES /
// APPROVER_ROLES). Band-tier users carry no tenant role, only a group_roles row.
const admin = makePerms("admin");
const ceo = makePerms("ceo");
const labelStaff = makePerms("label_staff");
const arA = makePerms(null, [{ group_id: A, role: "artist_manager" }]);
const memberA = makePerms(null, [{ group_id: A, role: "member" }]);
const nobody = makePerms(null, []);

describe("groupRoleOf", () => {
  it("returns the row's role for a band the user belongs to", () => {
    expect(groupRoleOf(arA, A)).toBe("artist_manager");
    expect(groupRoleOf(memberA, A)).toBe("member");
  });
  it("returns null for a band the user has no row for", () => {
    expect(groupRoleOf(arA, B)).toBeNull();
    expect(groupRoleOf(nobody, A)).toBeNull();
  });
});

describe("tenant-tier checks", () => {
  it("isAdmin is admin-only", () => {
    expect(isAdmin(admin)).toBe(true);
    for (const p of [ceo, labelStaff, arA, memberA, nobody]) {
      expect(isAdmin(p)).toBe(false);
    }
  });
  it("isLabelWideUser is admin / ceo / label_staff", () => {
    for (const p of [admin, ceo, labelStaff]) expect(isLabelWideUser(p)).toBe(true);
    for (const p of [arA, memberA, nobody]) expect(isLabelWideUser(p)).toBe(false);
  });
  it("canApprove is admin / label_staff (not ceo)", () => {
    expect(canApprove(admin)).toBe(true);
    expect(canApprove(labelStaff)).toBe(true);
    expect(canApprove(ceo)).toBe(false);
    expect(canApprove(arA)).toBe(false);
  });
});

describe("canViewGroup — visibility never leaks across bands", () => {
  it("label-wide users see every band", () => {
    for (const p of [admin, ceo, labelStaff]) {
      expect(canViewGroup(p, A)).toBe(true);
      expect(canViewGroup(p, B)).toBe(true);
    }
  });
  it("a band-tier user sees only their own band", () => {
    expect(canViewGroup(arA, A)).toBe(true);
    expect(canViewGroup(arA, B)).toBe(false);
    expect(canViewGroup(memberA, A)).toBe(true);
    expect(canViewGroup(memberA, B)).toBe(false);
  });
  it("a user with no roles sees nothing", () => {
    expect(canViewGroup(nobody, A)).toBe(false);
  });
});

describe("canEditGroup — edit is admin or the band's Ar only", () => {
  it("admin may edit any band", () => {
    expect(canEditGroup(admin, A)).toBe(true);
    expect(canEditGroup(admin, B)).toBe(true);
  });
  it("ceo / label_staff can view all but edit none", () => {
    for (const p of [ceo, labelStaff]) {
      expect(canEditGroup(p, A)).toBe(false);
      expect(canEditGroup(p, B)).toBe(false);
    }
  });
  it("an Ar edits only their own band; a member edits nothing", () => {
    expect(canEditGroup(arA, A)).toBe(true);
    expect(canEditGroup(arA, B)).toBe(false);
    expect(canEditGroup(memberA, A)).toBe(false);
  });
});

describe("page-level gates", () => {
  it("canViewOverview: label-wide or any band membership", () => {
    for (const p of [admin, ceo, labelStaff, arA, memberA]) {
      expect(canViewOverview(p)).toBe(true);
    }
    expect(canViewOverview(nobody)).toBe(false);
  });
  it("canViewLibrary: label_staff is proof-only and excluded", () => {
    expect(canViewLibrary(labelStaff)).toBe(false);
    for (const p of [admin, ceo, arA, memberA]) expect(canViewLibrary(p)).toBe(true);
    expect(canViewLibrary(nobody)).toBe(false);
  });
  it("canCreateAnyEvent / canEditAnyGroup: admin or an Ar somewhere", () => {
    for (const p of [admin, arA]) {
      expect(canCreateAnyEvent(p)).toBe(true);
      expect(canEditAnyGroup(p)).toBe(true);
    }
    for (const p of [ceo, labelStaff, memberA, nobody]) {
      expect(canCreateAnyEvent(p)).toBe(false);
      expect(canEditAnyGroup(p)).toBe(false);
    }
  });
  it("canOpenEventDetail is open to everyone (page scopes by canViewGroup)", () => {
    expect(canOpenEventDetail()).toBe(true);
  });
  it("canLiveEdit is admin-only", () => {
    expect(canLiveEdit(admin)).toBe(true);
    for (const p of [ceo, labelStaff, arA, memberA]) expect(canLiveEdit(p)).toBe(false);
  });
});

describe("group filters scope to the right bands", () => {
  it("viewableGroups", () => {
    expect(viewableGroups(admin, groups).map((x) => x.id)).toEqual([A, B]);
    expect(viewableGroups(arA, groups).map((x) => x.id)).toEqual([A]);
    expect(viewableGroups(nobody, groups)).toEqual([]);
  });
  it("editableGroups", () => {
    expect(editableGroups(admin, groups).map((x) => x.id)).toEqual([A, B]);
    expect(editableGroups(arA, groups).map((x) => x.id)).toEqual([A]);
    expect(editableGroups(memberA, groups)).toEqual([]);
    expect(editableGroups(ceo, groups)).toEqual([]);
  });
});

describe("canEditPhotoTime", () => {
  it("a band editor may always set their own band's photo time", () => {
    expect(canEditPhotoTime(admin, A, true)).toBe(true);
    expect(canEditPhotoTime(arA, A, true)).toBe(true);
  });
  it("an approver may set it only when the band does NOT self-manage photos", () => {
    expect(canEditPhotoTime(labelStaff, B, false)).toBe(true);
    expect(canEditPhotoTime(labelStaff, B, true)).toBe(false);
  });
  it("a non-editor non-approver may never set it", () => {
    expect(canEditPhotoTime(ceo, B, false)).toBe(false);
    expect(canEditPhotoTime(memberA, A, false)).toBe(false);
    expect(canEditPhotoTime(arA, B, false)).toBe(false);
  });
});
