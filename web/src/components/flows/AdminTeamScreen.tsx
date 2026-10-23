// i18n: user-visible strings use t() with keys under the `adminPages`
// namespace (en/ar values pending merge into web/src/i18n/locales/*.json).
//
// AdminTeamScreen — the redesigned admin "Team & roles" screen, rendered inside
// the coordinator-owned AdminDesk chrome (route #/admin/team). Desktop-first
// per Benjamin's 2026-08-10 direction, translated from his published mockup
// artifact "Team & Roles — unfoldingWord" into the MUI/sx idiom the flow
// screens use (TranslateNotesScreen is the token reference; the .panel /
// .panel-top / .panel-body / .panel-foot primitives come from the artifact's
// desk-class CSS).
//
// ── What shipped vs. the mockup (honesty rule: Today only) ──────────────────
//
// The artifact tiers its four sections Today / Phase 2 / Later. Only the two
// "Today" sections are built here, wired to the real API; proposal panels must
// not ship inert. Verb → endpoint evidence:
//
//   * List people          → api.adminListUsers()            web/src/sync/api.ts:2252
//                            GET  /api/admin/users            api/src/adminUserRoutes.ts:66
//   * Change a role        → api.adminSetUserRole(u, role)   web/src/sync/api.ts:2262
//                            PUT  /api/admin/users/:username  api/src/adminUserRoutes.ts:395
//                            (role is "admin"|"editor" ONLY — viewers are not
//                            allowlist rows, api.ts:603-605 — so the role chip
//                            toggles admin↔editor, not the mockup's 3-way cycle)
//   * Add a person         → same PUT (upsert by username)   api/src/adminUserRoutes.ts:395
//   * Remove a person      → api.adminRemoveUser(u)          web/src/sync/api.ts:2267
//                            DELETE /api/admin/users/:username api/src/adminUserRoutes.ts:522
//   * Purge manual grants  → api.adminPurgeManualGrants()    web/src/sync/api.ts:2278
//                            POST /api/admin/users/purge-manual api/src/adminUserRoutes.ts:332
//   * Live Door43 roster   → api.adminListOrgMembers()       web/src/sync/api.ts:2257
//                            GET  /api/admin/users/org-members api/src/adminUserRoutes.ts:251
//
// Server-enforced semantics surfaced (not re-invented) here:
//   * last-admin guard — the server 409s "last_admin" (adminUserRoutes.ts:493,
//     :555). The sole remaining admin's chip stays tappable so the tap can
//     explain itself (mockup's .role-chip-locked note), but no request is sent.
//   * team precedence — editing a Door43-team-managed row is ACCEPTED and the
//     response carries wasTeamManaged; team sync re-takes the row at that
//     user's next sign-in (api.ts:2258-2261). There is NO server-side "stash /
//     auto-restore" of manual grants — the mockup's stash/undo affordance is
//     omitted rather than faked.
//   * degraded roster reads — GET org-members fails soft: a 200 can carry
//     { error, members: [] } (e.g. "dcs_401_public_only"), a public-members
//     fallback (partial) or a page-capped read (truncated). None of those are
//     evidence of an empty org, and an unconfigured workspace (org: null) has
//     no roster evidence at all — the "not on the Door43 org" flag only renders
//     against a genuinely complete roster. Logic carried over from
//     TeamScreen.tsx:166-179, which documents the findings trail.
//
// Omitted from the mockup, and why:
//   * Pairs section        — Phase 2 in the artifact; no pair model anywhere in
//                            the API. Future: pair cards + move-person select.
//   * Invitations section  — Phase 2; no invitation endpoints. The live verb
//                            that exists TODAY — add a Door43 username to the
//                            allowlist via the same PUT — is kept as the "Add a
//                            person" form instead. Future: invite-by-handle
//                            with pre-assigned role/pair, pending-invite table.
//   * "Last active" column — no such field on AdminUser (api.ts:606-613) or
//                            OrgMember (api.ts:616-625). Never invent data.
//   * "Sync now" button    — no sync-trigger endpoint; team sync runs at each
//                            user's sign-in. The roster panel's Refresh button
//                            re-fetches the live read (a real GET), which is
//                            all "sync now" could honestly do from here.
//   * "Pair" column, tier legend chips — mockup furniture for the proposal
//                            review, meaningless in a live app.
//
// RTL: logical properties only (paddingInline/Block, borderBlockEnd,
// marginInlineStart, textAlign:start). No physical left/right anywhere.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  Alert,
  Box,
  Button,
  ButtonBase,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Snackbar,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import RefreshIcon from "@mui/icons-material/Refresh";

