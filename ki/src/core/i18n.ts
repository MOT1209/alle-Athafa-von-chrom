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
  'app.title': 'videoKING AI',
  'app.tagline': 'Local-first video knowledge',
  'app.language': 'العربية',
  'app.phaseNote':
    'Phases 1-8 (partial): local AI runtime, YouTube capture, summaries, chat, transcript tools, study material, audio transcription, and kids story studio. Store readiness arrives next.',

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

  'tab.runtime': 'Runtime',
  'tab.video': 'Video',
  'tab.library': 'Library',
  'tab.summary': 'Summary',
  'tab.chat': 'Chat',
  'tab.transcript': 'Transcript',
  'tab.learning': 'Study',
  'tab.studio': 'Studio',

  'video.notYoutube': 'Open a YouTube video page, then refresh.',
  'video.noActiveTab': 'No active tab found.',
  'video.checking': 'Checking the current tab…',
  'video.refresh': 'Re-check tab',
  'video.consentTitle': 'Consent required',
  'video.consentBody':
    'Capturing reads the caption track YouTube itself shows for this video (the official transcript). The text is stored locally on your device. No video or audio is downloaded, nothing is published, and nothing is sent to external servers.',
  'video.grant': 'I agree — enable capture',
  'video.revoke': 'Revoke consent',
  'video.consentGranted': 'Capture consent granted',
  'video.capture': 'Capture transcript',
  'video.captured': 'Transcript saved: {count} segments',
  'video.viewInLibrary': 'Open in library',
  'video.noCaptions': 'This video has no accessible captions. Local audio transcription (Whisper) arrives in Phase 7.',
  'video.captureFailed': 'Capture failed in this session. YouTube may limit automated access; try a normal window or another video.',
  'video.language': 'Language',
  'video.duration': 'Duration',
  'video.channel': 'Channel',
  'video.segments': '{count} segments',
  'video.tracks': 'Caption tracks',
  'video.trackManual': 'manual',
  'video.trackAsr': 'auto',
  'video.preferredLanguage': 'Preferred caption language (optional)',

  'library.empty': 'No captured videos yet. Capture one from the Video tab.',
  'library.open': 'Open',
  'library.deleteConfirm': 'Delete "{title}" and its transcript from local storage?',
  'library.back': 'Back to list',
  'library.capturedAt': 'Captured',
  'library.transcript': 'Transcript',

  'summary.title': 'Video summaries',
  'summary.localNote':
    'Summaries are generated on your device by the local model from the stored transcript. Nothing is sent to external servers.',
  'summary.empty':
    'No captured videos yet. Capture a transcript from the Video tab first.',
  'summary.none':
    'No summaries yet. Choose a captured video below and summarize it.',
  'summary.generate': 'Summarize',
  'summary.regenerate': 'Regenerate',
  'summary.open': 'Open summary',
  'summary.back': 'Back to summaries',
  'summary.overview': 'Overview',
  'summary.keyPoints': 'Key points',
  'summary.chapters': 'Chapters',
  'summary.ready': 'Summary ready',
  'summary.generated': 'Generated',
  'summary.model': 'Model',
  'summary.parts': '{count} parts',
  'summary.deleteConfirm':
    'Delete the summary of "{title}"? The transcript stays in the library.',
  'summary.cancelNote':
    'You can cancel while it runs. Partial results are never saved.',
  'summary.progress': 'Summarizing locally…',
  'summary.failed': 'Summary failed',
  'summary.retryTask': 'Retry task',
  'summary.noSummary': 'No summary yet.',
  'summary.openAt': 'Open the video at {time}',
  'summary.languageNote': 'The summary uses the transcript language.',

  'chat.title': 'Chat with a video',
  'chat.localNote':
    'Questions are answered on your device by the local model from the stored transcript. When the transcript does not cover the answer, the assistant says so instead of guessing.',
  'chat.empty':
    'No captured videos yet. Capture a transcript from the Video tab first.',
  'chat.none':
    'No conversation yet. Choose a captured video below and ask a question.',
  'chat.ask': 'Ask',
  'chat.placeholder': 'Ask about this video…',
  'chat.open': 'Open conversation',
  'chat.back': 'Back to chats',
  'chat.you': 'You',
  'chat.assistant': 'Assistant',
  'chat.askHint':
    'You can cancel while it runs. Nothing partial is saved.',
  'chat.progress': 'Answering from the transcript…',
  'chat.failed': 'Question failed',
  'chat.retryTask': 'Retry task',
  'chat.notInVideo':
    'This is not covered in the video transcript, so the assistant will not guess.',
  'chat.citations': 'Sources',
  'chat.clearConfirm':
    'Delete the conversation about "{title}"? The transcript stays in the library.',
  'chat.clear': 'Clear conversation',
  'chat.noConversation': 'No conversation yet.',
  'chat.answered': 'Answered from the transcript',
  'chat.messages': '{count} messages',
  'chat.openAt': 'Open the video at {time}',
  'chat.emptyQuestion': 'Type a question first.',
  'chat.updated': 'Updated',
} as const;

