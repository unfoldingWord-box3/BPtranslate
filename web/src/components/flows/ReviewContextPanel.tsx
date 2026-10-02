// "This verse" read-only context for the review queue, after the .ctx-panel /
// .ctx-lane / .ctx-twl blocks in docs/flows/ui/t2-review.html. One component
// serves all three bands: the desktop right-hand column, the tablet
// collapsible section, and the phone bottom sheet — the mockup duplicated the
// same markup into #ctxBodyDesktop and #ctxBodyMobile.
//
// Nothing here is editable. TWL in particular has no approve lifecycle, and
// the mockup says so out loud rather than implying a third queue.

import { useTranslation } from "react-i18next";
import Box from "@mui/material/Box";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import { SCRIPTURE_FONT_STACK } from "../../theme";
import type { TwlRow } from "../../sync/api";
import { parseTwId, twShort } from "../../lib/twArticle";

export interface ReviewContextPanelProps {
  ultText: string | null;
  ustText: string | null;
  /**
   * Per-project DISPLAY labels for the two scripture lanes (issue #7). The
   * caller resolves these via versionLabel(projectConfig, "ULT"/"UST") so a
   * Gateway Language project shows GLT/GST (or a named literal like "Van Dyke")
   * instead of the internal role codes. Default to the role codes so the panel
   * still renders correctly when a caller doesn't pass them.
   */
  litLabel?: string;
  simLabel?: string;
  /** Word links for the active row's verse only — already filtered by caller. */
  twl: TwlRow[];
  /** Direction of the original-language words shown in the TWL list. */
  sourceDir: "ltr" | "rtl";
}

function Lane({ label, text }: { label: string; text: string | null }) {
  const { t } = useTranslation();
  return (
    <Box sx={{ mb: 1.5 }}>
      <Typography
        variant="caption"
        color="text.secondary"
        component="div"
        sx={{ fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", mb: 0.5 }}
      >
        {label}
      </Typography>
      <Typography
        variant="body2"
        // Lane direction follows the *content* (dir="auto"), like the
        // Translate notes/questions lanes (#292, #256): an Arabic verse reads
        // RTL under an LTR UI (#533), while an English (still untranslated)
        // lane in an RTL project keeps its period on the right. The project
        // direction (versionIsRtl) would flip that English text too. The "no
        // text" placeholder is UI chrome and keeps the UI's direction.
        dir={text != null ? "auto" : undefined}
        sx={{
          bgcolor: "action.hover",
          borderRadius: 1,
          paddingInline: 1.25,
          paddingBlock: 1,
          fontFamily: SCRIPTURE_FONT_STACK,
          lineHeight: 1.5,
          textAlign: "start",
        }}
      >
        {text ?? (
          <Box component="em" sx={{ color: "text.secondary" }}>
            {t("flowReview.context.noLaneText", { label })}
          </Box>
        )}
      </Typography>
    </Box>
  );
}

export function ReviewContextPanel({
  ultText,
  ustText,
  litLabel = "ULT",
  simLabel = "UST",
  twl,
  sourceDir,
}: ReviewContextPanelProps) {
  const { t } = useTranslation();
  return (
    <Box sx={{ textAlign: "start" }}>
      <Lane label={litLabel} text={ultText} />
      <Lane label={simLabel} text={ustText} />

      <Box sx={{ mt: 1.75, pt: 1.5, borderBlockStart: "1px solid", borderColor: "divider" }}>
        <Typography
          variant="caption"
          color="text.secondary"
          component="div"
          sx={{ fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" }}
        >
          {t("flowReview.context.wordLinks")}
        </Typography>
        {twl.length === 0 ? (
          <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 0.75 }}>
            {t("flowReview.context.noWordLinks")}
          </Typography>
        ) : (
          <Box component="ul" sx={{ listStyle: "none", m: 0, mt: 0.75, p: 0 }}>
            {twl.map((w) => {
              const short = twShort(w.tw_link);
              const canOpen = parseTwId(w.tw_link) !== null;
              return (
                <Box
                  component="li"
                  key={w.id}
                  sx={{ display: "flex", justifyContent: "space-between", gap: 1, mb: 0.75 }}
                >
                  <Box
                    component="span"
                    dir={sourceDir}
                    sx={{ fontFamily: SCRIPTURE_FONT_STACK, fontSize: "0.9rem", textAlign: "start" }}
                  >
                    {w.orig_words ?? ""}
                  </Box>
                  {canOpen ? (
                    <Link
                      href={`#/articles/tw/${encodeURIComponent(short)}`}
                      variant="caption"
                      title="open the translationWords article (read-only)"
                      sx={{ color: "text.secondary" }}
                    >
                      {short}
                    </Link>
                  ) : (
                    <Typography variant="caption" color="text.secondary">
                      {(w.tw_link ?? "").replace(/^rc:\/\/\*\/tw\/dict\/bible\//, "")}
                    </Typography>
                  )}
                </Box>
              );
            })}
          </Box>
        )}
        <Typography
          variant="caption"
          color="text.secondary"
          component="p"
          sx={{ mt: 1, fontStyle: "italic" }}
        >
          {t("flowReview.context.wordLinksNote")}
        </Typography>
      </Box>
    </Box>
  );
}