import { AdminDesk } from "./AdminDesk";
import { AdminPageHeader } from "./AdminPageHeader";
import type { FlowScreenContext } from "./types";
import {
  api,
  ApiError,
  type AdminUser,
  type OrgMember,
  type OrgMembersResponse,
} from "../../sync/api";
import { formatDate } from "../../lib/formatDate";

export interface AdminTeamScreenProps extends FlowScreenContext {}

const INSPIRE = "#31ADE3";
const INSPIRE_DEEP = "#1B84B8";

// The allowlist holds exactly these two roles; viewer access comes from Door43
// org membership, never from a user_roles row (api.ts:603-605). Labels are
// i18n key names, translated at render.
const ROLE_OPTIONS: Array<{ value: "admin" | "editor"; labelKey: string }> = [
  { value: "editor", labelKey: "adminPages.common.roleEditor" },
  { value: "admin", labelKey: "adminPages.common.roleAdmin" },
];

// What each role can actually do — grounded in the real gating, not the
// mockup's proposal copy: Setup and user management are admin-only surfaces;
// viewer sessions get the global read-only banner and every mutating request
// outside a small self-scoped allowlist is 403'd server-side
// (blockViewerWrites — see the gating notes ported from TeamScreen.tsx:534-541).
// i18n key names, translated at render.
const ROLE_PERM_KEYS: Record<"admin" | "editor", string[]> = {
  admin: [
    "adminPages.team.permAdminEverything",
    "adminPages.team.permAdminSetup",
    "adminPages.team.permAdminManagePeople",
  ],
  editor: ["adminPages.team.permEditorWrite", "adminPages.team.permEditorNoSetup"],
};

// Bare allowlist error codes (api/src/adminUserRoutes.ts) rendered as
// translated text — same mapping as TeamScreen.tsx / UserManagementSection.tsx.
function errorMessage(t: TFunction, e: unknown): string {
  const code = e instanceof ApiError ? (e.body as { error?: string } | undefined)?.error : undefined;
  switch (code) {
    case "invalid_username":
      return t("adminPages.team.errInvalidUsername");
    case "dcs_user_not_found":
      return t("adminPages.team.errDcsUserNotFound");
    case "last_admin":
      return t("adminPages.team.errLastAdmin");
    case "not_found":
      return t("adminPages.team.errNotFound");
    default:
      return e instanceof ApiError
        ? `${e.status} — ${code ?? t("adminPages.team.errRequestFailed")}`
        : t("adminPages.team.errRequestFailed");
  }
}

function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const a = words[0]?.charAt(0) ?? "?";
  const b = words.length > 1 ? words[words.length - 1].charAt(0) : "";
  return (a + b).toUpperCase();
}

function formatAddedAt(addedAt: number | null): string | null {
  if (addedAt == null) return null;
  // added_at is unixepoch() seconds (api/migrations/0016_user_roles.sql:12).
  return formatDate(addedAt * 1000) || null;
}

// ── shared chrome ────────────────────────────────────────────────────────────

// .panel / .panel-top / .panel-body / .panel-foot from the artifact's
// desk-class primitives, in the sx idiom. The foot states live data on the
// inline-start side and the next action at the inline-end.
function Panel({
  title,
  sub,
  topAction,
  flush,
  children,
  foot,
}: {
  title: string;
  sub?: string;
  topAction?: ReactNode;
  flush?: boolean;
  children: ReactNode;
  foot?: ReactNode;
}) {
  const theme = useTheme();
  const dark = theme.palette.mode === "dark";
  return (
    <Box
      component="section"
      sx={{
        bgcolor: "background.paper",
        border: "1px solid",
        borderColor: "divider",
        borderRadius: "14px",
        boxShadow: dark
          ? "0 1px 2px rgba(0,0,0,0.3), 0 6px 20px rgba(0,0,0,0.35)"
          : "0 1px 2px rgba(1,66,99,0.05), 0 6px 20px rgba(1,66,99,0.08)",
        overflow: "hidden",
        mb: 2,
      }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 1.5,
          paddingInline: 2,
          paddingBlock: 1.5,
          borderBlockEnd: "1px solid",
          borderColor: "divider",
        }}
      >
        <Typography component="h2" sx={{ fontSize: "1rem", fontWeight: 700, letterSpacing: "-0.01em" }}>
          {title}
        </Typography>
        {topAction && <Box sx={{ marginInlineStart: "auto" }}>{topAction}</Box>}
        {sub && (
          <Typography variant="body2" color="text.secondary" sx={{ width: "100%", mt: 0.25 }}>
            {sub}
          </Typography>
        )}
      </Box>
      <Box sx={{ p: flush ? 0 : 2 }}>{children}</Box>
      {foot && (
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 1.5,
            paddingInline: 2,
            paddingBlock: 1.25,
            borderBlockStart: "1px solid",
            borderColor: "divider",
            bgcolor: "action.hover",
            fontSize: "0.8125rem",
            color: "text.secondary",
          }}
        >
          {foot}
        </Box>
      )}
    </Box>
  );
}