export type MessageKey = keyof typeof en;

const ar: Record<MessageKey, string> = {
  'app.title': 'videoKING AI',
  'app.tagline': 'معرفة الفيديو محليًا أولًا',
  'app.language': 'English',
  'app.phaseNote':
    'المراحل 1-8 (جزئي): بيئة الذكاء الاصطناعي، والتقاط YouTube، والملخصات، والمحادثة، وأدوات النص، والمادة الدراسية، والتفريغ الصوتي، واستوديو قصص الأطفال. جاهزية المتجر تصل تاليًا.',

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

  'tab.runtime': 'البيئة',
  'tab.video': 'الفيديو',
  'tab.library': 'المكتبة',
  'tab.summary': 'الملخص',
  'tab.chat': 'المحادثة',
  'tab.transcript': 'النص',
  'tab.learning': 'الدراسة',
  'tab.studio': 'الاستوديو',

  'video.notYoutube': 'افتح صفحة فيديو على YouTube ثم حدّث.',
  'video.noActiveTab': 'لا توجد علامة تبويب نشطة.',
  'video.checking': 'جارٍ فحص علامة التبويب الحالية…',
  'video.refresh': 'إعادة فحص التبويب',
  'video.consentTitle': 'الموافقة مطلوبة',
  'video.consentBody':
    'يلتقط النص من مسار الترجمة الذي يعرضه YouTube نفسه لهذا الفيديو (النص الرسمي). يُخزَّن النص محليًا على جهازك. لا يُنزَّل أي فيديو أو صوت، ولا يُنشر شيء، ولا يُرسل شيء إلى خوادم خارجية.',
  'video.grant': 'أوافق — تفعيل الالتقاط',
  'video.revoke': 'سحب الموافقة',
  'video.consentGranted': 'تم منح موافقة الالتقاط',
  'video.capture': 'التقاط النص',
  'video.captured': 'تم حفظ النص: {count} مقطعًا',
  'video.viewInLibrary': 'فتح في المكتبة',
  'video.noCaptions': 'لا توجد ترجمات متاحة لهذا الفيديو. التفريغ الصوتي المحلي (Whisper) يصل في المرحلة 7.',
  'video.captureFailed': 'فشل الالتقاط في هذه الجلسة. قد يقيّد YouTube الوصول الآلي؛ جرّب نافذة عادية أو فيديو آخر.',
  'video.language': 'اللغة',
  'video.duration': 'المدة',
  'video.channel': 'القناة',
  'video.segments': '{count} مقطعًا',
  'video.tracks': 'مسارات الترجمة',
  'video.trackManual': 'يدوي',
  'video.trackAsr': 'تلقائي',
  'video.preferredLanguage': 'لغة الترجمة المفضلة (اختياري)',

  'library.empty': 'لا فيديوهات ملتقطة بعد. التقط واحدًا من تبويب الفيديو.',
  'library.open': 'فتح',
  'library.deleteConfirm': 'حذف "{title}" ونصه من التخزين المحلي؟',
  'library.back': 'عودة إلى القائمة',
  'library.capturedAt': 'التُقط في',
  'library.transcript': 'النص',

  'summary.title': 'ملخصات الفيديو',
  'summary.localNote':
    'تُنشأ الملخصات على جهازك بواسطة النموذج المحلي من النص المخزّن. لا يُرسل شيء إلى خوادم خارجية.',
  'summary.empty':
    'لا فيديوهات ملتقطة بعد. التقط نصًا من تبويب الفيديو أولًا.',
  'summary.none':
    'لا ملخصات بعد. اختر فيديو ملتقطًا أدناه ولخّصه.',
  'summary.generate': 'تلخيص',
  'summary.regenerate': 'إعادة التلخيص',
  'summary.open': 'فتح الملخص',
  'summary.back': 'عودة إلى الملخصات',
  'summary.overview': 'نظرة عامة',
  'summary.keyPoints': 'النقاط الرئيسية',
  'summary.chapters': 'الفصول',
  'summary.ready': 'الملخص جاهز',
  'summary.generated': 'أُنشئ في',
  'summary.model': 'النموذج',
  'summary.parts': '{count} أجزاء',
  'summary.deleteConfirm':
    'حذف ملخص "{title}"؟ يبقى النص في المكتبة.',
  'summary.cancelNote':
    'يمكنك الإلغاء أثناء التشغيل. لا تُحفظ النتائج الجزئية أبدًا.',
  'summary.progress': 'جارٍ التلخيص محليًا…',
  'summary.failed': 'فشل التلخيص',
  'summary.retryTask': 'إعادة محاولة المهمة',
  'summary.noSummary': 'لا ملخص بعد.',
  'summary.openAt': 'فتح الفيديو عند {time}',
  'summary.languageNote': 'يستخدم الملخص لغة النص.',

  'chat.title': 'محادثة مع فيديو',
  'chat.localNote':
    'تُجاب الأسئلة على جهازك بواسطة النموذج المحلي من النص المخزّن. وإذا لم يغطِّ النص الإجابة، يقول المساعد ذلك بدلًا من التخمين.',
  'chat.empty':
    'لا فيديوهات ملتقطة بعد. التقط نصًا من تبويب الفيديو أولًا.',
  'chat.none':
    'لا محادثة بعد. اختر فيديو ملتقطًا أدناه واسأل عنه.',
  'chat.ask': 'اسأل',
  'chat.placeholder': 'اسأل عن هذا الفيديو…',
  'chat.open': 'فتح المحادثة',
  'chat.back': 'عودة إلى المحادثات',
  'chat.you': 'أنت',
  'chat.assistant': 'المساعد',
  'chat.askHint':
    'يمكنك الإلغاء أثناء التشغيل. لا تُحفظ الإجابات الجزئية أبدًا.',
  'chat.progress': 'جارٍ الإجابة من النص…',
  'chat.failed': 'فشل السؤال',
  'chat.retryTask': 'إعادة محاولة المهمة',
  'chat.notInVideo':
    'هذا غير مذكور في نص الفيديو، لذلك لن يخمّن المساعد.',
  'chat.citations': 'المصادر',
  'chat.clearConfirm':
    'حذف المحادثة عن "{title}"؟ يبقى النص في المكتبة.',
  'chat.clear': 'مسح المحادثة',
  'chat.noConversation': 'لا محادثة بعد.',
  'chat.answered': 'أُجيبت من النص',
  'chat.messages': '{count} رسائل',
  'chat.openAt': 'فتح الفيديو عند {time}',
  'chat.emptyQuestion': 'اكتب سؤالًا أولًا.',
  'chat.updated': 'آخر تحديث',
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
