import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  Snackbar,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import { useTranslation } from "react-i18next";
import { api, ApiError, type AdminUser, type OrgMembersResponse } from "../sync/api";
import { formatDate } from "../lib/formatDate";

const ROLE_OPTIONS: Array<{ value: "admin" | "editor"; labelKey: string }> = [
  { value: "editor", labelKey: "preferences.users.roleEditor" },
  { value: "admin", labelKey: "preferences.users.roleAdmin" },
];

// Bare allowlist error codes (api/src/adminUserRoutes.ts). Anything else
// (network failure, unexpected 5xx) falls back to the generic message —
// same "unknown code" fallback shape as laneErrorMessage in
// PreferencesWorkspace.tsx, just returning translated copy instead of the
// raw string since these codes aren't meant to be user-facing on their own.
function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, e: unknown): string {
  const code = e instanceof ApiError ? (e.body as { error?: string } | undefined)?.error : undefined;
  switch (code) {
    case "invalid_username":
      return t("preferences.users.errors.invalid_username");
    case "dcs_user_not_found":
      return t("preferences.users.errors.dcs_user_not_found");
    case "last_admin":
      return t("preferences.users.errors.last_admin");
    case "not_found":
      return t("preferences.users.errors.not_found");
    default:
      return t("preferences.actionFailed");
  }
}

