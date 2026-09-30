// Decoder for the x-morph codes our USFM carries on every source word (UHB
// Hebrew/Aramaic + UGNT Greek). The lexicon tooltip otherwise shows only the
// *lemma's* general part of speech ("Noun Feminine") and discards the
// in-context morphology — which is where the interesting grammar lives. Most
// importantly for Hebrew, a word like ZEC 5:6 עֵינָם carries `He,Ncbsc:Sp3mp`,
// whose `:Sp3mp` morpheme is an attached pronominal suffix ("their") that has no
// other surface in the UI.
//
// The term tables and decode logic are ported from bibletags-ui-helper's
// hebrewMorph.js / greekMorph.js (MIT). Our USFM uses the identical morph
// format those decoders were written for: Hebrew/Aramaic split their morphemes
// on ':' after the `He,`/`Ar,` prefix; Greek is a fixed positional code after
// `Gr,` where the literal commas double as null-fillers for absent features.
//
// ── Logic vs. display ───────────────────────────────────────────────────────
// Every term table below maps a *morph-code letter* (parsing input — never
// translated) to a `Term`, which carries BOTH halves of the old single string:
//
//   • `en`  — the stable English id. `Morpheme.pos` and `Morpheme.features`
//             keep exactly these values, because consumers match on them
//             (`CONTENT_POS.has(m.pos)` in flows/VerseSpineModel.ts, and
//             `pos === "verb"` below, which decides possessive vs. object
//             glossing of a pronominal suffix). Renaming one is a logic change.
//   • `key` — the i18next key under the `morph.*` namespace, used only when a
//             term is rendered to the screen.
//
// Nothing here calls `t()` at module scope: freezing a translation at import
// time would lock the UI to whatever language was loaded first. Translation
// happens inside `morphemeText()` / `decodeMorph()` at call time, always with
// the English `en` as `defaultValue`, so a missing key degrades to today's
// English rather than to a raw key.
//
// We import the `i18next` singleton directly rather than `../i18n`: it is the
// same instance (`web/src/i18n/index.ts` initialises that very default export),
// but `../i18n` statically imports the locale JSON files, which the
// `node --experimental-strip-types` test runner cannot load.

import i18n from "i18next";
import type { TFunction } from "i18next";

/** A grammatical term: stable English id (logic) + i18n key (display). */
interface Term {
  key: string;
  en: string;
}
const T = (key: string, en: string): Term => ({ key, en });

type TLike = (key: string, opts: { defaultValue: string }) => unknown;

/** Resolve a translator at CALL time — never at module scope. */
function translator(t?: TFunction): TLike | null {
  if (typeof t === "function") return t as unknown as TLike;
  const fn = (i18n as unknown as { t?: unknown }).t;
  return typeof fn === "function" ? ((fn as TLike).bind(i18n) as TLike) : null;
}

/** Translate `key`, falling back to the English `en` for anything unresolved. */
function render(fn: TLike | null, key: string, en: string): string {
  if (!fn || !key) return en;
  try {
    const v = fn(key, { defaultValue: en });
    return typeof v === "string" && v ? v : en;
  } catch {
    return en;
  }
}

const label = (term: Term, t?: TFunction): string => render(translator(t), term.key, term.en);

export interface Morpheme {
  pos: string; // stable English part-of-speech id, e.g. "noun" ("" if unknown)
  posKey: string; // i18n key for `pos` ("" when pos is "")
  features: string[]; // stable English ids, e.g. ["singular", "construct"]
  featureKeys: string[]; // i18n keys, index-parallel to `features`
  kind: "prefix" | "main" | "suffix";
  pronoun?: string; // possessive/object gloss for a pronominal suffix, e.g. "their"
  raw: string; // original morpheme code, e.g. "Ncbsc"
}

export interface DecodedMorph {
  lang: "He" | "Ar" | "Gr" | string;
  morphemes: Morpheme[]; // in word order: prefixes, main word, then suffixes
  // Convenience: the attached pronominal suffix, if any (Hebrew/Aramaic only).
  // Rendered verbatim by consumers, so both fields are already translated.
  pronounSuffix: { gloss: string; parse: string } | null;
}

