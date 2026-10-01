// The one detail area of the verse fidelity overview, ported from the
// `#detail` column of docs/mockups/book-package/verse.html. One selection model
// feeds it: an original word (with its alignment group and morphology) or one
// resource (note / word link / question).
//
// What the mockup had and this does NOT: inline translationAcademy and
// translationWords PROSE. The mockup shipped a build-time snapshot of the
// en_ta / en_tw checkouts inside its fixture; the app fetches articles from
// Door43, so this pane only asks the screen to open the article
// (`onOpenArticle`) and VerseScreen shows it in place of the resource list
// with the shared AssociatedArticlePanel (issue #478).

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import Box from "@mui/material/Box";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import { alpha, useTheme } from "@mui/material/styles";

import { FlowStatusChip } from "./FlowStatusChip";
import { LEXICON_IMPORT_SCRIPT } from "./WordsLexiconStrip";
import {
  laneTextFor,
  supportRefId,
  twLinkId,
  type LaneModel,
  type OriginalWord,
  type ResourceItem,
} from "./VerseSpineModel";
import { SCRIPTURE_FONT_STACK } from "../../theme";
import type { LexiconEntry } from "../../hooks/useLexicon";
import { taShort } from "../../lib/taArticle";

// Hebrew/Greek display face. Same stack the existing scripture panels use
// (AlignmentPanel / DocColumn / NoteCard) so the original text renders
// identically wherever it appears in the app.
export const ORIGINAL_FONT_STACK = '"Times New Roman","SBL Hebrew","Cardo",serif';

export type VerseSelection =
  | { kind: "word"; positions: number[] }
  | { kind: "resource"; key: string };

export interface VerseDetailPaneProps {
  refLabel: string;
  selection: VerseSelection | null;
  words: OriginalWord[];
  lit: LaneModel;
  sim: LaneModel;
  litLabel: string;
  simLabel: string;
  originalLabel: string;
  resources: ResourceItem[];
  lexicon: Map<string, LexiconEntry | null>;
  rtl: boolean;
  onSelect: (sel: VerseSelection) => void;
  /** Open a tA / tW article in place on the verse screen (issue #478). */
  onOpenArticle: (article: VerseArticle) => void;
}

/** The article the verse screen shows in place of its resource list. */
export interface VerseArticle {
  resource: "ta" | "tw";
  /** Short id: "kt/god" for tW, "translate/figs-idiom" for tA. */
  id: string;
}

// ─── small shared bits ──────────────────────────────────────────────────────

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <Typography
      variant="caption"
      component="p"
      sx={{
        fontWeight: 700,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: "text.secondary",
        marginBlockEnd: 0.625,
      }}
    >
      {children}
    </Typography>
  );
}

function QuoteBlock({
  children,
  original,
  rtl,
}: {
  children: ReactNode;
  original?: boolean;
  rtl?: boolean;
}) {
  return (
    <Box
      // Pin direction so quotes never inherit the UI chrome's dir (rtl under an
      // Arabic UI): the original follows its script (Hebrew rtl / Greek ltr),
      // while target-lane and note text follow their own content (issue #449).
      dir={original ? (rtl ? "rtl" : "ltr") : "auto"}
      sx={{
        fontFamily: original ? ORIGINAL_FONT_STACK : SCRIPTURE_FONT_STACK,
        fontSize: original ? "1.375rem" : "0.97rem",
        lineHeight: original ? 1.8 : 1.55,
        bgcolor: "action.hover",
        border: "1px solid",
        borderColor: "divider",
        borderRadius: 1.5,
        paddingBlock: 1,
        paddingInline: 1.5,
        textAlign: "start",
      }}
    >
      {children}
    </Box>
  );
}

function NotRendered() {
  const theme = useTheme();
  const { t } = useTranslation();
  return (
    <Box
      component="span"
      sx={{
        fontSize: "0.72rem",
        fontWeight: 600,
        color: theme.palette.flows.warn.ink,
        bgcolor: theme.palette.flows.warn.soft,
        borderRadius: 999,
        paddingBlock: "1px",
        paddingInline: 1,
      }}
    >
      {t("flowVerse.notRendered")}
    </Box>
  );
}

