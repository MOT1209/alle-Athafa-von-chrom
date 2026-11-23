/**
 * Tiny i18n layer: English + Arabic with RTL support.
 * Every user-facing string in the Phase 1 UI goes through `t()`.
 */

export type Language = 'en' | 'ar';

export const LANGUAGES: readonly Language[] = ['en', 'ar'];

export function isLanguage(value: unknown): value is Language {
  return value === 'en' || value === 'ar';
}

const en = {
  'app.title': 'VideoMind AI',
  'app.tagline': 'Local-first video knowledge',
  'app.language': 'العربية',
  'app.phaseNote':
    'Phase 1: Local AI runtime. Video, transcript and learning modules arrive in the next phases.',

  'common.cancel': 'Cancel',
  'common.retry': 'Retry',
  'common.refresh': 'Refresh',
  'common.save': 'Save settings',
  'common.reset': 'Reset defaults',
  'common.loading': 'Loading…',
  'common.delete': 'Delete',
  'common.test': 'Test',
  'common.close': 'Close',

  'status.connected': 'Connected',
  'status.disconnected': 'Not reachable',
  'status.checking': 'Checking…',

  'runtime.title': 'Local AI runtime (Ollama)',
  'runtime.version': 'Version',
  'runtime.loaded': 'Loaded in memory',
  'runtime.noneLoaded': 'No model loaded right now',
  'runtime.memory': 'Memory budget',
  'runtime.memoryUnknown': 'Device memory unknown (browser does not expose it)',
  'runtime.testConnection': 'Test connection',
  'runtime.latencyMs': '{ms} ms',
  'runtime.modelCount': '{count} models installed',
  'runtime.vram': 'VRAM {mb} MB',

  'models.title': 'Models',
  'models.empty': 'No models installed. Pull one below to get started.',
  'models.defaultBadge': 'Default',
  'models.use': 'Use as default',
  'models.pullPlaceholder': 'model name, e.g. qwen2.5:1.5b',
  'models.pull': 'Pull model',
  'models.sizeGb': '{gb} GB',
  'models.params': '{size} params',
  'models.quant': 'quant {level}',
  'models.deleteConfirm': 'Delete model "{name}" from Ollama? This frees disk space and cannot be undone.',
  'models.inUse': 'This model is used by a queued or running task.',

  'queue.title': 'Task queue (sequential)',
  'queue.empty': 'No tasks yet. AI tasks run one at a time to protect memory.',
  'queue.queued': 'Queued',
  'queue.running': 'Running',
  'queue.succeeded': 'Done',
  'queue.failed': 'Failed',
  'queue.cancelled': 'Cancelled',
  'queue.retrying': 'Waiting to retry…',
  'queue.attempt': 'attempt {n}/{max}',
  'queue.result': 'Result',

  'settings.title': 'Settings',
  'settings.baseUrl': 'Ollama base URL',
  'settings.keepAlive': 'Keep model loaded (keep_alive)',
  'settings.requestTimeout': 'Request timeout (ms)',
  'settings.numCtx': 'Context window (num_ctx)',
  'settings.temperature': 'Temperature',
  'settings.numPredict': 'Max output tokens (num_predict)',
  'settings.maxRetries': 'Max retries per task',
  'settings.retryDelay': 'Retry base delay (ms)',
  'settings.maxQueue': 'Max queued tasks',
  'settings.reserveMb': 'Reserved system memory (MB)',
  'settings.enforceBudget': 'Block tasks that exceed the memory budget',
  'settings.unloadAfterTask': 'Unload model right after each task (saves RAM)',
  'settings.saved': 'Settings saved',
  'settings.hint':
    'Defaults target an 8 GB RAM machine: one model at a time, small context, short keep-alive.',

  'error.title': 'Something went wrong',

  'testModel.reply': 'Model replied: {reply}',
} as const;

export type MessageKey = keyof typeof en;

