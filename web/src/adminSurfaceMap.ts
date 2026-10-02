// Admin surface parity map — the one registry linking the classic admin surface
// (#/preferences, PreferencesWorkspace.tsx) to the new admin desk (#/admin/*,
// which since #537 includes the desk rail's More-tools pages: #/admin/ai,
// #/admin/style, #/admin/curate, #/admin/observe). Nothing imports this at runtime; it is
// documentation-as-data, enforced by adminSurfaceMap.test.mjs.
//
// THE RULE: when you add, move, or remove an admin-facing feature or section in
// EITHER UI, update this map. The test cross-checks it against
// PreferencesWorkspace's `Section` union and AdminDesk's nav lists, so an
// unregistered section/page fails `npm --workspace web run test` with
// instructions. A feature that exists in classic but has no desk home yet must
// declare `gapIssue` (the GitHub issue tracking the port) — every parity hole
// stays visible and tracked.

export type ClassicSurface = {
  /** Section id — must be a member of PreferencesWorkspace's `Section` union. */
  section: string;
  /** web/-relative file that renders it. */
  file: string;
};

export type DeskSurface = {
  /**
   * AdminDesk nav identity: an `AdminSection` key — every rail entry (the top
   * 4 admin sections and the four former pill-bar "More tools" pages) is one
   * since #186 unified them onto the same union ("progress", "setup", "ai", …).
   */
  page: string;
  /** web/-relative file that renders the feature on the desk side. */
  file: string;
  /** Literal string that must appear in `file` (comment-stripped). Prefer a JSX mount ("<XPanel") or definition ("function XScreen") so a comment or import can't satisfy it. */
  anchor: string;
};

export type AdminSurfaceEntry = {
  id: string;
  label: string;
  classic: ClassicSurface | null;
  desk: DeskSurface | null;
  /** Required when `classic` exists but `desk` is null: the GitHub issue tracking the port. */
  gapIssue?: number;
  notes?: string;
};

const PREFS = "src/components/PreferencesWorkspace.tsx";
const ADMIN_SETUP = "src/components/flows/AdminSetupScreen.tsx";
const STYLE = "src/components/flows/StyleScreen.tsx";

export const ADMIN_SURFACES: AdminSurfaceEntry[] = [
  {
    id: "brief",
    label: "Brief (audience / purpose / register)",
    classic: { section: "brief", file: PREFS },
    desk: { page: "style", file: STYLE, anchor: "<BriefPanel" },
  },
  {
    id: "instructions",
    label: "Instructions (AI prompt guidance)",
    classic: { section: "instructions", file: PREFS },
    desk: { page: "style", file: STYLE, anchor: "<MarkdownPrefPanel" },
  },
  {
    id: "commonIssues",
    label: "Common issues",
    classic: { section: "commonIssues", file: PREFS },
    desk: { page: "style", file: STYLE, anchor: "<MarkdownPrefPanel" },
    notes: "Both markdown prefs share MarkdownPrefPanel on the desk side (Style).",
  },
  {
    id: "terminology",
    label: "Terminology",
    classic: { section: "terminology", file: PREFS },
    desk: { page: "style", file: STYLE, anchor: "<TerminologySection" },
    notes:
      "Desk mounts the full shared editor (#190). Home is the Style page as of the post-#187 IA move (Setup is config-only).",
  },
  {
    id: "examples",
    label: "Examples (validated few-shot memory)",
    classic: { section: "examples", file: PREFS },
    desk: { page: "style", file: STYLE, anchor: "<ExamplesPanel" },
  },
  {
    id: "setupWizard",
    label: "Setup wizard (org / sources / lanes)",
    classic: { section: "setup", file: PREFS },
    desk: { page: "setup", file: ADMIN_SETUP, anchor: "<SetupWizard" },
    notes: "Both sides mount the shared SetupWizard component.",
  },
  {
    id: "localization",
    label: "Localization (UI string overrides)",
    classic: { section: "localization", file: PREFS },
    desk: { page: "setup", file: ADMIN_SETUP, anchor: "<LocalizationSection" },
  },
  {
    id: "users",
    label: "Users / Team & roles",
    classic: { section: "users", file: PREFS },
    desk: { page: "team", file: "src/components/flows/AdminTeamScreen.tsx", anchor: "function AdminTeamScreen" },
    notes: "Desk re-implements the role mapping rather than reusing UserManagementSection.",
  },
  {
    id: "aiService",
    label: "AI service (provider / model / API key)",
    classic: { section: "aiService", file: PREFS },
    desk: { page: "ai", file: "src/components/flows/AiScreen.tsx", anchor: "<AiServiceSection" },
    notes: "Moved from the admin Setup desk to the AI studio (#/admin/ai; #/ai until #537) under #479 so config and use share one screen. Classic #/preferences keeps its copy until classic retires (#173).",
  },
  {
    id: "progress",
    label: "Progress dashboard",
    classic: null,
    desk: { page: "progress", file: "src/components/flows/AdminProgressScreen.tsx", anchor: "function AdminProgressScreen" },
  },
  {
    id: "workflow",
    label: "Workflow (steps / pipeline / sources / publishing)",
    classic: null,
    desk: { page: "workflow", file: "src/components/flows/AdminWorkflowScreen.tsx", anchor: "function AdminWorkflowScreen" },
  },
  {
    id: "export-chapter-scope",
    label: "Precise Door43 export (resource + chapter range scoping)",
    classic: null,
    desk: {
      page: "workflow",
      file: "src/components/flows/AdminWorkflowScreen.tsx",
      anchor: "<ExportScopeFields",
    },
    notes:
      "\"Run export now\" confirm dialog: scope a manual export to one resource (tn/tq/twl/ult/ust) and, for tn/tq/twl on a specific book, a chapter range — e.g. \"Mark 13-14 translation notes\" instead of the whole book.",
  },
  {
    id: "reviewState",
    label: "Review state (bulk-approve or reopen a chapter range for tn / tq)",
    classic: null,
    desk: {
      page: "review",
      file: "src/components/flows/AdminReviewStateScreen.tsx",
      anchor: "function AdminReviewStateScreen",
    },
    notes:
      "Desk-only by design (#296): new admin features land on the desk, and classic #/preferences is slated to retire (#173), so no classic port is planned. Calls POST /api/books/:book/review-state — dry run first, then an explicit confirm.",
  },
  {
    id: "aiPipelines",
    label: "AI studio (run AI pipelines)",
    classic: null,
    desk: { page: "ai", file: "src/components/flows/AiScreen.tsx", anchor: "function AiScreen" },
  },
  {
    id: "style",
    label: "Style (context pack / QA rules)",
    classic: null,
    desk: { page: "style", file: STYLE, anchor: "function StyleScreen" },
    notes: "Post-#187 IA move: Style is the desk home for the 'teach the AI' memory sections (Brief/Instructions/Common issues/Terminology/Examples) plus its own QA rules, template coverage, and context-pack export.",
  },
  {
    id: "templates",
    label: "Templates (note template curation)",
    classic: null,
    desk: { page: "templates", file: "src/components/flows/CurateScreen.tsx", anchor: "function CurateScreen" },
    notes: "Desk key \"templates\", hash #/admin/curate[/{templateId}] (#/curate until #537). Not the classic #/templates note-template workspace.",
  },
  {
    id: "observe",
    label: "Observe (health / exports / crons)",
    classic: null,
    desk: { page: "observe", file: "src/components/flows/ObserveScreen.tsx", anchor: "function ObserveScreen" },
    notes: "Post-#187: workflow-stages preview + export triggers removed; keeps read-only export history and a pipeline count linking to AI studio.",
  },
];
