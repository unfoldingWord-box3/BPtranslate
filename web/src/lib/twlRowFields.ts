import type { TwlRow } from "../sync/api";

// The editable fields of a words-table (TWL) row, normalized the way WordRow
// edits them. A null/0 occurrence shows as 1: the export coerces an OL quote's
// null occurrence to 1, so 1 and null are the same on disk and must not count
// as a dirty edit.
export interface TwlFields {
  quote: string;
  twLink: string | null;
  occurrence: number;
}

// The baseline WordRow compares against and that Undo restores. It is read from
// the current row, which already carries an optimistic save before the server
// acknowledges it, so Undo never restores a value from before the last Save
// (#613).
export function twlBaseline(row: Pick<TwlRow, "orig_words" | "tw_link" | "occurrence">): TwlFields {
  return { quote: row.orig_words ?? "", twLink: row.tw_link, occurrence: row.occurrence ?? 1 };
}

// The patch a Save sends: only the fields that differ from the row's baseline.
export function twlDiff(
  row: Pick<TwlRow, "orig_words" | "tw_link" | "occurrence">,
  fields: TwlFields,
): Partial<TwlRow> {
  const base = twlBaseline(row);
  const out: Partial<TwlRow> = {};
  if (fields.quote !== base.quote) out.orig_words = fields.quote;
  if (fields.twLink !== base.twLink) out.tw_link = fields.twLink;
  if (fields.occurrence !== base.occurrence) out.occurrence = fields.occurrence;
  return out;
}