// ── Hebrew / Aramaic term tables ────────────────────────────────────────────

const HE_POS: Record<string, Term> = {
  A: T("morph.pos.adjective", "adjective"),
  C: T("morph.pos.conjunction", "conjunction"),
  D: T("morph.pos.adverb", "adverb"),
  N: T("morph.pos.noun", "noun"),
  P: T("morph.pos.pronoun", "pronoun"),
  R: T("morph.pos.preposition", "preposition"),
  S: T("morph.pos.suffix", "suffix"),
  T: T("morph.pos.particle", "particle"),
  V: T("morph.pos.verb", "verb"),
};
const PERSON: Record<string, Term> = {
  1: T("morph.person.first", "1st person"),
  2: T("morph.person.second", "2nd person"),
  3: T("morph.person.third", "3rd person"),
};
const HE_GENDER: Record<string, Term> = {
  m: T("morph.gender.masculine", "masculine"),
  f: T("morph.gender.feminine", "feminine"),
  b: T("morph.gender.bothGenders", "both genders"),
  c: T("morph.gender.common", "common"),
};
const HE_NUMBER: Record<string, Term> = {
  s: T("morph.number.singular", "singular"),
  p: T("morph.number.plural", "plural"),
  d: T("morph.number.dual", "dual"),
};
const HE_STATE: Record<string, Term> = {
  a: T("morph.state.absolute", "absolute"),
  c: T("morph.state.construct", "construct"),
  d: T("morph.state.determined", "determined"),
};
const ADJ_TYPE: Record<string, Term> = {
  c: T("morph.adjType.cardinalNumber", "cardinal number"),
  o: T("morph.adjType.ordinalNumber", "ordinal number"),
};
const NOUN_TYPE: Record<string, Term> = {
  g: T("morph.nounType.gentilic", "gentilic"),
  p: T("morph.nounType.properName", "proper name"),
};
const PRONOUN_TYPE: Record<string, Term> = {
  d: T("morph.pronounType.demonstrative", "demonstrative"),
  f: T("morph.pronounType.indefinite", "indefinite"),
  i: T("morph.pronounType.interrogative", "interrogative"),
  p: T("morph.pronounType.personal", "personal"),
  r: T("morph.pronounType.relative", "relative"),
};
const PREP_TYPE: Record<string, Term> = {
  d: T("morph.prepType.definiteArticle", "definite article"),
};
const SUFFIX_TYPE: Record<string, Term> = {
  d: T("morph.suffixType.directional", "directional"),
  h: T("morph.suffixType.paragogic", "paragogic"),
  n: T("morph.suffixType.paragogic", "paragogic"),
};
const PARTICLE_TYPE: Record<string, Term> = {
  a: T("morph.particleType.affirmation", "affirmation"),
  d: T("morph.particleType.definiteArticle", "definite article"),
  e: T("morph.particleType.exhortation", "exhortation"),
  i: T("morph.particleType.interrogative", "interrogative"),
  j: T("morph.particleType.interjection", "interjection"),
  m: T("morph.particleType.demonstrative", "demonstrative"),
  n: T("morph.particleType.negative", "negative"),
  o: T("morph.particleType.directObjectMarker", "direct object marker"),
  r: T("morph.particleType.relative", "relative"),
};
const ASPECT: Record<string, Term> = {
  p: T("morph.aspect.perfect", "perfect"),
  q: T("morph.aspect.sequentialPerfect", "sequential perfect"),
  i: T("morph.aspect.imperfect", "imperfect"),
  w: T("morph.aspect.sequentialImperfect", "sequential imperfect"),
  h: T("morph.aspect.cohortative", "cohortative"),
  j: T("morph.aspect.jussive", "jussive"),
  v: T("morph.aspect.imperative", "imperative"),
  r: T("morph.aspect.participle", "participle"),
  s: T("morph.aspect.passiveParticiple", "passive participle"),
  a: T("morph.aspect.infinitiveAbsolute", "infinitive absolute"),
  c: T("morph.aspect.infinitiveConstruct", "infinitive construct"),
};
// Binyanim / Aramaic stems. The English ids are transliterated Hebrew stem
// names, not translations — so are their Arabic values (see i18n notes).
const STEM_HE: Record<string, Term> = {
  q: T("morph.stem.qal", "qal"),
  N: T("morph.stem.niphal", "niphal"),
  p: T("morph.stem.piel", "piel"),
  P: T("morph.stem.pual", "pual"),
  h: T("morph.stem.hiphil", "hiphil"),
  H: T("morph.stem.hophal", "hophal"),
  t: T("morph.stem.hithpael", "hithpael"),
  o: T("morph.stem.polel", "polel"),
  O: T("morph.stem.polal", "polal"),
  r: T("morph.stem.hithpolel", "hithpolel"),
  m: T("morph.stem.poel", "poel"),
  M: T("morph.stem.poal", "poal"),
  k: T("morph.stem.palel", "palel"),
  K: T("morph.stem.pulal", "pulal"),
  Q: T("morph.stem.qalPassive", "qal passive"),
  l: T("morph.stem.pilpel", "pilpel"),
  L: T("morph.stem.polpal", "polpal"),
  f: T("morph.stem.hithpalpel", "hithpalpel"),
  D: T("morph.stem.nithpael", "nithpael"),
  j: T("morph.stem.pealal", "pealal"),
  i: T("morph.stem.pilel", "pilel"),
  u: T("morph.stem.hothpaal", "hothpaal"),
  c: T("morph.stem.tiphil", "tiphil"),
  v: T("morph.stem.hishtaphel", "hishtaphel"),
  w: T("morph.stem.nithpalel", "nithpalel"),
  y: T("morph.stem.nithpoel", "nithpoel"),
  z: T("morph.stem.hithpoel", "hithpoel"),
};
const STEM_AR: Record<string, Term> = {
  q: T("morph.stem.peal", "peal"),
  Q: T("morph.stem.peil", "peil"),
  u: T("morph.stem.hithpeel", "hithpeel"),
  N: T("morph.stem.niphal", "niphal"),
  p: T("morph.stem.pael", "pael"),
  P: T("morph.stem.ithpaal", "ithpaal"),
  M: T("morph.stem.hithpaal", "hithpaal"),
  a: T("morph.stem.aphel", "aphel"),
  h: T("morph.stem.haphel", "haphel"),
  s: T("morph.stem.saphel", "saphel"),
  e: T("morph.stem.shaphel", "shaphel"),
  H: T("morph.stem.hophal", "hophal"),
  i: T("morph.stem.ithpeel", "ithpeel"),
  t: T("morph.stem.hishtaphel", "hishtaphel"),
  v: T("morph.stem.ishtaphel", "ishtaphel"),
  w: T("morph.stem.hithaphel", "hithaphel"),
  o: T("morph.stem.polel", "polel"),
  z: T("morph.stem.ithpoel", "ithpoel"),
  r: T("morph.stem.hithpolel", "hithpolel"),
  f: T("morph.stem.hithpalpel", "hithpalpel"),
  b: T("morph.stem.hephal", "hephal"),
  c: T("morph.stem.tiphel", "tiphel"),
  m: T("morph.stem.poel", "poel"),
  l: T("morph.stem.palpel", "palpel"),
  L: T("morph.stem.ithpalpel", "ithpalpel"),
  O: T("morph.stem.ithpolel", "ithpolel"),
  G: T("morph.stem.ittaphal", "ittaphal"),
};

