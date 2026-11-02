import { useEffect, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Typography from "@mui/material/Typography";
import { retryProjectConfig, useProjectConfigLoadFailed } from "../hooks/useProjectConfig";

// Holds back target-text lanes until their direction is known (issue #728,
// the follow-up to #451). A target lane's direction comes from the project
// config (versionDirection), which is null before the first config fetch
// resolves when nothing is cached. Rendering the lane then would guess LTR and
// paint Arabic backwards, so this shows a spinner while the config loads, and
// a warning with Retry when the fetch failed. The same states and strings as
// the flows verse view (VerseScreen.tsx); originals (UHB/UGNT) never need it
// because their direction is fixed by script.
export function TargetDirectionGate({
  known,
  children,
}: {
  /** True once every gated lane's direction is non-null. */
  known: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const loadFailed = useProjectConfigLoadFailed();
  const showFailed = !known && loadFailed;
  // While the warning shows, retry on its own when the connection comes back.
  useEffect(() => {
    if (!showFailed) return;
    window.addEventListener("online", retryProjectConfig);
    return () => window.removeEventListener("online", retryProjectConfig);
  }, [showFailed]);

  if (known) return <>{children}</>;
  if (showFailed) {
    return (
      <Box sx={{ padding: 2 }}>
        <Alert
          severity="warning"
          action={
            <Button color="inherit" size="small" onClick={retryProjectConfig}>
              {t("common.retry")}
            </Button>
          }
        >
          {t("flowVerse.verse.directionLoadFailed")}
        </Alert>
      </Box>
    );
  }
  return (
    <Box
      role="status"
      sx={{ padding: 3, display: "flex", flexDirection: "column", alignItems: "center", gap: 1.5 }}
    >
      <CircularProgress size={28} aria-hidden />
      <Typography variant="body2" color="text.secondary">
        {t("flowVerse.verse.directionLoading")}
      </Typography>
    </Box>
  );
}
