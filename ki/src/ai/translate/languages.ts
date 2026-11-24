/**
 * Curated translation languages. Codes are short BCP-47-ish base codes (the
 * same shape the extension already stores for captured videos). Display names
 * are provided in English and Arabic so the UI stays bilingual.
 */

export interface TranslationLanguage {
  code: string;
  englishName: string;
  arabicName: string;
}

export const TRANSLATION_LANGUAGES: readonly TranslationLanguage[] = [
  { code: 'ar', englishName: 'Arabic', arabicName: 'العربية' },
  { code: 'en', englishName: 'English', arabicName: 'الإنجليزية' },
  { code: 'fr', englishName: 'French', arabicName: 'الفرنسية' },
  { code: 'es', englishName: 'Spanish', arabicName: 'الإسبانية' },
  { code: 'de', englishName: 'German', arabicName: 'الألمانية' },
  { code: 'tr', englishName: 'Turkish', arabicName: 'التركية' },
  { code: 'ur', englishName: 'Urdu', arabicName: 'الأوردية' },
  { code: 'hi', englishName: 'Hindi', arabicName: 'الهندية' },
  { code: 'id', englishName: 'Indonesian', arabicName: 'الإندونيسية' },
  { code: 'ms', englishName: 'Malay', arabicName: 'الملايو' },
  { code: 'ru', englishName: 'Russian', arabicName: 'الروسية' },
  { code: 'pt', englishName: 'Portuguese', arabicName: 'البرتغالية' },
  { code: 'it', englishName: 'Italian', arabicName: 'الإيطالية' },
  { code: 'zh', englishName: 'Chinese', arabicName: 'الصينية' },
  { code: 'ja', englishName: 'Japanese', arabicName: 'اليابانية' },
  { code: 'ko', englishName: 'Korean', arabicName: 'الكورية' },
  { code: 'fa', englishName: 'Persian', arabicName: 'الفارسية' },
  { code: 'he', englishName: 'Hebrew', arabicName: 'العبرية' },
  { code: 'sw', englishName: 'Swahili', arabicName: 'السواحيلية' },
];

const BY_CODE = new Map<string, TranslationLanguage>(
  TRANSLATION_LANGUAGES.map((language) => [language.code, language]),
);

export function isTranslationLanguage(code: string): boolean {
  return BY_CODE.has(code);
}

export function translationLanguage(code: string): TranslationLanguage | undefined {
  return BY_CODE.get(code);
}

/** Display name for a code in the requested UI language. */
export function translationLanguageName(
  code: string,
  uiLanguage: 'en' | 'ar' = 'en',
): string {
  const entry = BY_CODE.get(code);
  if (entry) {
    return uiLanguage === 'ar' ? entry.arabicName : entry.englishName;
  }
  return code;
}

/**
 * Reduce a stored video language tag (e.g. "en-US", "ar") to one of the
 * curated base codes when possible, otherwise return the lowercased tag.
 */
export function baseLanguageCode(value: string | undefined): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  const code = value.trim().toLowerCase().split(/[-_]/)[0];
  return code && code.length > 0 ? code : undefined;
}

export const TRANSLATION_LANGUAGE_CODES: readonly string[] =
  TRANSLATION_LANGUAGES.map((language) => language.code);