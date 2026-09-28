// The one menu of the new-UI (flow screen) header bar (#299).
//
// The flow screens replaced the classic Shell/TopBar, and with it the whole
// account cluster: identity, sign out, dark mode and reading text size. Sign
// out in particular had no replacement anywhere in the new UI, so a user could
// not leave the session without clearing storage by hand. This is the same set
// of controls TopBar's avatar menu carries, minus editor/translator mode (it lives
// on the Style screen). It also absorbed the controls that used to sit in
// their own menus beside it: interface language (was a globe button in the
// strip) and the jumps to the classic editor and the admin desk (were the
// Books screen's Tune menu and the package hub's admin button), so every flow
// screen reaches all of them from the same place.
//
// The org switcher is in here too, as WorkspaceSwitcher's "submenuItem"
// variant: it switches in place (TopBar's "menuItem" variant only links to
// classic Preferences, which would drop a new-UI user back into the old
// interface) and it is a real MenuItem, so arrow keys can reach it. Either
// variant renders nothing on a single-org install.
import { useContext, useState } from "react";
import {
  Box,
  Divider,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Stack,
  Switch,
  Tooltip,
  Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import AdminPanelSettingsIcon from "@mui/icons-material/AdminPanelSettings";
import CheckIcon from "@mui/icons-material/Check";
import LanguageIcon from "@mui/icons-material/Language";
import MenuBookIcon from "@mui/icons-material/MenuBook";
import DarkModeIcon from "@mui/icons-material/DarkMode";
import FormatSizeIcon from "@mui/icons-material/FormatSize";
import LogoutIcon from "@mui/icons-material/Logout";
import RemoveIcon from "@mui/icons-material/Remove";
import { useTranslation } from "react-i18next";
import { useProjectConfig } from "../hooks/useProjectConfig";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { UI_LANGUAGES } from "../i18n";
import { UiLangContext } from "../i18n/UiLangContext";
import {
  FontScaleContext,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  FONT_SCALE_STEP,
  ThemeModeContext,
} from "../theme";

type Props = {
  username?: string | null;
  onLogout?: () => void;
  isAdmin?: boolean;
  onOpenClassic?: () => void;
};

export function AccountMenu({ username, onLogout, isAdmin, onOpenClassic }: Props) {
  const { t } = useTranslation();
  const [anchor, setAnchor] = useState<null | HTMLElement>(null);
  const [langAnchor, setLangAnchor] = useState<null | HTMLElement>(null);
  const { lang, setLang } = useContext(UiLangContext);
  const { mode: themeMode, toggle: toggleTheme } = useContext(ThemeModeContext);
  const { scale, setScale } = useContext(FontScaleContext);
  const projectConfig = useProjectConfig();
  const orgLanguageLabel = projectConfig
    ? projectConfig.languageTitle || projectConfig.languageName || projectConfig.languageCode
    : null;

  return (
    <>
      <Tooltip title={username ? `@${username}` : ""}>
        <IconButton
          size="small"
          aria-haspopup="menu"
          onClick={(e) => setAnchor(e.currentTarget)}
          sx={{
            width: 32,
            height: 32,
            flexShrink: 0,
            bgcolor: "#014263",
            color: "#fff",
            fontSize: 13,
            fontWeight: 700,
            "&:hover": { bgcolor: "#014263", opacity: 0.9 },
          }}
        >
          {(username?.[0] ?? "?").toUpperCase()}
        </IconButton>
      </Tooltip>
      <Menu
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{ paper: { sx: { minWidth: 260 } } }}
      >
        {(username || orgLanguageLabel) && (
          <Box sx={{ px: 1.75, pt: 1.25, pb: 1 }}>
            {username && <Typography variant="subtitle2">{`@${username}`}</Typography>}
            {orgLanguageLabel && (
              <Typography variant="caption" color="text.secondary">
                {projectConfig?.org} ({orgLanguageLabel})
              </Typography>
            )}
          </Box>
        )}
        {(username || orgLanguageLabel) && <Divider />}

        <WorkspaceSwitcher variant="submenuItem" />

        {/* autoFocus establishes the menu's roving focus. MUI only sets it up
            from a focusable MenuItem child, and this menu opens with a plain
            identity Box first — without this, arrow keys move nothing and the
            whole menu is pointer-only (the same defect classic's account menu
            still has, #224). The org row above is a MenuItem too, so ArrowUp
            reaches it; it renders nothing on a single-org install. */}
        <MenuItem autoFocus onClick={toggleTheme}>
          <ListItemIcon>
            <DarkModeIcon fontSize="small" sx={{ color: "text.secondary" }} />
          </ListItemIcon>
          <ListItemText primary={t(themeMode === "dark" ? "topbar.switchToLight" : "topbar.switchToDark")} />
          <Switch size="small" checked={themeMode === "dark"} sx={{ pointerEvents: "none" }} />
        </MenuItem>

        {/* Same row + submenu as classic TopBar's More ▸ View ▸ language. */}
        <MenuItem onClick={(e) => setLangAnchor(e.currentTarget)}>
          <ListItemIcon>
            <LanguageIcon fontSize="small" sx={{ color: "text.secondary" }} />
          </ListItemIcon>
          <ListItemText
            primary={t("topbar.uiLanguage")}
            secondary={UI_LANGUAGES.find((l) => l.code === lang)?.label}
          />
        </MenuItem>
        <Menu anchorEl={langAnchor} open={Boolean(langAnchor)} onClose={() => setLangAnchor(null)}>
          {UI_LANGUAGES.map((l) => (
            <MenuItem
              key={l.code}
              selected={l.code === lang}
              onClick={() => {
                setLang(l.code);
                setLangAnchor(null);
                setAnchor(null);
              }}
            >
              <ListItemIcon sx={{ visibility: l.code === lang ? "visible" : "hidden" }}>
                <CheckIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>{l.label}</ListItemText>
            </MenuItem>
          ))}
        </Menu>

        <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 2, py: 0.75 }}>
          <FormatSizeIcon fontSize="small" sx={{ color: "text.secondary" }} />
          <Typography variant="body2" sx={{ flex: 1 }}>
            {t("topbar.readingTextSize")}
          </Typography>
          <Stack
            direction="row"
            alignItems="center"
            sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1 }}
          >
            <IconButton
              size="small"
              onClick={() => setScale(scale - FONT_SCALE_STEP)}
              disabled={scale <= FONT_SCALE_MIN + 1e-6}
              aria-label={t("topbar.decreaseReadingTextSize")}
            >
              <RemoveIcon sx={{ fontSize: 14 }} />
            </IconButton>
            <Typography
              variant="caption"
              sx={{ px: 0.5, fontFamily: "monospace", minWidth: 34, textAlign: "center" }}
            >
              {Math.round(scale * 100)}%
            </Typography>
            <IconButton
              size="small"
              onClick={() => setScale(scale + FONT_SCALE_STEP)}
              disabled={scale >= FONT_SCALE_MAX - 1e-6}
              aria-label={t("topbar.increaseReadingTextSize")}
            >
              <AddIcon sx={{ fontSize: 14 }} />
            </IconButton>
          </Stack>
        </Box>

        <Divider />
        {onOpenClassic && (
          <MenuItem
            onClick={() => {
              setAnchor(null);
              onOpenClassic();
            }}
          >
            <ListItemIcon>
              <MenuBookIcon fontSize="small" sx={{ color: "text.secondary" }} />
            </ListItemIcon>
            <ListItemText primary={t("flowBooks.menu.classicEditor")} />
          </MenuItem>
        )}
        {isAdmin && (
          <MenuItem
            onClick={() => {
              setAnchor(null);
              location.hash = "#/admin/progress";
            }}
          >
            <ListItemIcon>
              <AdminPanelSettingsIcon fontSize="small" sx={{ color: "text.secondary" }} />
            </ListItemIcon>
            <ListItemText primary={t("flowBooks.menu.admin")} />
          </MenuItem>
        )}
        {(onOpenClassic || isAdmin) && <Divider />}
        <MenuItem
          onClick={() => {
            setAnchor(null);
            onLogout?.();
          }}
        >
          <ListItemIcon>
            <LogoutIcon fontSize="small" sx={{ color: "#B4462B" }} />
          </ListItemIcon>
          <ListItemText primary={t("shell.signOut")} sx={{ color: "#B4462B" }} />
        </MenuItem>
      </Menu>
    </>
  );
}
