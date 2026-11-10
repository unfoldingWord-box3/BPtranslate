// Pure helpers for the suggestion inbox page (AdminSuggestionInboxScreen,
// issue #819; follow-ups #856), kept here so they can be tested without React.

/**
 * A whole percent, rounded down, computed in integers: 29 of 50 is 58, where
 * Math.floor((29 / 50) * 100) gives 57 because 0.58 * 100 is 57.99999999999999
 * in floating point. Rounded down so 79.6% never shows as 80% next to an 80%
 * bar. 0 when there is nothing to divide by.
 */
export function floorPercent(part: number, whole: number): number {
  return whole > 0 ? Math.floor((part * 100) / whole) : 0;
}

/**
 * The plain-language message (i18n key) for an approve error code from
 * POST /api/suggestion-inbox/:book/approve (api/src/suggestionInbox.ts).
 * rule_exists is not here: the rule is already stored, so the page treats it
 * as done. Unknown codes give null (the page shows the raw error).
 */
const APPROVE_ERROR_KEYS: Record<string, string> = {
  suggestion_not_found: "adminPages.suggestions.errGone",
  rule_mismatch: "adminPages.suggestions.errMismatch",
  rule_imprecise: "adminPages.suggestions.errImprecise",
  rule_unchecked: "adminPages.suggestions.errUnchecked",
  rule_unsupported: "adminPages.suggestions.errUnsupported",
  not_migrated: "adminPages.suggestions.errRulesNotMigrated",
};

export function approveErrorKey(code: string | null | undefined): string | null {
  return (code && APPROVE_ERROR_KEYS[code]) || null;
}
