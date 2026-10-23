// A styled band that renders a section header (\s1, \s2, \s3) above
// the verse it belongs to. These are translator-supplied editorial
// headings — they are NOT aligned to Hebrew/Greek source words, so we
// hoist them out of the verse body (see splitSectionHeaders in lib/usfm)
// to make their non-alignable status visually obvious and to keep the
// alignment panel from ever seeing them as word-level targets.
//
// `\d` Psalm superscriptions are also `type:"section"` in usfm-js but
// ARE alignable Hebrew — they're rendered inline in the verse body, not
// here.

import { useState, useEffect, useRef } from "react";
import { Box, IconButton, Stack, Tooltip, Typography, Select, MenuItem } from "@mui/material";
import EditIcon from "@mui/icons-material/Edit";
import CheckIcon from "@mui/icons-material/Check";
import CloseIcon from "@mui/icons-material/Close";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import { useTranslation } from "react-i18next";

interface Props {
  tag: string;
  text: string;
  editable?: boolean;
  onChange?: (next: { tag: string; text: string } | { tag: null; text: "" }) => void;
}

// Level dropdown options. We don't expose `\ms` (major section) by
// default — translators rarely add those by hand; if a USFM source has
// them they round-trip but the picker stays focused on the common case.
const LEVEL_OPTIONS = [
  { value: "s1", label: "\\s1" },
  { value: "s2", label: "\\s2" },
  { value: "s3", label: "\\s3" },
];

export function SectionHeaderBand({ tag, text, editable, onChange }: Props) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draftText, setDraftText] = useState(text);
  const [draftTag, setDraftTag] = useState(tag);
  const inputRef = useRef<HTMLDivElement | null>(null);

  // Re-seed the drafts when the props change (adjusted during render).
  const [prevText, setPrevText] = useState(text);
  const [prevTag, setPrevTag] = useState(tag);
  if (text !== prevText || tag !== prevTag) {
    setPrevText(text);
    setPrevTag(tag);
    setDraftText(text);
    setDraftTag(tag);
  }

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      const sel = window.getSelection();
      const r = document.createRange();
      r.selectNodeContents(inputRef.current);
      r.collapse(false);
      sel?.removeAllRanges();
      sel?.addRange(r);
    }
  }, [editing]);

  const level = tag === "s2" ? 2 : tag === "s3" ? 3 : 1;
  const fontSize = level === 1 ? 13 : level === 2 ? 12 : 11;

  if (editing && editable) {
    return (
      <Stack
        direction="row"
        spacing={0.5}
        alignItems="center"
        sx={{
          py: 0.25,
          px: 0.5,
          bgcolor: "background.paper",
          border: "1px solid",
          borderColor: "primary.main",
          borderRadius: 0.5,
        }}
      >
        <Select
          size="small"
          value={draftTag}
          onChange={(e) => setDraftTag(String(e.target.value))}
          variant="standard"
          disableUnderline
          sx={{
            fontFamily: "Consolas, Menlo, monospace",
            fontSize: 11,
            color: "primary.main",
            minWidth: 50,
          }}
        >
          {LEVEL_OPTIONS.map((o) => (
            <MenuItem key={o.value} value={o.value} sx={{ fontFamily: "Consolas, Menlo, monospace", fontSize: 11 }}>
              {o.label}
            </MenuItem>
          ))}
        </Select>
        <Box
          ref={inputRef}
          component="div"
          contentEditable
          suppressContentEditableWarning
          onInput={(e) => setDraftText((e.currentTarget as HTMLDivElement).textContent ?? "")}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onChange?.({ tag: draftTag, text: draftText.trim() });
              setEditing(false);
            } else if (e.key === "Escape") {
              e.preventDefault();
              setDraftText(text);
              setDraftTag(tag);
              setEditing(false);
            }
          }}
          sx={{
            flex: 1,
            fontWeight: 600,
            fontSize,
            outline: "none",
            px: 0.5,
          }}
        >
          {text}
        </Box>
        <Tooltip title={t("rail.saveEnter")}>
          <IconButton
            size="small"
            onClick={() => {
              onChange?.({ tag: draftTag, text: draftText.trim() });
              setEditing(false);
            }}
            sx={{ p: 0.25, color: "success.main" }}
          >
            <CheckIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Tooltip>
        <Tooltip title={t("rail.cancelEsc")}>
          <IconButton
            size="small"
            onClick={() => {
              setDraftText(text);
              setDraftTag(tag);
              setEditing(false);
            }}
            sx={{ p: 0.25 }}
          >
            <CloseIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Tooltip>
        <Tooltip title={t("rail.deleteSectionHeader")}>
          <IconButton
            size="small"
            onClick={() => {
              onChange?.({ tag: null, text: "" });
              setEditing(false);
            }}
            sx={{ p: 0.25, color: "error.main" }}
          >
            <DeleteOutlineIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Tooltip>
      </Stack>
    );
  }

  return (
    <Stack
      direction="row"
      spacing={0.5}
      alignItems="center"
      sx={{
        py: 0.25,
        px: 0.5,
        borderLeft: "3px solid",
        borderColor: "#014263", // Ocean
        bgcolor: "rgba(1, 66, 99, 0.04)",
        borderRadius: 0.25,
      }}
    >
      <Typography
        variant="caption"
        sx={{
          fontFamily: "Consolas, Menlo, monospace",
          fontSize: 10,
          color: "#014263",
          opacity: 0.75,
        }}
      >
        \{tag}
      </Typography>
      <Typography
        sx={{
          flex: 1,
          fontWeight: 600,
          fontSize,
          color: "#014263",
        }}
      >
        {text}
      </Typography>
      {editable && (
        <Tooltip title={t("rail.editSectionHeader")}>
          <IconButton
            size="small"
            onClick={() => setEditing(true)}
            sx={{ p: 0.25, color: "#014263", opacity: 0.6 }}
          >
            <EditIcon sx={{ fontSize: 12 }} />
          </IconButton>
        </Tooltip>
      )}
    </Stack>
  );
}
