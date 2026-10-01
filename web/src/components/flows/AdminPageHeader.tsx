// AdminPageHeader — the shared "eyebrow / h1 / subtitle" header block for
// every AdminDesk page. Extracted from the copy-pasted `.admin-head` block
// (and its re-declared INSPIRE/INSPIRE_DEEP accent) duplicated across
// AdminProgressScreen, AdminWorkflowScreen, AdminTeamScreen, AdminSetupScreen,
// and now the four former pill-bar "More tools" screens (#186).
import { Box, Typography } from "@mui/material";
import { useTheme } from "@mui/material/styles";

const INSPIRE = "#31ADE3";
const INSPIRE_DEEP = "#1B84B8";

export function AdminPageHeader({
  eyebrow,
  title,
  subtitle,
}: {
  eyebrow: string;
  title: string;
  subtitle?: string;
}) {
  const theme = useTheme();
  const accent = theme.palette.mode === "dark" ? INSPIRE : INSPIRE_DEEP;
  return (
    <Box sx={{ mb: 2 }}>
      <Typography
        variant="caption"
        sx={{
          display: "block",
          fontWeight: 700,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: accent,
        }}
      >
        {eyebrow}
      </Typography>
      <Typography variant="h5" component="h1" sx={{ mt: 0.25, letterSpacing: "-0.02em" }}>
        {title}
      </Typography>
      {subtitle && (
        <Typography color="text.secondary" sx={{ mt: 0.5, fontSize: "0.875rem" }}>
          {subtitle}
        </Typography>
      )}
    </Box>
  );
}
