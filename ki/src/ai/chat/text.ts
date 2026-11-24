/**
 * Lexical text handling for offline transcript retrieval.
 *
 * Phase 4 must answer questions with no embedding model and no network, so
 * matching is lexical (BM25). Arabic and English are normalized symmetrically:
 * case, Arabic diacritics, alef/ya/ta-marbuta variants and common affixes are
 * folded before scoring, so a question phrased slightly differently still
 * finds the passage that actually says it.
 */

const ARABIC_MARKS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/g;
const TATWEEL = /\u0640/g;
const ALEF_VARIANTS = /[\u0622\u0623\u0625\u0671]/g;
const TOKEN_PATTERN = /[\p{L}\p{N}]+/gu;
const ARABIC_SCRIPT = /[\u0600-\u06FF]/;

/** Fold case, Arabic diacritics and letter variants into one search form. */
export function normalizeText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(ARABIC_MARKS, '')
    .replace(TATWEEL, '')
    .replace(ALEF_VARIANTS, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي');
}

/** Split normalized text into letter/number tokens. */
export function tokenize(value: string): string[] {
  const matches = normalizeText(value).match(TOKEN_PATTERN);
  return matches === null ? [] : matches;
}

const EN_STOPWORDS = [
  'a',
  'about',
  'after',
  'all',
  'also',
  'am',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'because',
  'been',
  'before',
  'being',
  'between',
  'both',
  'but',
  'by',
  'can',
  'could',
  'did',
  'do',
  'does',
  'doing',
  'each',
  'few',
  'for',
  'from',
  'had',
  'has',
  'have',
  'having',
  'he',
  'her',
  'here',
  'hers',
  'him',
  'his',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'just',
  'me',
  'more',
  'most',
  'my',
  'no',
  'not',
  'now',
  'of',
  'on',
  'once',
  'only',
  'or',
  'other',
  'our',
  'out',
  'over',
  'own',
  'same',
  'she',
  'should',
  'so',
  'some',
  'such',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'through',
  'to',
  'too',
  'under',
  'until',
  'up',
  'us',
  'very',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'whom',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your',
] as const;

const AR_STOPWORDS = [
  'أو',
  'إذا',
  'أي',
  'أيضا',
  'أن',
  'أنا',
  'أنت',
  'إلى',
  'التي',
  'الذي',
  'الذين',
  'او',
  'اي',
  'ايضا',
  'ان',
  'انا',
  'انت',
  'الى',
  'بعد',
  'بعض',
  'بل',
  'بين',
  'ثم',
  'حتى',
  'عند',
  'عن',
  'على',
  'في',
  'قد',
  'كذلك',
  'كل',
  'كما',
  'لا',
  'لكن',
  'لماذا',
  'ما',
  'مع',
  'من',
  'هذه',
  'هذا',
  'هناك',
  'هنا',
  'هل',
  'هو',
  'هي',
  'هم',
  'هن',
  'كان',
  'كانت',
  'كيف',
  'متى',
  'ماذا',
  'نحن',
  'هؤلاء',
] as const;

const STOPWORDS: ReadonlySet<string> = new Set<string>([
  ...EN_STOPWORDS,
  ...AR_STOPWORDS.map((word) => normalizeText(word)),
]);

export function isStopword(token: string): boolean {
  return token.length < 2 || STOPWORDS.has(token);
}

function stemEnglish(word: string): string {
  let stem = word;
  if (stem.length > 4 && stem.endsWith('ies')) return `${stem.slice(0, -3)}y`;
  if (stem.length > 5 && stem.endsWith('sses')) stem = stem.slice(0, -2);
  if (
    stem.length > 3 &&
    stem.endsWith('s') &&
    !stem.endsWith('ss') &&
    !stem.endsWith('us')
  ) {
    stem = stem.slice(0, -1);
  }
  if (stem.length > 5 && stem.endsWith('ing')) {
    stem = stem.slice(0, -3);
  } else if (stem.length > 4 && stem.endsWith('ed')) {
    stem = stem.slice(0, -2);
  } else if (stem.length > 4 && stem.endsWith('ly')) {
    stem = stem.slice(0, -2);
  }
  if (stem.length > 3 && stem.endsWith('e')) stem = stem.slice(0, -1);
  return stem;
}

function stemArabic(word: string): string {
  let stem = word;
  // Peel a conjunction/preposition only when the definite article follows it
  // (والفيديو -> الفيديو -> فيديو). Stripping it unconditionally would corrupt
  // real roots such as "فيديو".
  while (stem.length >= 5 && /^[وفبكل]ال/.test(stem)) {
    stem = stem.slice(1);
  }
  if (stem.length >= 4 && stem.startsWith('ال')) stem = stem.slice(2);
  for (const suffix of ['ات', 'ون', 'ين', 'ها']) {
    if (stem.length >= 5 && stem.endsWith(suffix)) {
      stem = stem.slice(0, -suffix.length);
      break;
    }
  }
  return stem;
}

/** Conservative light stemmer for the two languages the app supports. */
export function stem(token: string): string {
  if (token.length === 0) return token;
  return ARABIC_SCRIPT.test(token) ? stemArabic(token) : stemEnglish(token);
}

/**
 * Tokens used for indexing and scoring: stopwords removed, then stemmed.
 * Numbers are kept because specs and timestamps are often the answer.
 */
export function indexTerms(value: string): string[] {
  const terms: string[] = [];
  for (const token of tokenize(value)) {
    if (isStopword(token)) continue;
    const term = stem(token);
    if (term.length > 0) terms.push(term);
  }
  return terms;
}