// `out`/`keys` stay index-parallel: out[i] is the English id, keys[i] its key.
const push = (out: string[], keys: string[], term: Term | undefined) => {
  if (term) {
    out.push(term.en);
    keys.push(term.key);
  }
};
const pushGNS = (out: string[], keys: string[], l: string[]) => {
  push(out, keys, HE_GENDER[l[0]]); push(out, keys, HE_NUMBER[l[1]]); push(out, keys, HE_STATE[l[2]]);
};
const pushPGN = (out: string[], keys: string[], l: string[]) => {
  push(out, keys, PERSON[l[0]]); push(out, keys, HE_GENDER[l[1]]); push(out, keys, HE_NUMBER[l[2]]);
};

// Possessive ("their eye") when the suffix rides a noun/preposition; object
// ("saw them") when it rides a verb. The morph code alone can't tell us — the
// host part of speech does.
function pronounTerm(person: string, gender: string, number: string, object: boolean): Term {
  if (person === "1") {
    return number === "s"
      ? (object ? T("morph.pronoun.me", "me") : T("morph.pronoun.my", "my"))
      : (object ? T("morph.pronoun.us", "us") : T("morph.pronoun.our", "our"));
  }
  if (person === "2") {
    return object ? T("morph.pronoun.you", "you") : T("morph.pronoun.your", "your");
  }
  // 3rd person
  if (number === "s") {
    if (gender === "m") return object ? T("morph.pronoun.him", "him") : T("morph.pronoun.his", "his");
    if (gender === "f") return object ? T("morph.pronoun.herObject", "her") : T("morph.pronoun.herPossessive", "her");
    return object ? T("morph.pronoun.it", "it") : T("morph.pronoun.its", "its");
  }
  return object ? T("morph.pronoun.them", "them") : T("morph.pronoun.their", "their");
}