const thSx = {
  position: "sticky" as const,
  insetBlockStart: 0,
  zIndex: 2,
  bgcolor: "action.hover",
  textAlign: "start" as const,
  fontSize: "0.6875rem",
  fontWeight: 700,
  letterSpacing: "0.07em",
  textTransform: "uppercase" as const,
  color: "text.secondary",
  paddingBlock: 1.125,
  paddingInline: 1.75,
  borderBlockEnd: "1px solid",
  borderColor: "divider",
  whiteSpace: "nowrap" as const,
};

const tdSx = {
  paddingBlock: 1.375,
  paddingInline: 1.75,
  borderBlockEnd: "1px solid",
  borderColor: "divider",
  verticalAlign: "middle" as const,
};

function PersonAvatar({ name, avatarUrl, size = 36 }: { name: string; avatarUrl?: string; size?: number }) {
  if (avatarUrl) {
    return (
      <Box
        component="img"
        src={avatarUrl}
        alt=""
        sx={{ width: size, height: size, borderRadius: "50%", flex: "none", display: "block" }}
      />
    );
  }
  return (
    <Box
      aria-hidden
      sx={{
        width: size,
        height: size,
        borderRadius: "50%",
        bgcolor: "#014263",
        color: "#fff",
        fontSize: "0.8125rem",
        fontWeight: 700,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flex: "none",
      }}
    >
      {initialsOf(name)}
    </Box>
  );
}

// ── screen ───────────────────────────────────────────────────────────────────