const ar: Record<MessageKey, string> = {
  'app.title': 'VideoMind AI',
  'app.tagline': 'معرفة الفيديو محليًا أولًا',
  'app.language': 'English',
  'app.phaseNote':
    'المرحلة 1: بيئة الذكاء الاصطناعي المحلية. وحدات الفيديو والنصوص والتعلم تصل في المراحل التالية.',

  'common.cancel': 'إلغاء',
  'common.retry': 'إعادة المحاولة',
  'common.refresh': 'تحديث',
  'common.save': 'حفظ الإعدادات',
  'common.reset': 'استعادة الافتراضيات',
  'common.loading': 'جارٍ التحميل…',
  'common.delete': 'حذف',
  'common.test': 'اختبار',
  'common.close': 'إغلاق',

  'status.connected': 'متصل',
  'status.disconnected': 'غير قابل للوصول',
  'status.checking': 'جارٍ الفحص…',

  'runtime.title': 'بيئة الذكاء الاصطناعي المحلية (Ollama)',
  'runtime.version': 'الإصدار',
  'runtime.loaded': 'محمّل في الذاكرة',
  'runtime.noneLoaded': 'لا يوجد نموذج محمّل حاليًا',
  'runtime.memory': 'ميزانية الذاكرة',
  'runtime.memoryUnknown': 'ذاكرة الجهاز غير معروفة (المتصفح لا يكشفها)',
  'runtime.testConnection': 'اختبار الاتصال',
  'runtime.latencyMs': '{ms} مللي ثانية',
  'runtime.modelCount': '{count} نموذجًا مثبتًا',
  'runtime.vram': 'ذاكرة رسومية {mb} MB',

  'models.title': 'النماذج',
  'models.empty': 'لا توجد نماذج مثبتة. اسحب نموذجًا أدناه للبدء.',
  'models.defaultBadge': 'الافتراضي',
  'models.use': 'اعتماده افتراضيًا',
  'models.pullPlaceholder': 'اسم النموذج، مثل qwen2.5:1.5b',
  'models.pull': 'سحب النموذج',
  'models.sizeGb': '{gb} GB',
  'models.params': '{size} معلمة',
  'models.quant': 'تكميم {level}',
  'models.deleteConfirm': 'حذف النموذج "{name}" من Ollama؟ هذا يحرر مساحة القرص ولا يمكن التراجع عنه.',
  'models.inUse': 'هذا النموذج مستخدم في مهمة queued أو قيد التشغيل.',

  'queue.title': 'طابور المهام (تنفيذ تسلسلي)',
  'queue.empty': 'لا مهام بعد. مهام الذكاء الاصطناعي تعمل واحدة تلو الأخرى حمايةً للذاكرة.',
  'queue.queued': 'في الانتظار',
  'queue.running': 'قيد التشغيل',
  'queue.succeeded': 'اكتملت',
  'queue.failed': 'فشلت',
  'queue.cancelled': 'أُلغيت',
  'queue.retrying': 'بانتظار إعادة المحاولة…',
  'queue.attempt': 'المحاولة {n}/{max}',
  'queue.result': 'النتيجة',

  'settings.title': 'الإعدادات',
  'settings.baseUrl': 'عنوان Ollama',
  'settings.keepAlive': 'مدة إبقاء النموذج محمّلًا (keep_alive)',
  'settings.requestTimeout': 'مهلة الطلب (مللي ثانية)',
  'settings.numCtx': 'نافذة السياق (num_ctx)',
  'settings.temperature': 'درجة الحرارة (Temperature)',
  'settings.numPredict': 'أقصى رموز الإخراج (num_predict)',
  'settings.maxRetries': 'أقصى محاولات إعادة لكل مهمة',
  'settings.retryDelay': 'التأخير الأساسي لإعادة المحاولة (مللي ثانية)',
  'settings.maxQueue': 'أقصى عدد للمهام المنتظرة',
  'settings.reserveMb': 'ذاكرة النظام المحجوزة (MB)',
  'settings.enforceBudget': 'منع المهام التي تتجاوز ميزانية الذاكرة',
  'settings.unloadAfterTask': 'تفريغ النموذج فور انتهاء كل مهمة (يوفر الذاكرة)',
  'settings.saved': 'تم حفظ الإعدادات',
  'settings.hint':
    'الافتراضات مصممة لجهاز بذاكرة 8 GB: نموذج واحد في كل مرة، سياق صغير، وإبقاء قصير.',

  'error.title': 'حدث خطأ ما',

  'testModel.reply': 'رد النموذج: {reply}',
};

const dictionaries: Record<Language, Record<MessageKey, string>> = {
  en,
  ar,
};

export function t(
  lang: Language,
  key: MessageKey,
  vars?: Record<string, string | number>,
): string {
  const dict = dictionaries[lang] ?? en;
  let text: string = dict[key] ?? en[key];
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
}

export function isRtl(lang: Language): boolean {
  return lang === 'ar';
}