// Admin-only editor/admin allowlist (user_roles table). Read-only viewers are
// NOT managed here — they come automatically from Door43 org membership; see
// the intro copy below for the plain-English version of that + the ~1h
// freshness caveat (role changes apply on the affected user's next JWT
// refresh, per auth.ts's ACCESS_COOKIE_TTL_SECONDS).
export function UserManagementSection() {
  const { t } = useTranslation();
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  // Live DCS org roster, fetched alongside the allowlist for reconciliation.
  // null = still loading / never loaded; a value with `.error` set = DCS was
  // unreachable but the allowlist half of the page is still fully usable.
  const [orgMembers, setOrgMembers] = useState<OrgMembersResponse | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [newUsername, setNewUsername] = useState("");
  const [newRole, setNewRole] = useState<"admin" | "editor">("editor");
  const [adding, setAdding] = useState(false);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [purging, setPurging] = useState(false);

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      const { users } = await api.adminListUsers();
      setUsers(users);
    } catch {
      setLoadError(true);
    }
    // The org roster is best-effort and independent of the allowlist: a DCS
    // outage (or the route failing soft) must not block role management. Fetch
    // it separately and swallow hard failures into the same soft-error shape.
    try {
      setOrgMembers(await api.adminListOrgMembers());
    } catch {
      setOrgMembers({ org: "", members: [], error: "network", truncated: false });
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount-time load; the same `load` backs Retry and runs after every add/remove, so it clears loadError at start rather than leaving a stale failure alert during the refetch.
    void load();
  }, [load]);

  const handleAdd = async () => {
    const username = newUsername.trim();
    if (!username) return;
    setAdding(true);
    let ok = false;
    try {
      const res = await api.adminSetUserRole(username, newRole);
      ok = true;
      if (!res.dcsVerified) setMsg(t("preferences.users.unverified"));
    } catch (e) {
      setMsg(errorMessage(t, e));
    } finally {
      setAdding(false);
    }
    // Refetch regardless of outcome — on success this reflects the new row;
    // on failure it re-syncs the UI to true server state rather than trusting
    // an optimistic update that may be stale.
    await load();
    if (ok) {
      setNewUsername("");
      setNewRole("editor");
    }
  };

  const handleRoleChange = async (username: string, role: "admin" | "editor") => {
    setRowBusy(username);
    try {
      const res = await api.adminSetUserRole(username, role);
      // A team member's row is re-taken by team sync at their next check, so
      // this edit won't stick while they stay on the team. Keyed on the
      // PRE-edit source (wasTeamManaged): the post-edit row reads 'manual'
      // because the admin's edit takes ownership until the next sync. The
      // `source` check is kept for compatibility with older API responses.
      if (res.wasTeamManaged || res.user.source === "dcs_team") setMsg(t("preferences.users.teamManagedEdit"));
      else if (!res.dcsVerified) setMsg(t("preferences.users.unverified"));
    } catch (e) {
      setMsg(errorMessage(t, e));
    } finally {
      setRowBusy(null);
    }
    await load();
  };

  const handleRemove = async (username: string) => {
    if (!window.confirm(t("preferences.users.confirmRemove", { username }))) return;
    setRowBusy(username);
    try {
      const res = await api.adminRemoveUser(username);
      // Removing a team-derived row does NOT revoke access on its own — the
      // next team check re-creates it. Never let that look like a clean revoke.
      if (res.wasTeamDerived) setMsg(t("preferences.users.teamManagedRemove", { username }));
    } catch (e) {
      setMsg(errorMessage(t, e));
    } finally {
      setRowBusy(null);
    }
    await load();
  };

  const handlePurge = async () => {
    setPurging(true);
    try {
      const res = await api.adminPurgeManualGrants();
      if (res.kept.length > 0) {
        setMsg(t("preferences.users.purge.doneKept", { count: res.removed.length, kept: res.kept.join(", ") }));
      } else {
        setMsg(t("preferences.users.purge.done", { count: res.removed.length }));
      }
    } catch (e) {
      setMsg(errorMessage(t, e));
    } finally {
      setPurging(false);
      setPurgeOpen(false);
    }
    await load();
  };

  // ── Reconciliation data (read-only) ──
  // Match logins case-insensitively — Gitea itself is case-insensitive on
  // usernames, and allowlist rows may differ in casing from the DCS roster.
  const roleByLogin = new Map((users ?? []).map((u) => [u.username.toLowerCase(), u]));
  const orgLoginSet = new Set((orgMembers?.members ?? []).map((m) => m.login.toLowerCase()));
  // Only trust "is / isn't an org member" once we actually have a roster:
  // an errored or empty fetch must not flag every allowlist entry as an outsider.
  // A `partial` roster (public-members fallback — see issue #78) still has an
  // `error` code attached for diagnostics, but it's real, displayable data, not
  // an unavailable state.
  const haveRoster = !!orgMembers && (!orgMembers.error || orgMembers.partial) && orgMembers.members.length > 0;
  const rosterUnavailable =
    !!orgMembers && !orgMembers.partial && (!!orgMembers.error || orgMembers.members.length === 0);
  const orgName = orgMembers?.org || "";

  // ── Manual-grant purge partition (issue #2) ──
  // Only source='manual' rows are cleared by the purge. Split them by whether
  // a live Door43 team backs the same login (from the roster's teamRole), so
  // the confirm can warn which users would actually LOSE access (manual-only,
  // no team) versus which keep it (team re-applies on next sign-in). If team
  // data couldn't be read, everyone lands in "will lose" — the conservative,
  // honest split rather than a falsely reassuring one.
  const manualUsers = (users ?? []).filter((u) => (u.source ?? "manual") === "manual");
  const teamRoleLogins = new Set(
    (orgMembers?.members ?? []).filter((m) => m.teamRole).map((m) => m.login.toLowerCase()),
  );
  const manualTeamBacked = manualUsers.filter((u) => teamRoleLogins.has(u.username.toLowerCase()));
  const manualWillLose = manualUsers.filter((u) => !teamRoleLogins.has(u.username.toLowerCase()));

  return (
    <Box component="section" aria-labelledby="user-management-heading">
      <Typography id="user-management-heading" variant="h6" gutterBottom>
        {t("preferences.users.title")}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {t("preferences.users.intro")}
      </Typography>

      <Box sx={{ border: "1px dashed", borderColor: "divider", borderRadius: 1, p: 1.5, mb: 2 }}>
        <Stack direction="row" spacing={1} flexWrap="wrap" gap={1} alignItems="flex-start">
          <TextField
            size="small"
            label={t("preferences.users.username")}
            value={newUsername}
            onChange={(e) => setNewUsername(e.target.value)}
            sx={{ width: 220 }}
          />
          <TextField
            select
            size="small"
            label={t("preferences.users.role")}
            value={newRole}
            onChange={(e) => setNewRole(e.target.value as "admin" | "editor")}
            sx={{ width: 160 }}
          >
            {ROLE_OPTIONS.map((opt) => (
              <MenuItem key={opt.value} value={opt.value}>
                {t(opt.labelKey)}
              </MenuItem>
            ))}
          </TextField>
          <Button
            variant="contained"
            startIcon={adding ? <CircularProgress size={16} color="inherit" /> : <AddIcon />}
            onClick={handleAdd}
            disabled={adding || !newUsername.trim()}
          >
            {t("preferences.users.add")}
          </Button>
        </Stack>
      </Box>

      {users === null ? (
        loadError ? (
          <Alert
            severity="error"
            action={
              <Button size="small" onClick={() => void load()}>
                {t("preferences.users.retry")}
              </Button>
            }
          >
            {t("preferences.users.loadFailed")}
          </Alert>
        ) : (
          <CircularProgress size={22} />
        )
      ) : (
        <>
        <Stack
          direction="row"
          spacing={1}
          alignItems="center"
          justifyContent="space-between"
          sx={{ mb: 0.5 }}
        >
          <Typography variant="subtitle2">
            {t("preferences.users.reconcile.allowlistHeading")}
          </Typography>
          <Button
            size="small"
            color="warning"
            variant="outlined"
            startIcon={<DeleteOutlineIcon />}
            onClick={() => setPurgeOpen(true)}
            disabled={manualUsers.length === 0}
          >
            {t("preferences.users.purge.button")}
          </Button>
        </Stack>
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1 }}>
          {t("preferences.users.reconcile.allowlistNote")}
        </Typography>
        <Box sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1, overflow: "hidden" }}>
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: "1fr 140px 160px 160px 40px",
              gap: 1,
              px: 1.5,
              py: 0.75,
              bgcolor: "grey.50",
              fontFamily: "monospace",
              fontSize: 10,
              textTransform: "uppercase",
              color: "text.disabled",
              borderBottom: "1px dashed",
              borderColor: "divider",
            }}
          >
            <span>{t("preferences.users.username")}</span>
            <span>{t("preferences.users.role")}</span>
            <span>{t("preferences.users.added")}</span>
            <span>{t("preferences.users.addedBy")}</span>
            <span />
          </Box>
          {users.map((u) => (
            <Box
              key={u.username}
              sx={{
                display: "grid",
                gridTemplateColumns: "1fr 140px 160px 160px 40px",
                gap: 1,
                px: 1.5,
                py: 0.75,
                alignItems: "center",
                borderBottom: "1px dashed",
                borderColor: "divider",
                "&:last-of-type": { borderBottom: "none" },
              }}
            >
              <Box sx={{ overflow: "hidden", display: "flex", alignItems: "center", gap: 0.5 }}>
                <Typography variant="body2" sx={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                  {u.username}
                </Typography>
                {haveRoster && !orgMembers?.truncated && !orgLoginSet.has(u.username.toLowerCase()) && (
                  <Tooltip title={t("preferences.users.reconcile.notOrgMemberHint", { org: orgName })}>
                    <Chip
                      size="small"
                      color="warning"
                      variant="outlined"
                      label={t("preferences.users.reconcile.notOrgMember")}
                    />
                  </Tooltip>
                )}
              </Box>
              <TextField
                select
                size="small"
                value={u.role}
                onChange={(e) => void handleRoleChange(u.username, e.target.value as "admin" | "editor")}
                disabled={rowBusy === u.username}
              >
                {ROLE_OPTIONS.map((opt) => (
                  <MenuItem key={opt.value} value={opt.value}>
                    {t(opt.labelKey)}
                  </MenuItem>
                ))}
              </TextField>
              <Typography variant="body2" color="text.secondary">
                {u.addedAt != null ? formatDate(u.addedAt * 1000) : "—"}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {u.source === "dcs_team" ? t("preferences.users.fromTeam") : (u.addedBy ?? "—")}
              </Typography>
              <Tooltip title={t("preferences.users.remove")}>
                <span>
                  <IconButton
                    size="small"
                    color="error"
                    onClick={() => void handleRemove(u.username)}
                    disabled={rowBusy === u.username}
                  >
                    <DeleteOutlineIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
            </Box>
          ))}
        </Box>

        {/* ── Reconciliation against the live DCS org roster (read-only) ── */}
        <Box sx={{ mt: 3 }}>
          <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
            {orgName
              ? t("preferences.users.reconcile.orgHeading", { org: orgName })
              : t("preferences.users.reconcile.orgHeadingNoOrg")}
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1 }}>
            {t("preferences.users.reconcile.orgNote")}
          </Typography>

          {orgMembers === null ? (
            <CircularProgress size={20} />
          ) : rosterUnavailable ? (
            <Alert severity="info">{t("preferences.users.reconcile.unavailable")}</Alert>
          ) : (
            <>
              {orgMembers.partial && (
                <Alert severity="warning" sx={{ mb: 1 }}>
                  {t("preferences.users.reconcile.partial", { org: orgName })}
                </Alert>
              )}
              {orgMembers.truncated && (
                <Alert severity="warning" sx={{ mb: 1 }}>
                  {t("preferences.users.reconcile.truncated")}
                </Alert>
              )}
              <Box
                sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1, overflow: "hidden" }}
              >
                <Box
                  sx={{
                    display: "grid",
                    gridTemplateColumns: "1fr 240px",
                    gap: 1,
                    px: 1.5,
                    py: 0.75,
                    bgcolor: "grey.50",
                    fontFamily: "monospace",
                    fontSize: 10,
                    textTransform: "uppercase",
                    color: "text.disabled",
                    borderBottom: "1px dashed",
                    borderColor: "divider",
                  }}
                >
                  <span>{t("preferences.users.reconcile.memberColumn")}</span>
                  <span>{t("preferences.users.reconcile.statusColumn")}</span>
                </Box>
                {orgMembers.members.map((m) => {
                  // Prefer the LIVE team-derived role (present even before the
                  // member has ever signed in) over the synced user_roles row;
                  // fall back to the allowlist row for manual-only grants. This
                  // is what makes a BE-Admins member who never logged in show
                  // "Admin (Door43 team)" instead of "no app role" (issue #1).
                  const allowRow = roleByLogin.get(m.login.toLowerCase());
                  const effectiveRole = m.teamRole ?? allowRow?.role;
                  const effectiveSource: "dcs_team" | "manual" | undefined = m.teamRole
                    ? "dcs_team"
                    : allowRow?.source;
                  return (
                    <Box
                      key={m.login}
                      sx={{
                        display: "grid",
                        gridTemplateColumns: "1fr 240px",
                        gap: 1,
                        px: 1.5,
                        py: 0.75,
                        alignItems: "center",
                        borderBottom: "1px dashed",
                        borderColor: "divider",
                        "&:last-of-type": { borderBottom: "none" },
                      }}
                    >
                      <Typography variant="body2" sx={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                        {m.login}
                        {m.fullName ? (
                          <Typography component="span" variant="body2" color="text.secondary">
                            {" "}
                            — {m.fullName}
                          </Typography>
                        ) : null}
                      </Typography>
                      {effectiveRole ? (
                        <Chip
                          size="small"
                          color={effectiveRole === "admin" ? "primary" : "default"}
                          variant="outlined"
                          label={t("preferences.users.reconcile.hasRole", {
                            role:
                              effectiveRole === "admin"
                                ? t("preferences.users.roleAdmin")
                                : t("preferences.users.roleEditor"),
                            source:
                              effectiveSource === "dcs_team"
                                ? t("preferences.users.reconcile.sourceTeam")
                                : t("preferences.users.reconcile.sourceManual"),
                          })}
                        />
                      ) : (
                        <Chip
                          size="small"
                          variant="outlined"
                          label={t("preferences.users.reconcile.noRole")}
                        />
                      )}
                    </Box>
                  );
                })}
                {orgMembers.members.length === 0 && (
                  <Box sx={{ px: 1.5, py: 1 }}>
                    <Typography variant="body2" color="text.secondary">
                      {t("preferences.users.reconcile.emptyRoster")}
                    </Typography>
                  </Box>
                )}
              </Box>
            </>
          )}
        </Box>
        </>
      )}

      <Dialog open={purgeOpen} onClose={() => !purging && setPurgeOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{t("preferences.users.purge.confirmTitle")}</DialogTitle>
        <DialogContent>
          {manualUsers.length === 0 ? (
            <Typography variant="body2">{t("preferences.users.purge.none")}</Typography>
          ) : (
            <>
              <Typography variant="body2" sx={{ mb: 1.5 }}>
                {t("preferences.users.purge.confirmIntro")}
              </Typography>
              {manualWillLose.length > 0 && (
                <Alert severity="warning" sx={{ mb: 1.5 }}>
                  <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5 }}>
                    {t("preferences.users.purge.willLoseAccess")}
                  </Typography>
                  <Typography variant="body2">
                    {manualWillLose.map((u) => u.username).join(", ")}
                  </Typography>
                </Alert>
              )}
              {manualTeamBacked.length > 0 && (
                <Alert severity="info">
                  <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5 }}>
                    {t("preferences.users.purge.teamBacked")}
                  </Typography>
                  <Typography variant="body2">
                    {manualTeamBacked.map((u) => u.username).join(", ")}
                  </Typography>
                </Alert>
              )}
            </>
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
            {t("preferences.users.purge.confirm")}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar open={!!msg} autoHideDuration={4000} onClose={() => setMsg(null)} message={msg ?? ""} />
    </Box>
  );
}
