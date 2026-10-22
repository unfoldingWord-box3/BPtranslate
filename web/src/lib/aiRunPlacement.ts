// Where a flow screen puts its "start an AI run" trigger (#481). Pure, so the
// rule is unit-tested without a browser (aiRunPlacement.test.mjs).
//
// Decision A on #481: on tablet and desktop the trigger sits in the screen's
// top bar; at the phone band it moves into the screen's overflow ("more")
// menu, so the phone header (#517) gets no more crowded. Viewers get nothing.

import type { LayoutBand } from "./layoutBands.ts";
import type { Role } from "../sync/api.ts";

export type AiRunPlacement = "hidden" | "topbar" | "overflow";

/** Mirrors the server's `requireEditor` (api/src/auth.ts), which gates every AI route. */
export function canRunAi(role: Role): boolean {
  return role === "admin" || role === "editor";
}

export function aiRunPlacement(role: Role, band: LayoutBand): AiRunPlacement {
  if (!canRunAi(role)) return "hidden";
  return band === "phone" ? "overflow" : "topbar";
}