function decodeHebrewMorpheme(lang: string, code: string, kind: Morpheme["kind"]): Morpheme {
  const l = code.split("");
  const posTerm = HE_POS[l[0]];
  const pos = posTerm?.en || "";
  const posKey = posTerm?.key || "";
  const features: string[] = [];
  const featureKeys: string[] = [];
  const pronoun: string | undefined = undefined;

  switch (l[0]) {
    case "A":
      push(features, featureKeys, ADJ_TYPE[l[1]]); pushGNS(features, featureKeys, l.slice(2)); break;
    case "N":
      push(features, featureKeys, NOUN_TYPE[l[1]]); pushGNS(features, featureKeys, l.slice(2)); break;
    case "P":
      push(features, featureKeys, PRONOUN_TYPE[l[1]]); pushPGN(features, featureKeys, l.slice(2)); break;
    case "R":
      push(features, featureKeys, PREP_TYPE[l[1]]); break;
    case "T":
      push(features, featureKeys, PARTICLE_TYPE[l[1]]); break;
    case "S":
      push(features, featureKeys, SUFFIX_TYPE[l[1]]);
      if (l[1] === "p") pushPGN(features, featureKeys, l.slice(2, 5));
      break;
    case "V": {
      push(features, featureKeys, (lang === "Ar" ? STEM_AR : STEM_HE)[l[1]]);
      const aspect = l[2];
      push(features, featureKeys, ASPECT[aspect]);
      if (aspect === "r" || aspect === "s") pushGNS(features, featureKeys, l.slice(3));
      else if (aspect !== "a" && aspect !== "c") pushPGN(features, featureKeys, l.slice(3));
      break;
    }
    default:
      break;
  }

  return { pos, posKey, features, featureKeys, kind, raw: code, pronoun };
}

function decodeHebrew(lang: string, morph: string): DecodedMorph {
  const codes = morph.slice(3).split(":"); // drop "He,"/"Ar," then split morphemes
  // The main word is the last morpheme that isn't a suffix (mirrors bibletags'
  // getMainWordPartIndex). Earlier morphemes are prefixes (conjunction, article,
  // preposition); later ones are suffixes (pronominal, directional, paragogic).
  let mainIdx = codes.length - 1;
  for (let i = codes.length - 1; i >= 0; i--) {
    if (codes[i][0] !== "S") { mainIdx = i; break; }
  }

  const morphemes = codes.map((code, i) => {
    const kind: Morpheme["kind"] = i < mainIdx ? "prefix" : i === mainIdx ? "main" : "suffix";
    return decodeHebrewMorpheme(lang, code, kind);
  });

  let pronounSuffix: DecodedMorph["pronounSuffix"] = null;
  // Compares the stable English id, not a rendered label — see header note.
  const hostIsVerb = morphemes[mainIdx]?.pos === "verb";
  for (let i = mainIdx + 1; i < codes.length; i++) {
    const l = codes[i].split("");
    if (l[0] === "S" && l[1] === "p") {
      const gloss = label(pronounTerm(l[2], l[3], l[4], hostIsVerb));
      const parse = [PERSON[l[2]], HE_GENDER[l[3]], HE_NUMBER[l[4]]]
        .filter(Boolean)
        .map((term) => label(term))
        .join(" ");
      morphemes[i].pronoun = gloss;
      pronounSuffix = { gloss, parse };
      break;
    }
  }

  return { lang, morphemes, pronounSuffix };
}

