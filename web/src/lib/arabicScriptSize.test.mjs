// Arabic text on the notes screen is drawn larger (arabicScriptSize.ts); these
// pin which text counts as Arabic and which language codes are Arabic-script.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ARABIC_SCRIPT_SCALE,
  arabicFontSize,
  editsArabicScript,
  isArabicScriptLanguage,
  startsArabicScript,
} from "./arabicScriptSize.ts";

test("startsArabicScript: the first letter decides, like dir=auto", () => {
  assert.equal(startsArabicScript("هَٰذَا نَصٌّ عَرَبِيٌّ AVD لِاخْتِبَارِ."), true);
  assert.equal(startsArabicScript("«1» هذا نص"), true, "leading digits and punctuation are skipped");
  assert.equal(startsArabicScript("این یک متن فارسی است"), true, "Persian");
  assert.equal(startsArabicScript("یہ اردو ہے"), true, "Urdu");
  assert.equal(startsArabicScript("In the beginning"), false);
  assert.equal(startsArabicScript("AVD هذا نص"), false, "starts with a Latin letter");
  assert.equal(startsArabicScript("The word سلام means peace"), false, "English with one Arabic word");
  assert.equal(startsArabicScript("בְּרֵאשִׁית"), false, "Hebrew is not Arabic script");
  assert.equal(startsArabicScript("123 ..."), false);
  assert.equal(startsArabicScript(""), false);
  assert.equal(startsArabicScript(null), false);
  assert.equal(startsArabicScript(undefined), false);
});

test("isArabicScriptLanguage: Arabic-script codes only, never throws", () => {
  for (const code of ["ar", "AR", "ar-SA", "arb", "apc", "fa", "ur", "ps", "ckb", "ug"]) {
    assert.equal(isArabicScriptLanguage(code), true, code);
  }
  for (const code of ["en", "he", "es", "hi", "az", "xyz", "ar_SA", "", null, undefined]) {
    assert.equal(isArabicScriptLanguage(code), false, String(code));
  }
});

test("editsArabicScript: the text once it has a letter, else the project language", () => {
  assert.equal(editsArabicScript("", "ar"), true, "empty editor in an Arabic project");
  assert.equal(editsArabicScript("  12 ", "ar"), true, "no letter yet");
  assert.equal(editsArabicScript("", "en"), false);
  assert.equal(editsArabicScript(null, null), false);
  assert.equal(editsArabicScript("Here, pride is", "ar"), false, "English placeholder in an Arabic project");
  assert.equal(editsArabicScript("هنا الكبرياء", "en"), true, "Arabic text in an English project");
});

test("arabicFontSize scales only Arabic, keeping the base unit", () => {
  assert.equal(arabicFontSize("0.9375rem", false), "0.9375rem");
  assert.equal(arabicFontSize("0.9375rem", true), `calc(0.9375rem * ${ARABIC_SCRIPT_SCALE})`);
  assert.ok(ARABIC_SCRIPT_SCALE > 1 && ARABIC_SCRIPT_SCALE < 1.3);
});
