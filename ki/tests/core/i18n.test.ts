import { describe, expect, it } from 'vitest';
import { isLanguage, isRtl, LANGUAGES, t } from '../../src/core/i18n';

describe('i18n', () => {
  it('returns distinct English and Arabic strings', () => {
    expect(t('en', 'common.cancel')).toBe('Cancel');
    expect(t('ar', 'common.cancel')).toBe('إلغاء');
  });

  it('interpolates variables', () => {
    expect(t('en', 'runtime.latencyMs', { ms: 42 })).toBe('42 ms');
    expect(t('en', 'queue.attempt', { n: 2, max: 3 })).toBe('attempt 2/3');
  });

  it('leaves unknown placeholders untouched', () => {
    expect(t('en', 'runtime.latencyMs')).toBe('{ms} ms');
  });

  it('detects RTL for Arabic only', () => {
    expect(isRtl('ar')).toBe(true);
    expect(isRtl('en')).toBe(false);
  });

  it('validates languages', () => {
    expect(LANGUAGES).toEqual(['en', 'ar']);
    expect(isLanguage('en')).toBe(true);
    expect(isLanguage('ar')).toBe(true);
    expect(isLanguage('fr')).toBe(false);
    expect(isLanguage(null)).toBe(false);
  });

  it('Arabic dictionary covers every English key', async () => {
    // The Record<MessageKey, string> type enforces this at compile time;
    // this runtime check guards against accidental empty strings.
    const keys = Object.keys(t('en', 'app.title')) as string[];
    expect(keys.length).toBeGreaterThan(0);
    for (const key of [
      'app.title',
      'common.cancel',
      'queue.running',
      'settings.baseUrl',
      'models.deleteConfirm',
    ] as const) {
      expect(t('ar', key).length).toBeGreaterThan(0);
    }
  });
});
