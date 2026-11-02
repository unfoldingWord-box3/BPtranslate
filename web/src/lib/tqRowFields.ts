import type { TqRow } from "../sync/api";

// TSV stores newlines as a literal "\n"; QuestionCard edits them as real ones.
export function tsvToDisplay(s: string | null): string {
  return (s ?? "").replace(/\\n/g, "\n");
}

// The values QuestionCard shows for a row when nothing has been edited. When the
// row changes, each field adopts the new baseline only if the user hasn't edited
// it since the previous one (reconcileField). Resetting on every version bump
// dropped text typed between Save and the server's confirmation (#617).
export function tqCardBaseline(row: Pick<TqRow, "question" | "response">): {
  question: string;
  response: string;
} {
  return { question: tsvToDisplay(row.question), response: tsvToDisplay(row.response) };
}

// The same for a QuestionsTable row, which edits the raw text and the ref.
export function tqTableBaseline(row: Pick<TqRow, "ref_raw" | "question" | "response">): {
  refRaw: string;
  question: string;
  response: string;
} {
  return { refRaw: row.ref_raw ?? "", question: row.question ?? "", response: row.response ?? "" };
}