// ── Greek term tables ─────────────────────────────────────────────────────────

const GR_POS: Record<string, Term> = {
  N: T("morph.pos.noun", "noun"),
  A: T("morph.pos.adjective", "adjective"),
  NS: T("morph.pos.adjective", "adjective"),
  NP: T("morph.pos.adjective", "adjective"),
  E: T("morph.pos.determiner", "determiner"),
  R: T("morph.pos.pronoun", "pronoun"),
  V: T("morph.pos.verb", "verb"),
  I: T("morph.pos.interjection", "interjection"),
  P: T("morph.pos.preposition", "preposition"),
  D: T("morph.pos.adverb", "adverb"),
  PI: T("morph.pos.adverb", "adverb"),
  C: T("morph.pos.conjunction", "conjunction"),
  T: T("morph.pos.particle", "particle"),
  TF: T("morph.pos.foreignWord", "foreign word"),
};
const GR_POS_TYPE: Record<string, Term> = {
  NS: T("morph.posType.substantive", "substantive"),
  NP: T("morph.posType.predicate", "predicate"),
  AA: T("morph.posType.ascriptive", "ascriptive"),
  AR: T("morph.posType.restrictive", "restrictive"),
  EA: T("morph.posType.article", "article"),
  ED: T("morph.posType.demonstrative", "demonstrative"),
  EF: T("morph.posType.differential", "differential"),
  EP: T("morph.posType.possessive", "possessive"),
  EQ: T("morph.posType.quantifier", "quantifier"),
  EN: T("morph.posType.number", "number"),
  EO: T("morph.posType.ordinal", "ordinal"),
  ER: T("morph.posType.relative", "relative"),
  ET: T("morph.posType.interrogative", "interrogative"),
  RD: T("morph.posType.demonstrative", "demonstrative"),
  RP: T("morph.posType.personal", "personal"),
  RE: T("morph.posType.reflexive", "reflexive"),
  RC: T("morph.posType.reciprocal", "reciprocal"),
  RI: T("morph.posType.indefinite", "indefinite"),
  RR: T("morph.posType.relative", "relative"),
  RT: T("morph.posType.interrogative", "interrogative"),
  IE: T("morph.posType.exclamation", "exclamation"),
  ID: T("morph.posType.directive", "directive"),
  IR: T("morph.posType.response", "response"),
  PI: T("morph.posType.improperPreposition", "improper preposition"),
  DO: T("morph.posType.correlative", "correlative"),
  CC: T("morph.posType.coordinating", "coordinating"),
  CS: T("morph.posType.subordinating", "subordinating"),
  CO: T("morph.posType.correlative", "correlative"),
};
// Positional categories of the code after the 2-char role: each character maps
// through its category in this fixed order; commas in the source land on
// undefined keys and drop out.
const GR_CATEGORIES: Record<string, Term>[] = [
  { // mood
    I: T("morph.mood.indicative", "indicative"),
    M: T("morph.mood.imperative", "imperative"),
    S: T("morph.mood.subjunctive", "subjunctive"),
    O: T("morph.mood.optative", "optative"),
    N: T("morph.mood.infinitive", "infinitive"),
    P: T("morph.mood.participle", "participle"),
  },
  { // tense
    P: T("morph.tense.present", "present"),
    I: T("morph.tense.imperfect", "imperfect"),
    F: T("morph.tense.future", "future"),
    A: T("morph.tense.aorist", "aorist"),
    E: T("morph.tense.perfect", "perfect"),
    L: T("morph.tense.pluperfect", "pluperfect"),
  },
  { // voice
    A: T("morph.voice.active", "active"),
    M: T("morph.voice.middle", "middle"),
    P: T("morph.voice.passive", "passive"),
  },
  { // person
    1: T("morph.person.first", "1st person"),
    2: T("morph.person.second", "2nd person"),
    3: T("morph.person.third", "3rd person"),
  },
  { // case
    N: T("morph.case.nominative", "nominative"),
    G: T("morph.case.genitive", "genitive"),
    D: T("morph.case.dative", "dative"),
    A: T("morph.case.accusative", "accusative"),
    V: T("morph.case.vocative", "vocative"),
  },
  { // gender
    M: T("morph.gender.masculine", "masculine"),
    F: T("morph.gender.feminine", "feminine"),
    N: T("morph.gender.neuter", "neuter"),
  },
  { // number
    S: T("morph.number.singular", "singular"),
    P: T("morph.number.plural", "plural"),
  },
  { // other
    C: T("morph.other.comparative", "comparative"),
    S: T("morph.other.superlative", "superlative"),
    D: T("morph.other.diminutive", "diminutive"),
    I: T("morph.other.indeclinable", "indeclinable"),
  },
];

