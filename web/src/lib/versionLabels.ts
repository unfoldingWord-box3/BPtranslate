import type { ProjectConfig } from "../sync/api";

// Map an internal role code (the `bible_version` key stored in D1) to the
// project's DISPLAY label. Role codes stay ULT/UST/UHB/UGNT everywhere in the
// data + logic; only the rendered text changes per project (e.g. GLT/GST for a
// Gateway Language, or a named literal like "Van Dyke" via config override).
//
// Falls back to the role code when the config is absent (first paint, offline)
// or carries an older schema without the originals labels — so the UI never
// renders an empty header.
export function versionLabel(cfg: ProjectConfig | null, roleCode: string): string {
  if (!cfg) return roleCode;
  switch (roleCode) {
    case "ULT":
      return cfg.litLabel || roleCode;
    case "UST":
      return cfg.simLabel || roleCode;
    case "UHB":
      return cfg.origHebrewLabel || roleCode;
    case "UGNT":
      return cfg.origGreekLabel || roleCode;
    default:
      return roleCode;
  }
}

// Text direction for a scripture pane. The originals are fixed by their script
// (Hebrew RTL, Greek LTR); every other pane (ULT/UST and any GL/reference
// bible) is in the project's own language, so it follows projectConfig.direction
// — that's what makes an Arabic AVD/NAV pane read RTL even when the UI chrome is
// LTR. This is direction ONLY; the Hebrew-original's larger font/size is keyed
// separately (bibleVersion === "UHB") so RTL target text keeps the normal
// reading font.
export function versionIsRtl(cfg: ProjectConfig | null, roleCode: string): boolean {
  if (roleCode === "UHB") return true;
  if (roleCode === "UGNT") return false;
  return cfg?.direction === "rtl";
}

// Tri-state direction (issue #451): null means "not known yet". versionIsRtl
// above answers false for a target lane while the config is still null (first
// load, or offline with nothing cached), which paints Arabic lanes LTR. A
// screen that must not guess waits on null instead.
export function versionDirection(
  cfg: Pick<ProjectConfig, "direction"> | null,
  roleCode: string,
): "rtl" | "ltr" | null {
  if (roleCode === "UHB") return "rtl";
  if (roleCode === "UGNT") return "ltr";
  if (!cfg) return null;
  return cfg.direction === "rtl" ? "rtl" : "ltr";
}