export default function AdminTeamScreen({ role, me }: AdminTeamScreenProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  const dark = theme.palette.mode === "dark";
  const { ok } = theme.palette.flows;
  // --hl from the artifact tokens: the selected-row / admin-chip ground.
  const HL = dark ? "rgba(49, 173, 227, 0.26)" : "rgba(49, 173, 227, 0.18)";
  const ACCENT = dark ? INSPIRE : INSPIRE_DEEP;

  const isAdmin = role === "admin";

  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [usersError, setUsersError] = useState(false);
  const [orgMembers, setOrgMembers] = useState<OrgMembersResponse | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const [newUsername, setNewUsername] = useState("");
  const [newRole, setNewRole] = useState<"admin" | "editor">("editor");
  const [adding, setAdding] = useState(false);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [purging, setPurging] = useState(false);
  const [rosterRefreshing, setRosterRefreshing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const loadAllowlist = useCallback(async () => {
    setUsersError(false);
    try {
      const { users } = await api.adminListUsers();
      setUsers(users);
    } catch {
      setUsersError(true);
    }
  }, []);

  const loadRoster = useCallback(async () => {
    setRosterRefreshing(true);
    try {
      setOrgMembers(await api.adminListOrgMembers());
    } catch {
      // Network failure reaching our own API (distinct from a degraded-but-200
      // Door43 read, which arrives as OrgMembersResponse.error below).
      setOrgMembers({ org: "", members: [], error: "network", truncated: false });
    } finally {
      setRosterRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount-time loaders; the same loadAllowlist/loadRoster back the Retry and Refresh buttons and run after each role change, so they clear the error or set refreshing at start.
    void loadAllowlist();
    void loadRoster();
  }, [isAdmin, loadAllowlist, loadRoster]);

  // Degraded-roster discipline carried over from TeamScreen.tsx:166-179: an
  // errored, partial, truncated, or org-less roster is never evidence that a
  // person is missing from the org.
  const rosterDegraded = !!orgMembers?.error || !!orgMembers?.partial || !!orgMembers?.truncated;
  const rosterUsable = !!orgMembers && !!orgMembers.org && !rosterDegraded;
  const rosterByLogin = useMemo(() => {
    const map = new Map<string, OrgMember>();
    for (const m of orgMembers?.members ?? []) map.set(m.login.toLowerCase(), m);
    return map;
  }, [orgMembers]);

  const adminCount = useMemo(
    () => (users ?? []).filter((u) => u.role === "admin").length,
    [users],
  );
  const editorCount = (users ?? []).length - adminCount;
  const manualUsers = (users ?? []).filter((u) => (u.source ?? "manual") === "manual");
  const allowlistByUsername = useMemo(() => {
    const map = new Map<string, AdminUser>();
    for (const u of users ?? []) map.set(u.username.toLowerCase(), u);
    return map;
  }, [users]);

  const selectedUser = selected ? (allowlistByUsername.get(selected.toLowerCase()) ?? null) : null;

  const handleToggleRole = async (u: AdminUser) => {
    // Client-side courtesy for the server's last_admin 409
    // (adminUserRoutes.ts:493): explain instead of round-tripping a failure.
    if (u.role === "admin" && adminCount === 1) {
      setMsg(t("adminPages.team.lastAdminExplain"));
      return;
    }
    const next = u.role === "admin" ? "editor" : "admin";
    setRowBusy(u.username);
    try {
      const res = await api.adminSetUserRole(u.username, next);
      let text = t("adminPages.team.userNowRole", { username: u.username, role: next });
      if (res.wasTeamManaged) text += ` ${t("adminPages.team.teamWinsBackSuffix")}`;
      setMsg(text);
    } catch (e) {
      setMsg(errorMessage(t, e));
    } finally {
      setRowBusy(null);
    }
    await loadAllowlist();
  };

  const handleAdd = async () => {
    const username = newUsername.trim();
    if (!username) return;
    setAdding(true);
    try {
      const res = await api.adminSetUserRole(username, newRole);
      let text = t("adminPages.team.addedUserAs", { username, role: newRole });
      if (!res.dcsVerified) text += ` ${t("adminPages.team.addedUnverifiedSuffix")}`;
      setMsg(text);
      setNewUsername("");
      setNewRole("editor");
    } catch (e) {
      setMsg(errorMessage(t, e));
    } finally {
      setAdding(false);
    }
    await loadAllowlist();
  };

  const handleRemove = async (u: AdminUser) => {
    if (!window.confirm(t("adminPages.team.removeConfirm", { username: u.username }))) return;
    setRowBusy(u.username);
    try {
      const res = await api.adminRemoveUser(u.username);
      setMsg(
        res.wasTeamDerived
          ? t("adminPages.team.removedUserTeamDerived", { username: u.username })
          : t("adminPages.team.removedUser", { username: u.username }),
      );
      if (selected?.toLowerCase() === u.username.toLowerCase()) setSelected(null);
    } catch (e) {
      setMsg(errorMessage(t, e));
    } finally {
      setRowBusy(null);
    }
    await loadAllowlist();
  };

  const handlePurge = async () => {
    setPurging(true);
    try {
      const res = await api.adminPurgeManualGrants();
      setMsg(
        res.kept.length
          ? t("adminPages.team.purgeRemovedKept", { count: res.removed.length, kept: res.kept.join(", ") })
          : t("adminPages.team.purgeRemoved", { count: res.removed.length }),
      );
    } catch (e) {
      setMsg(errorMessage(t, e));
    } finally {
      setPurging(false);
      setPurgeOpen(false);
    }
    await loadAllowlist();
  };

  if (!isAdmin) {
    return (
      <AdminDesk current="team">
        <Alert severity="info">{t("adminPages.team.adminOnlyAlert", { role })}</Alert>
      </AdminDesk>
    );
  }

  const roleChip = (u: AdminUser) => {
    const isLastAdmin = u.role === "admin" && adminCount === 1;
    const teamManaged = u.source === "dcs_team";
    const busy = rowBusy === u.username;
    const title = isLastAdmin
      ? t("adminPages.team.chipLastAdminTip")
      : teamManaged
        ? t("adminPages.team.chipTeamManagedTip")
        : t("adminPages.team.chipChangeRoleTip");
    return (
      // The span keeps Tooltip working while the button is disabled (busy) —
      // MUI can't attach listeners to a disabled element directly.
      <Tooltip title={title}>
        <Box component="span" sx={{ display: "inline-flex" }}>
        <ButtonBase
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation();
            void handleToggleRole(u);
          }}
          sx={{
            borderRadius: "999px",
            paddingBlock: 0.375,
            paddingInline: 1.25,
            fontSize: "0.75rem",
            fontWeight: 600,
            whiteSpace: "nowrap",
            display: "inline-flex",
            alignItems: "center",
            gap: 0.75,
            ...(u.role === "admin"
              ? { bgcolor: HL, color: ACCENT }
              : { bgcolor: ok.soft, color: ok.ink }),
            // The sole remaining admin stays tappable so the tap can explain
            // itself (the handler answers without calling the API).
            ...(isLastAdmin && { opacity: 0.8, boxShadow: `inset 0 0 0 1px ${theme.palette.divider}` }),
            ...(busy && { opacity: 0.55 }),
          }}
        >
          {busy && <CircularProgress size={12} color="inherit" />}
          {u.role === "admin" ? t("adminPages.common.roleAdmin") : t("adminPages.common.roleEditor")}
        </ButtonBase>
        </Box>
      </Tooltip>
    );
  };

  const sourceCell = (u: AdminUser) => {
    const teamManaged = u.source === "dcs_team";
    return (
      <Box sx={{ display: "flex", flexDirection: "column", gap: 0.375 }}>
        <Typography component="span" sx={{ fontSize: "0.8125rem" }}>
          {teamManaged ? t("adminPages.team.sourceDoor43Team") : t("adminPages.team.sourceManualGrant")}
          {u.addedBy ? ` · ${t("adminPages.team.byUser", { name: u.addedBy })}` : ""}
        </Typography>
        {teamManaged && (
          <Typography component="span" sx={{ fontSize: "0.75rem", fontWeight: 600, color: ACCENT }}>
            {t("adminPages.team.teamWinsNote")}
          </Typography>
        )}
      </Box>
    );
  };

  return (
    <AdminDesk current="team">
      <AdminPageHeader
        eyebrow={
          orgMembers?.org
            ? t("adminPages.team.eyebrowOrg", { org: orgMembers.org })
            : t("adminPages.team.eyebrowFallback")
        }
        title={t("adminPages.team.title")}
        subtitle={t("adminPages.team.subtitle")}
      />

      {/* ── People ─────────────────────────────────────────────────────── */}
      <Panel
        title={t("adminPages.team.peopleTitle")}
        sub={t("adminPages.team.peopleSub")}
        flush
        foot={
          <>
            <Typography variant="caption" sx={{ fontVariantNumeric: "tabular-nums" }}>
              {users === null
                ? usersError
                  ? t("adminPages.team.loadFailed")
                  : t("common.loading")
                : `${t("adminPages.team.peopleCount", { count: users.length })} · ${t("adminPages.team.adminCount", { count: adminCount })} · ${t("adminPages.team.editorCount", { count: editorCount })}`}
            </Typography>
            <Box sx={{ marginInlineStart: "auto" }} />
            <Button
              size="small"
              color="warning"
              startIcon={<DeleteOutlineIcon fontSize="small" />}
              onClick={() => setPurgeOpen(true)}
              disabled={manualUsers.length === 0}
            >
              {t("adminPages.team.purgeButton")}
            </Button>
          </>
        }
      >
        {users === null ? (
          <Box sx={{ p: 2 }}>
            {usersError ? (
              <Alert
                severity="error"
                action={
                  <Button size="small" onClick={() => void loadAllowlist()}>
                    {t("common.retry")}
                  </Button>
                }
              >
                {t("adminPages.team.peopleLoadError")}
              </Alert>
            ) : (
              <CircularProgress size={22} />
            )}
          </Box>
        ) : users.length === 0 ? (
          <Typography color="text.secondary" sx={{ p: 2 }}>
            {t("adminPages.team.peopleEmpty")}
          </Typography>
        ) : (
          <>
            <Box sx={{ overflowX: "auto" }}>
              <Box
                component="table"
                sx={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem", minWidth: 640 }}
              >
                <Box component="thead">
                  <Box component="tr">
                    <Box component="th" sx={thSx}>
                      {t("adminPages.team.colPerson")}
                    </Box>
                    <Box component="th" sx={thSx}>
                      {t("adminPages.team.colRole")}
                    </Box>
                    <Box component="th" sx={thSx}>
                      {t("adminPages.team.colSourceOfRole")}
                    </Box>
                    <Box component="th" sx={thSx} aria-label={t("adminPages.team.colActions")} />
                  </Box>
                </Box>
                <Box component="tbody">
                  {users.map((u) => {
                    const key = u.username.toLowerCase();
                    const rosterMatch = rosterByLogin.get(key);
                    const isSelected = selected?.toLowerCase() === key;
                    const notMember = rosterUsable && !rosterByLogin.has(key);
                    const isMe = !!me?.username && me.username.toLowerCase() === key;
                    return (
                      <Box
                        component="tr"
                        key={u.username}
                        aria-selected={isSelected}
                        onClick={() => setSelected(isSelected ? null : u.username)}
                        sx={{
                          cursor: "pointer",
                          bgcolor: isSelected ? HL : "transparent",
                          "&:hover": { bgcolor: isSelected ? HL : "action.hover" },
                          "&:last-child td": { borderBlockEnd: "none" },
                        }}
                      >
                        <Box component="td" sx={tdSx}>
                          <Box sx={{ display: "flex", alignItems: "center", gap: 1.25 }}>
                            <PersonAvatar name={rosterMatch?.fullName || u.username} avatarUrl={rosterMatch?.avatarUrl} />
                            <Box sx={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                              <Typography component="span" sx={{ fontWeight: 700, fontSize: "0.9rem" }}>
                                {u.username}
                                {isMe ? ` ${t("adminPages.team.youSuffix")}` : ""}
                              </Typography>
                              {rosterMatch?.fullName && rosterMatch.fullName !== u.username && (
                                <Typography component="span" sx={{ fontSize: "0.78rem", color: "text.secondary" }}>
                                  {rosterMatch.fullName}
                                </Typography>
                              )}
                            </Box>
                            {notMember && (
                              <Tooltip title={t("adminPages.team.notOrgMemberTip")}>
                                <Chip
                                  size="small"
                                  variant="outlined"
                                  color="warning"
                                  label={t("adminPages.team.notOrgMemberChip")}
                                  sx={{ marginInlineStart: 0.5 }}
                                />
                              </Tooltip>
                            )}
                          </Box>
                        </Box>
                        <Box component="td" sx={tdSx}>
                          {roleChip(u)}
                        </Box>
                        <Box component="td" sx={tdSx}>
                          {sourceCell(u)}
                        </Box>
                        <Box component="td" sx={{ ...tdSx, textAlign: "end", whiteSpace: "nowrap" }}>
                          <Button
                            size="small"
                            color="error"
                            disabled={rowBusy === u.username}
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleRemove(u);
                            }}
                          >
                            {t("adminPages.team.removeButton")}
                          </Button>
                        </Box>
                      </Box>
                    );
                  })}
                </Box>
              </Box>
            </Box>

            {/* .detail-box — role-permission detail for the selected row. */}
            {selectedUser && (
              <Box
                sx={{
                  borderBlockStart: "1px solid",
                  borderColor: "divider",
                  bgcolor: "action.hover",
                  p: 2,
                }}
              >
                <Typography sx={{ fontWeight: 700, fontSize: "0.95rem" }}>
                  {selectedUser.username} —{" "}
                  {selectedUser.role === "admin"
                    ? t("adminPages.common.roleAdmin")
                    : t("adminPages.common.roleEditor")}
                </Typography>
                <Typography sx={{ fontSize: "0.8125rem", color: "text.secondary", mb: 1.5 }}>
                  {selectedUser.source === "dcs_team"
                    ? t("adminPages.team.roleFromTeam")
                    : t("adminPages.team.sourceManualGrant")}
                  {selectedUser.addedBy
                    ? ` · ${t("adminPages.team.addedByUser", { name: selectedUser.addedBy })}`
                    : ""}
                  {formatAddedAt(selectedUser.addedAt) ? ` · ${formatAddedAt(selectedUser.addedAt)}` : ""}
                </Typography>
                <Typography
                  sx={{
                    fontSize: "0.71875rem",
                    fontWeight: 700,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    color: "text.secondary",
                    mb: 0.5,
                  }}
                >
                  {selectedUser.role === "admin"
                    ? t("adminPages.team.whatAdminsCanDo")
                    : t("adminPages.team.whatEditorsCanDo")}
                </Typography>
                <Box component="ul" sx={{ m: 0, paddingInlineStart: 2.25, fontSize: "0.84rem", lineHeight: 1.6 }}>
                  {ROLE_PERM_KEYS[selectedUser.role === "admin" ? "admin" : "editor"].map((key) => (
                    <li key={key}>{t(key)}</li>
                  ))}
                </Box>
              </Box>
            )}
          </>
        )}
      </Panel>

      {/* ── Add a person ───────────────────────────────────────────────── */}
      <Panel
        title={t("adminPages.team.addPersonTitle")}
        sub={t("adminPages.team.addPersonSub")}
      >
        <Stack direction="row" spacing={1.5} alignItems="flex-end" flexWrap="wrap" useFlexGap>
          <TextField
            size="small"
            label={t("adminPages.team.usernameLabel")}
            placeholder={t("adminPages.team.usernamePlaceholder")}
            value={newUsername}
            onChange={(e) => setNewUsername(e.target.value)}
            sx={{ minWidth: 220 }}
          />
          <TextField
            select
            size="small"
            label={t("adminPages.team.roleLabel")}
            value={newRole}
            onChange={(e) => setNewRole(e.target.value as "admin" | "editor")}
            sx={{ minWidth: 140 }}
          >
            {ROLE_OPTIONS.map((opt) => (
              <MenuItem key={opt.value} value={opt.value}>
                {t(opt.labelKey)}
              </MenuItem>
            ))}
          </TextField>
          <Button
            variant="contained"
            onClick={() => void handleAdd()}
            disabled={adding || !newUsername.trim()}
            startIcon={adding ? <CircularProgress size={16} color="inherit" /> : undefined}
          >
            {t("adminPages.team.addButton")}
          </Button>
        </Stack>
      </Panel>

      {/* ── Door43 org roster ──────────────────────────────────────────── */}
      <Panel
        title={t("adminPages.team.rosterTitle")}
        sub={t("adminPages.team.rosterSub")}
        flush
        topAction={
          <Button
            size="small"
            startIcon={rosterRefreshing ? <CircularProgress size={14} color="inherit" /> : <RefreshIcon fontSize="small" />}
            onClick={() => void loadRoster()}
            disabled={rosterRefreshing}
          >
            {t("adminPages.common.refresh")}
          </Button>
        }
        foot={
          <Typography variant="caption" sx={{ fontVariantNumeric: "tabular-nums" }}>
            {orgMembers === null
              ? t("common.loading")
              : orgMembers.error
                ? `${t("adminPages.team.degradedRead", { error: orgMembers.error })}${orgMembers.partial ? ` ${t("adminPages.team.partialRosterSuffix")}` : ""}`
                : t("adminPages.team.memberCount", { count: orgMembers.members.length })}
          </Typography>
        }
      >
        {orgMembers === null ? (
          <Box sx={{ p: 2 }}>
            <CircularProgress size={22} />
          </Box>
        ) : (
          <>
            {(!orgMembers.org || rosterDegraded) && (
            <Box sx={{ p: 2, pb: 0 }}>
              {!orgMembers.org && (
                <Alert severity="info" sx={{ mb: 1.5 }}>
                  {t("adminPages.team.noOrgConfigured")}
                </Alert>
              )}
              {rosterDegraded && !orgMembers.partial && orgMembers.error && (
                <Alert severity="warning" sx={{ mb: 1.5 }}>
                  {t("adminPages.team.rosterReadFailed", { error: orgMembers.error })}
                </Alert>
              )}
              {orgMembers.partial && (
                <Alert severity="info" sx={{ mb: 1.5 }}>
                  {t("adminPages.team.publicFallback", {
                    reason: orgMembers.error ?? t("adminPages.team.teamRolesUnavailable"),
                  })}
                </Alert>
              )}
              {orgMembers.truncated && (
                <Alert severity="info" sx={{ mb: 1.5 }}>
                  {t("adminPages.team.rosterTruncated")}
                </Alert>
              )}
            </Box>
            )}
            {orgMembers.members.length === 0 ? (
              <Typography color="text.secondary" sx={{ p: 2, pt: 1.5 }}>
                {orgMembers.error
                  ? t("adminPages.team.noMembersReturnedWithError", { error: orgMembers.error })
                  : t("adminPages.team.noMembersReturned")}
              </Typography>
            ) : (
              <Box sx={{ overflowX: "auto" }}>
                <Box
                  component="table"
                  sx={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem", minWidth: 480 }}
                >
                  <Box component="thead">
                    <Box component="tr">
                      <Box component="th" sx={thSx}>
                        {t("adminPages.team.colMember")}
                      </Box>
                      <Box component="th" sx={thSx}>
                        {t("adminPages.team.colTeamRole")}
                      </Box>
                      <Box component="th" sx={thSx}>
                        {t("adminPages.team.colAccessHere")}
                      </Box>
                    </Box>
                  </Box>
                  <Box component="tbody">
                    {orgMembers.members.map((m) => {
                      const here = allowlistByUsername.get(m.login.toLowerCase());
                      return (
                        <Box
                          component="tr"
                          key={m.login}
                          sx={{ "&:last-child td": { borderBlockEnd: "none" } }}
                        >
                          <Box component="td" sx={tdSx}>
                            <Box sx={{ display: "flex", alignItems: "center", gap: 1.25 }}>
                              <PersonAvatar name={m.fullName || m.login} avatarUrl={m.avatarUrl} size={30} />
                              <Box sx={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                                <Typography component="span" sx={{ fontWeight: 600, fontSize: "0.875rem" }}>
                                  {m.login}
                                </Typography>
                                {m.fullName && m.fullName !== m.login && (
                                  <Typography component="span" sx={{ fontSize: "0.78rem", color: "text.secondary" }}>
                                    {m.fullName}
                                  </Typography>
                                )}
                              </Box>
                            </Box>
                          </Box>
                          <Box component="td" sx={{ ...tdSx, color: "text.secondary" }}>
                            {m.teamRole ?? "—"}
                          </Box>
                          <Box component="td" sx={{ ...tdSx, color: "text.secondary" }}>
                            {here
                              ? here.role === "admin"
                                ? t("adminPages.common.roleAdmin")
                                : t("adminPages.common.roleEditor")
                              : m.teamRole
                                ? t("adminPages.team.willBeOnFirstSignIn", {
                                    role:
                                      m.teamRole === "admin"
                                        ? t("adminPages.common.roleAdmin")
                                        : t("adminPages.common.roleEditor"),
                                  })
                                : t("adminPages.team.viewerReadOnly")}
                          </Box>
                        </Box>
                      );
                    })}
                  </Box>
                </Box>
              </Box>
            )}
            {/* .precedence-note — how team precedence actually works, stated to
                match the real backend (no stash/auto-restore is claimed). */}
            <Box
              sx={{
                m: 2,
                bgcolor: HL,
                borderRadius: "9px",
                paddingBlock: 1.25,
                paddingInline: 1.5,
                fontSize: "0.8125rem",
                color: "text.secondary",
              }}
            >
              <Box component="strong" sx={{ color: "text.primary" }}>
                {t("adminPages.team.precedenceHeading")}
              </Box>{" "}
              {t("adminPages.team.precedenceBody")}
            </Box>
          </>
        )}
      </Panel>

      <Dialog open={purgeOpen} onClose={() => !purging && setPurgeOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{t("adminPages.team.purgeDialogTitle")}</DialogTitle>
        <DialogContent>
          {manualUsers.length === 0 ? (
            <Typography variant="body2">{t("adminPages.team.purgeNothing")}</Typography>
          ) : (
            <Typography variant="body2">
              {t("adminPages.team.purgeDialogBody", { count: manualUsers.length })}
            </Typography>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPurgeOpen(false)} disabled={purging}>
            {t("common.cancel")}
          </Button>
          <Button
            color="warning"
            variant="contained"
            onClick={() => void handlePurge()}
            disabled={purging || manualUsers.length === 0}
            startIcon={purging ? <CircularProgress size={16} color="inherit" /> : <DeleteOutlineIcon />}
          >
            {t("adminPages.team.purgeConfirmButton")}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar open={!!msg} autoHideDuration={4000} onClose={() => setMsg(null)} message={msg ?? ""} />
    </AdminDesk>
  );
}
