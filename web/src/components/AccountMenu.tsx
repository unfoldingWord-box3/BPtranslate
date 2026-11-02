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
//
// On phones the Help panel's entry lives here too (onOpenHelp), because a
// separate Help button in the strip truncated the screen titles at 360px.
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
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import ChatIcon from "@mui/icons-material/Chat";
import CloudDownloadIcon from "@mui/icons-material/CloudDownload";
import HelpOutlineIcon from "@mui/icons-material/HelpOutline";
import CheckIcon from "@mui/icons-material/Check";
import LanguageIcon from "@mui/icons-material/Language";
import MenuBookIcon from "@mui/icons-material/MenuBook";
import DarkModeIcon from "@mui/icons-material/DarkMode";
import FormatSizeIcon from "@mui/icons-material/FormatSize";
import LogoutIcon from "@mui/icons-material/Logout";
import RemoveIcon from "@mui/icons-material/Remove";
import { useTranslation } from "react-i18next";
import { isTranslationProject, useProjectConfig } from "../hooks/useProjectConfig";
import { pipelineTrigger } from "../lib/pipelineTrigger";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { ChatLinkDialog } from "./ChatLinkDialog";
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
  /**
   * The current screen's "Start an AI run" on phones (#481), registered by
   * FlowAiRunAction. Called with the avatar button, so the pipeline menu opens
   * where the account menu was. In a source project it is labelled "Import
   * from Door43" and opens that dialog instead (#731).
   */
  onStartAiRun?: (anchor: HTMLElement) => void;
  /** Phones only: show a Help item; it gets the avatar button to return focus to. */
  onOpenHelp?: (returnFocus: HTMLElement | null) => void;
};

export function AccountMenu({ username, onLogout, isAdmin, onOpenClassic, onStartAiRun, onOpenHelp }: Props) {
  const { t } = useTranslation();
  const [anchor, setAnchor] = useState<null | HTMLElement>(null);
  const [langAnchor, setLangAnchor] = useState<null | HTMLElement>(null);
  const [chatLinkOpen, setChatLinkOpen] = useState(false);
  const { lang, setLang } = useContext(UiLangContext);
  const { mode: themeMode, toggle: toggleTheme } = useContext(ThemeModeContext);
  const { scale, setScale } = useContext(FontScaleContext);
  const projectConfig = useProjectConfig();
  // A source project's run trigger is an import, not an AI run (#731).
  const aiRunTrigger = pipelineTrigger(isTranslationProject(projectConfig));
  const orgLanguageLabel = projectConfig
    ? projectConfig.languageTitle || projectConfig.languageName || projectConfig.languageCode
    : null;

  return (
    <>
      <Tooltip title={username ? `@${username}` : ""}>
        <IconButton
          size="small"
          aria-haspopup="menu"
          aria-expanded={Boolean(anchor)}
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
        onClose={() => {
          setAnchor(null);
          setLangAnchor(null);
        }}
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

        {/* First, because on phones this is the screen's own work action, not
            an account setting. */}
        {onStartAiRun && (
          <MenuItem
            // Takes the menu's roving focus (see the note on the dark-mode
            // row) when present, since it is the first focusable item.
            autoFocus
            onClick={() => {
              const avatar = anchor;
              setAnchor(null);
              if (avatar) onStartAiRun(avatar);
            }}
          >
            <ListItemIcon>
              {aiRunTrigger.kind === "import" ? (
                <CloudDownloadIcon fontSize="small" sx={{ color: "text.secondary" }} />
              ) : (
                <AutoAwesomeIcon fontSize="small" sx={{ color: "text.secondary" }} />
              )}
            </ListItemIcon>
            <ListItemText primary={t(aiRunTrigger.actionKey)} />
          </MenuItem>
        )}
        {onStartAiRun && <Divider />}

        <WorkspaceSwitcher variant="submenuItem" />

        {/* autoFocus establishes the menu's roving focus. MUI only sets it up
            from a focusable MenuItem child, and this menu opens with a plain
            identity Box first — without this, arrow keys move nothing and the
            whole menu is pointer-only (the same defect classic's account menu
            still has, #224). The org row above is a MenuItem too, so ArrowUp
            reaches it; it renders nothing on a single-org install. */}
        <MenuItem autoFocus={!onStartAiRun} onClick={toggleTheme}>
          <ListItemIcon>
            <DarkModeIcon fontSize="small" sx={{ color: "text.secondary" }} />
          </ListItemIcon>
          <ListItemText primary={t(themeMode === "dark" ? "topbar.switchToLight" : "topbar.switchToDark")} />
          <Switch size="small" checked={themeMode === "dark"} sx={{ pointerEvents: "none" }} />
        </MenuItem>

        {/* Same row + submenu as classic TopBar's More ▸ View ▸ language. */}
        <MenuItem
          aria-haspopup="menu"
          aria-expanded={Boolean(langAnchor)}
          onClick={(e) => setLangAnchor(e.currentTarget)}
        >
          <ListItemIcon>
            <LanguageIcon fontSize="small" sx={{ color: "text.secondary" }} />
          </ListItemIcon>
          <ListItemText
            primary={t("topbar.uiLanguage")}
            secondary={UI_LANGUAGES.find((l) => l.code === lang)?.label}
          />
        </MenuItem>
        <Menu
          anchorEl={langAnchor}
          open={Boolean(langAnchor)}
          onClose={() => setLangAnchor(null)}
          // Same reason as WorkspaceSwitcher's submenu: keys propagate through
          // the portal, and the account menu's list would also move focus.
          onKeyDown={(e) => e.stopPropagation()}
        >
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
        {onOpenHelp && (
          <MenuItem
            onClick={() => {
              const avatar = anchor;
              setAnchor(null);
              onOpenHelp(avatar);
            }}
          >
            <ListItemIcon>
              <HelpOutlineIcon fontSize="small" sx={{ color: "text.secondary" }} />
            </ListItemIcon>
            <ListItemText primary={t("help.open")} />
          </MenuItem>
        )}
        {/* Any signed-in user: the link is how the chat knows which project to
            read, and the server lets only editors save over it. */}
        {username && (
          <MenuItem
            onClick={() => {
              setAnchor(null);
              setChatLinkOpen(true);
            }}
          >
            <ListItemIcon>
              <ChatIcon fontSize="small" sx={{ color: "text.secondary" }} />
            </ListItemIcon>
            <ListItemText primary={t("chatLink.menuItem")} />
          </MenuItem>
        )}
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
      {/* Lives outside the Menu: closing the menu unmounts its children, which
          would take an open dialog with it. */}
      {username && <ChatLinkDialog open={chatLinkOpen} onClose={() => setChatLinkOpen(false)} />}
    </>
  );
}