function decodeGreek(morph: string): DecodedMorph {
  const body = morph.slice(3); // after "Gr,"
  const roleCode = body.slice(0, 2); // e.g. "AA", or "N," for single-char roles
  const posTerm = GR_POS[roleCode] ?? GR_POS[roleCode[0]];
  const pos = posTerm?.en ?? "";
  const posKey = posTerm?.key ?? "";
  const features: string[] = [];
  const featureKeys: string[] = [];
  push(features, featureKeys, GR_POS_TYPE[roleCode]);
  const chars = body.slice(2).split("");
  GR_CATEGORIES.forEach((cat, i) => push(features, featureKeys, cat[chars[i]]));
  return {
    lang: "Gr",
    morphemes: [{ pos, posKey, features, featureKeys, kind: "main", raw: body }],
    pronounSuffix: null,
  };
}

/**
 * Decode a raw x-morph string into a structure whose `pos`/`features` are
 * stable English ids (plus index-parallel i18n keys). Returns null for
 * empty/unrecognized input so callers can fall back silently.
 */
export function decodeMorph(morph: string | null | undefined): DecodedMorph | null {
  if (!morph) return null;
  const lang = morph.slice(0, 2);
  if (lang === "He" || lang === "Ar") return decodeHebrew(lang, morph);
  if (lang === "Gr") return decodeGreek(morph);
  return null;
}

/**
 * Render one morpheme as "pos · feature · feature" (POS omitted if unknown),
 * localized via i18next. `t` is optional: pass one from `useTranslation()` if
 * you have it, otherwise the i18next singleton is resolved at call time. Any
 * key without a translation falls back to the English id, so English output is
 * identical to the pre-i18n version.
 */
export function morphemeText(m: Morpheme, t?: TFunction): string;
// Both consumers call this as `morphemes.map(morphemeText)`, which hands the
// callback (value, index, array). This overload keeps that point-free call
// type-checking; the implementation ignores a numeric second argument and
// falls back to the i18next singleton.
export function morphemeText(m: Morpheme, index: number, array: Morpheme[]): string;
export function morphemeText(m: Morpheme, t?: TFunction | number): string {
  const fn = translator(typeof t === "function" ? t : undefined);
  const keys = m.featureKeys ?? [];
  const parts: string[] = [];
  if (m.pos) parts.push(render(fn, m.posKey ?? "", m.pos));
  (m.features ?? []).forEach((en, i) => {
    if (en) parts.push(render(fn, keys[i] ?? "", en));
  });
  return parts.join(" · ");
}