// tN note bodies are one field, not a document: bold, bracketed alternates,
// rc:// refs and escaped newlines. Ported from _vlib.js's `note()` — as React
// nodes rather than an HTML string, so nothing is injected.
function inlineNodes(line: string, keyBase: string): ReactNode[] {
  const cleaned = line
    .replace(/\[\[rc:\/\/[^\]]*?\/([^/\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  const out: ReactNode[] = [];
  // NOT user-facing chrome: this pattern matches the tN note BODY, which is
  // authored data. "Alternate translation:" is the literal text stored in the
  // row, so it must stay English here — translating the pattern would stop it
  // matching, and the captured label is re-rendered verbatim from the data.
  const re = /\*\*([^*]+)\*\*|(Alternate translation:)\s*\[([^\]]*)\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(cleaned)) !== null) {
    if (m.index > last) out.push(cleaned.slice(last, m.index));
    const bold = m[1];
    const altLabel = m[2];
    const altText = m[3];
    if (bold !== undefined) {
      out.push(<b key={`${keyBase}-b${i}`}>{bold}</b>);
    } else {
      out.push(
        <span key={`${keyBase}-a${i}`}>
          {altLabel}{" "}
          <Box
            component="span"
            sx={(theme) => ({
              fontFamily: SCRIPTURE_FONT_STACK,
              bgcolor: theme.palette.flows.ok.soft,
              color: theme.palette.flows.ok.ink,
              borderRadius: 0.5,
              paddingInline: 0.5,
            })}
          >
            {altText}
          </Box>
        </span>,
      );
    }
    last = re.lastIndex;
    i += 1;
  }
  if (last < cleaned.length) out.push(cleaned.slice(last));
  return out;
}

function NoteBody({ text }: { text: string | null }) {
  const { t } = useTranslation();
  if (!text || !text.trim()) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ fontStyle: "italic" }}>
        {t("flowVerse.detail.noteNoBody")}
      </Typography>
    );
  }
  const lines = text.replace(/\\n/g, "\n").split("\n");
  return (
    // dir="auto" follows the note's own language (Arabic notes lay out RTL)
    // rather than inheriting the UI chrome's direction (issue #449).
    <Box dir="auto" sx={{ fontSize: "0.86rem", lineHeight: 1.6, textAlign: "start" }}>
      {lines.map((line, i) =>
        line.trim() ? (
          <Typography key={i} variant="body2" sx={{ marginBlockEnd: 1 }}>
            {inlineNodes(line, `l${i}`)}
          </Typography>
        ) : null,
      )}
    </Box>
  );
}

function ResourceRowButton({
  item,
  onSelect,
}: {
  item: ResourceItem;
  onSelect: (sel: VerseSelection) => void;
}) {
  return (
    <Box
      component="button"
      type="button"
      onClick={() => onSelect({ kind: "resource", key: item.key })}
      sx={{
        display: "grid",
        gridTemplateColumns: "auto 1fr",
        gap: 1.25,
        alignItems: "baseline",
        inlineSize: "100%",
        textAlign: "start",
        appearance: "none",
        border: 0,
        borderBlockEnd: "1px solid",
        borderColor: "divider",
        background: "transparent",
        color: "inherit",
        font: "inherit",
        fontSize: "0.84rem",
        minHeight: 32,
        paddingBlock: 0.875,
        paddingInline: 1,
        cursor: "pointer",
        "&:hover, &:focus-visible": { bgcolor: "action.hover" },
      }}
    >
      <Box
        component="span"
        sx={{
          fontSize: "0.66rem",
          fontWeight: 700,
          letterSpacing: "0.05em",
          textTransform: "uppercase",
          color: "text.secondary",
          minInlineSize: 46,
        }}
      >
        {item.tag}
      </Box>
      <Box component="span" dir="auto" sx={{ color: "text.secondary" }}>
        {item.summary || "—"}
      </Box>
    </Box>
  );
}

// ─── word detail ────────────────────────────────────────────────────────────

export interface WordCardProps {
  word: OriginalWord;
  entry: LexiconEntry | null;
  /**
   * Set by the notes-screen lexicon popover (#432), which portals out of any
   * dir'd container: the original word and lemma take this direction (Hebrew
   * RTL, Greek LTR) and the English lexicon/morph lines resolve with
   * dir="auto", so an Arabic UI does not flip them. A missing entry then
   * shows only the plain "no lexicon entry" line, without the developer
   * import-script hint. Unset → no dir attributes and the hint stays: the
   * pane's existing behaviour.
   */
  originalDir?: "ltr" | "rtl";
  /** Drop the card's own bottom margin when it is the only thing in a popover. */
  flush?: boolean;
}

