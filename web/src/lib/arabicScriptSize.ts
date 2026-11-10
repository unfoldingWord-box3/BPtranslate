// Arabic script draws smaller than Latin at the same CSS font size (a smaller
// x-height), so Arabic scripture and notes beside English read as a size
// smaller. The notes screen enlarges Arabic-script text by this factor.
//
// Keyed on the text itself, the same way `dir="auto"` picks its direction:
// the first letter decides. An Arabic-target project can still hold English
// text (placeholder drafts, an English lane; #256), and that must stay at its
// normal size. A Latin token inside an Arabic sentence ("AVD") grows with it.
export const ARABIC_SCRIPT_SCALE = 1.15;

const LETTER = /\p{L}/u;
const ARABIC = /\p{Script=Arabic}/u;

/** The first letter of `text` is Arabic script (Arabic, Persian, Urdu, ...). */
export function startsArabicScript(text: string | null | undefined): boolean {
  if (!text) return false;
  const first = LETTER.exec(text);
  return first != null && ARABIC.test(first[0]);
}

/** A BCP 47 language code written in Arabic script ("ar", "fa", "ur", "ar-SA"). */
export function isArabicScriptLanguage(code: string | null | undefined): boolean {
  if (!code) return false;
  try {
    return new Intl.Locale(code).maximize().script === "Arab";
  } catch {
    // "ar_SA" and other malformed codes throw.
    return false;
  }
}

/**
 * For an editor: its text decides once it holds a letter; until then the
 * project language does, so an empty Arabic editor does not grow on the
 * first keystroke.
 */
export function editsArabicScript(text: string | null | undefined, languageCode: string | null | undefined): boolean {
  return text && LETTER.test(text) ? startsArabicScript(text) : isArabicScriptLanguage(languageCode);
}

/** `size` (any CSS length) enlarged when `arabic`, unchanged otherwise. */
export function arabicFontSize(size: string, arabic: boolean): string {
  return arabic ? `calc(${size} * ${ARABIC_SCRIPT_SCALE})` : size;
}