export function WordCard({ word, entry, originalDir, flush }: WordCardProps) {
  const { t } = useTranslation();
  const origLang = originalDir ? (originalDir === "rtl" ? "hbo" : "grc") : undefined;
  const autoDir = originalDir ? "auto" : undefined;
  return (
    <Box
      sx={{
        border: "1px solid",
        borderColor: "divider",
        borderRadius: 1.5,
        bgcolor: "action.hover",
        paddingBlock: 1,
        paddingInline: 1.25,
        marginBlockEnd: flush ? 0 : 1,
      }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 1.25,
        }}
      >
        <Box
          component="span"
          dir={originalDir}
          lang={origLang}
          sx={{ fontFamily: ORIGINAL_FONT_STACK, fontSize: "1.3rem" }}
        >
          {word.text}
        </Box>
        {word.lemma && (
          <Box
            component="span"
            dir={originalDir}
            lang={origLang}
            sx={{ fontFamily: ORIGINAL_FONT_STACK, fontSize: "0.95rem", color: "text.secondary" }}
          >
            {word.lemma}
          </Box>
        )}
      </Box>

      {word.glosses.length > 0 ? (
        <Typography variant="caption" component="p" dir={autoDir} color="text.secondary" sx={{ mt: 0.375 }}>
          {word.glosses.join("  +  ")}
        </Typography>
      ) : (
        <Typography variant="caption" component="p" dir={autoDir} color="text.secondary" sx={{ mt: 0.375 }}>
          {word.morph
            ? t("flowVerse.word.morphUnknown")
            : t("flowVerse.word.noMorph")}
        </Typography>
      )}

      {word.decoded?.pronounSuffix && (
        <Typography variant="caption" component="p" dir={autoDir} sx={{ mt: 0.375 }}>
          {t("flowVerse.word.attachedPronoun")} <b>{word.decoded.pronounSuffix.gloss}</b>{" "}
          <Box component="span" sx={{ color: "text.secondary" }}>
            ({word.decoded.pronounSuffix.parse})
          </Box>
        </Typography>
      )}

      <Typography
        variant="caption"
        component="p"
        dir={autoDir}
        color="text.secondary"
        sx={{ mt: 0.375, fontFamily: "monospace" }}
      >
        {[word.strong || t("flowVerse.word.noStrongParen"), word.morph].filter(Boolean).join(" · ")}
      </Typography>

      <Box sx={{ mt: 0.75, borderBlockStart: "1px dashed", borderColor: "divider", pt: 0.75 }}>
        {!word.strong ? (
          <Typography variant="caption" dir={autoDir} color="text.secondary">
            {t("flowVerse.word.noStrongNoLookup")}
          </Typography>
        ) : entry ? (
          <>
            {entry.gloss && (
              <Typography variant="body2" dir={autoDir} sx={{ fontSize: "0.84rem" }}>
                {entry.gloss}
              </Typography>
            )}
            {entry.part_of_speech && (
              <Typography variant="caption" component="p" dir={autoDir} color="text.secondary">
                {entry.part_of_speech}
              </Typography>
            )}
            {entry.definition && (
              <Typography variant="body2" dir={autoDir} sx={{ fontSize: "0.82rem", mt: 0.375 }}>
                {entry.definition}
              </Typography>
            )}
            {!entry.gloss && !entry.definition && (
              <Typography variant="caption" dir={autoDir} color="text.secondary">
                {t("flowVerse.word.entryNoGloss")}
              </Typography>
            )}
          </>
        ) : (
          <Typography variant="caption" dir={autoDir} color="text.secondary">
            <em>{t("flowVerse.word.noEntryFor", { strong: word.strong })}</em>
            {/* The import-script hint is for developers; the notes-screen
                popover (originalDir set) shows only the plain line. */}
            {!originalDir && <> {t("flowVerse.lexicon.emptyTable", { script: LEXICON_IMPORT_SCRIPT })}</>}
          </Typography>
        )}
      </Box>
    </Box>
  );
}

// ─── the pane ───────────────────────────────────────────────────────────────

export function VerseDetailPane({
  refLabel,
  selection,
  words,
  lit,
  sim,
  litLabel,
  simLabel,
  originalLabel,
  resources,
  lexicon,
  rtl,
  onSelect,
  onOpenArticle,
}: VerseDetailPaneProps) {
  const theme = useTheme();
  const { t } = useTranslation();

  if (!selection) {
    return (
      <Typography
        variant="body2"
        color="text.secondary"
        sx={{ paddingBlock: 4, paddingInline: 0.25, textAlign: "start" }}
      >
        {t("flowVerse.detail.emptyPrompt")}
        <br />
        <br />
        {t("flowVerse.detail.emptyHint")}
      </Typography>
    );
  }

  const topRef = (
    <Typography variant="caption" sx={{ fontWeight: 700, color: "text.secondary" }}>
      {refLabel}
    </Typography>
  );

  if (selection.kind === "word") {
    const selected = selection.positions.map((p) => words[p]).filter(Boolean);
    if (selected.length === 0) {
      return (
        <Typography variant="body2" color="text.secondary" sx={{ paddingBlock: 4 }}>
          {t("flowVerse.detail.wordGone")}
        </Typography>
      );
    }
    const posSet = new Set(selection.positions);
    const attached = resources.filter((r) => r.positions.some((p) => posSet.has(p)));
    const litText = selection.positions.map((p) => laneTextFor(lit, p)).filter(Boolean).join(" … ");
    const simText = selection.positions.map((p) => laneTextFor(sim, p)).filter(Boolean).join(" … ");

    return (
      <Box sx={{ textAlign: "start" }}>
        <Box sx={{ display: "flex", gap: 1, alignItems: "center", flexWrap: "wrap", mb: 1.5 }}>
          {topRef}
          <FlowStatusChip
            kind="skip"
            label={t("flowVerse.detail.chipOriginalWord", { count: selected.length })}
          />
        </Box>

        <Box sx={{ mb: 2.25 }}>
          <SectionLabel>{t("flowVerse.section.morphologyFrom", { label: originalLabel })}</SectionLabel>
          {selected.map((w) => (
            <WordCard key={w.position} word={w} entry={lexicon.get(w.strong) ?? null} />
          ))}
        </Box>

        <Box sx={{ mb: 2.25 }}>
          <SectionLabel>{t("flowVerse.section.literal", { label: litLabel })}</SectionLabel>
          <QuoteBlock>
            {lit.present ? litText || <NotRendered /> : t("flowVerse.detail.laneNoTextHere")}
          </QuoteBlock>
        </Box>

        <Box sx={{ mb: 2.25 }}>
          <SectionLabel>{t("flowVerse.section.simplified", { label: simLabel })}</SectionLabel>
          <QuoteBlock>
            {sim.present ? simText || <NotRendered /> : t("flowVerse.detail.laneNoTextHere")}
          </QuoteBlock>
        </Box>

        {attached.length > 0 ? (
          <Box>
            <SectionLabel>{t("flowVerse.detail.attachedHere")}</SectionLabel>
            {attached.map((r) => (
              <ResourceRowButton key={r.key} item={r} onSelect={onSelect} />
            ))}
          </Box>
        ) : (
          <Typography variant="body2" color="text.secondary" sx={{ fontSize: "0.8rem" }}>
            {t("flowVerse.detail.noAttachments")}
          </Typography>
        )}
      </Box>
    );
  }

  const item = resources.find((r) => r.key === selection.key);
  if (!item) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ paddingBlock: 4 }}>
        {t("flowVerse.detail.resourceGone")}
      </Typography>
    );
  }

  if (item.kind === "tq") {
    return (
      <Box sx={{ textAlign: "start" }}>
        <Box sx={{ display: "flex", gap: 1, alignItems: "center", flexWrap: "wrap", mb: 1.5 }}>
          {topRef}
          <FlowStatusChip kind="skip" label={t("flowVerse.detail.chipQuestion")} />
        </Box>
        <Box sx={{ mb: 2.25 }}>
          <SectionLabel>{t("questions.question")}</SectionLabel>
          <QuoteBlock>{item.tq?.question || "—"}</QuoteBlock>
        </Box>
        <Box sx={{ mb: 2.25 }}>
          <SectionLabel>{t("flowQuestions.expectedAnswer")}</SectionLabel>
          <QuoteBlock>{item.tq?.response || "—"}</QuoteBlock>
        </Box>
        <Typography variant="body2" color="text.secondary" sx={{ fontSize: "0.8rem" }}>
          {t("flowVerse.detail.tqHint")}
        </Typography>
      </Box>
    );
  }

  if (item.kind === "twl") {
    const id = twLinkId(item.twl?.tw_link);
    return (
      <Box sx={{ textAlign: "start" }}>
        <Box sx={{ display: "flex", gap: 1, alignItems: "center", flexWrap: "wrap", mb: 1.5 }}>
          {topRef}
          <FlowStatusChip kind="edited" label={id || t("flowVerse.detail.chipNoTwArticle")} />
          {item.twl?.tags && <FlowStatusChip kind="skip" label={item.twl.tags} />}
          <FlowStatusChip
            kind={item.positions.length ? "ok" : "warn"}
            label={
              item.positions.length
                ? t("flowVerse.detail.chipQuoteAnchored")
                : t("flowVerse.detail.chipQuoteNotFound")
            }
          />
        </Box>
        <Box sx={{ mb: 2.25 }}>
          <SectionLabel>{t("flowVerse.detail.linkedFrom")}</SectionLabel>
          <QuoteBlock original rtl={rtl}>
            {item.twl?.orig_words || "—"}
          </QuoteBlock>
        </Box>
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: "auto 1fr",
            gap: "3px 12px",
            fontSize: "0.8rem",
            mb: 2.25,
          }}
        >
          <Box sx={{ color: "text.secondary" }}>{t("words.occurrenceAriaLabel")}</Box>
          <Box>{item.twl?.occurrence ?? 1}</Box>
          <Box sx={{ color: "text.secondary" }}>{t("flowVerse.detail.link")}</Box>
          <Box sx={{ fontFamily: "monospace", overflowWrap: "anywhere" }}>
            {item.twl?.tw_link || "—"}
          </Box>
        </Box>
        {id ? (
          <Link
            component="button"
            type="button"
            onClick={() => onOpenArticle({ resource: "tw", id })}
            sx={{ fontSize: "0.84rem" }}
          >
            {t("flowVerse.detail.readTwArticle")}
          </Link>
        ) : (
          <Typography variant="body2" color="text.secondary" sx={{ fontSize: "0.8rem" }}>
            {t("flowVerse.detail.noTwArticleRef")}
          </Typography>
        )}
      </Box>
    );
  }

  // tN
  const slug = supportRefId(item.tn?.support_reference);
  const short = taShort(item.tn?.support_reference);
  return (
    <Box sx={{ textAlign: "start" }}>
      <Box sx={{ display: "flex", gap: 1, alignItems: "center", flexWrap: "wrap", mb: 1.5 }}>
        {topRef}
        {slug && <FlowStatusChip kind="edited" label={slug} />}
        <FlowStatusChip
          kind={item.positions.length ? "ok" : "warn"}
          label={
            item.quote
              ? item.positions.length
                ? t("flowVerse.detail.chipQuoteAnchored")
                : t("flowVerse.detail.chipQuoteNotFound")
              : t("flowVerse.detail.chipNoQuote")
          }
        />
        {item.tn?.tags && <FlowStatusChip kind="skip" label={item.tn.tags} />}
      </Box>

      {item.quote && (
        <Box sx={{ mb: 2.25 }}>
          <SectionLabel>{t("words.quote")}</SectionLabel>
          <QuoteBlock original rtl={rtl}>
            {item.quote.replace(/&/g, " … ")}
          </QuoteBlock>
        </Box>
      )}

      <Box sx={{ mb: 2.25 }}>
        <SectionLabel>{t("flowVerse.detail.note")}</SectionLabel>
        <NoteBody text={item.tn?.note ?? null} />
      </Box>

      {!item.positions.length && item.quote && (
        <Typography
          variant="body2"
          sx={{
            fontSize: "0.8rem",
            mb: 2,
            color: theme.palette.flows.warn.ink,
            bgcolor: alpha(theme.palette.flows.warn.main, 0.1),
            borderRadius: 1,
            padding: 1,
          }}
        >
          {t("flowVerse.detail.quoteUnresolved")}
        </Typography>
      )}

      {slug ? (
        <Link
          component="button"
          type="button"
          onClick={() => onOpenArticle({ resource: "ta", id: short })}
          sx={{ fontSize: "0.84rem" }}
        >
          {t("flowVerse.detail.readTaArticle")}
        </Link>
      ) : (
        <Typography variant="body2" color="text.secondary" sx={{ fontSize: "0.8rem" }}>
          {item.tn?.support_reference
            ? t("flowVerse.detail.supportRefNotTa", { ref: item.tn.support_reference })
            : t("flowVerse.detail.noTaArticle")}
        </Typography>
      )}
    </Box>
  );
}
