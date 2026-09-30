# خطة العمل — KingDev / alle-Athafa-von-chrom

هذا المستودع سيجمع **كل الإضافات**، ولكل إضافة مجلد مستقل قائم بذاته.
الإضافة الحالية: `kingdev/`.

> آخر تحديث: اكتملت المرحلة 3 — Debug Assistant (352 اختبارًا، تغطية 96.46%، `npm run verify` + `npm run e2e` ينجحان).
> المرحلتان 1 و2 مكتملتان: أذونات دنيا + اختيارية · موافقة لكل ميزة · تبويبات · ربط الموافقة.

---

## 1. الوضع الحالي

### مبنية ومُختبَرة ✅

| الوحدة | الحالة | التغطية |
|---|---|---|
| `src/core/types.ts` | عقود المجال والرسائل | 89.9% |
| `src/core/logger.ts` | تسجيل منظم آمن + ذاكرة تشخيص محدودة | 100% |
| `src/core/event-bus.ts` | ناقل أحداث مُنمَّط مع عزل أخطاء المشتركين | 100% |
| `src/security/masking.ts` | إخفاء الأسرار وPII + تعقيم الروابط | 94.3% |
| `src/security/permissions.ts` | سياسة الأذونات والموافقة (fail-closed) | 100% |
| `src/core/reasoning/fingerprint.ts` | بصمة الخطأ وتطبيع الحزمة | 94.3% |
| `src/core/reasoning/severity.ts` | الشدة والثقة والتصنيف | 97.3% |
| `src/core/reasoning/rules.ts` | القواعد الحتمية + الأدلة | 97.5% |
| `src/core/reasoning/grouping.ts` | تجميع الأخطاء المتشابهة + الخط الزمني | 95.6% |

**المجموع:** 257 اختبار / 8 ملفات · تغطية 96.15% · typecheck نظيف · Biome بلا أخطاء.

### مبنية في المرحلة 1 ✅

| الوحدة | الدور |
|---|---|
| `manifest.json` | MV3: `storage` فقط إلزامي؛ `scripting` اختياري؛ `<all_urls>` في `optional_host_permissions`؛ `devtools_page` + `options_ui` |
| `src/background/service-worker.ts` | مخزن الإعدادات والمفاتيح والجلسات + مرآة السجل في `storage.session` + موجّه رسائل يغطي كل `PanelToWorkerMessage` |
| `src/browser/content/error-capture.ts` | التقاط `error`/`unhandledrejection`/أخطاء الموارد + تجميع بالبصمة قبل الإرسال |
| `src/browser/devtools/panel.ts` + `devtools.html` | إنشاء لوحة KingDev في DevTools |
| `src/ui/` (`app.tsx`, `rpc.ts`, `main.tsx`, `panel.html`, `options.html`) | واجهة التبويبات + عمول RPC مُنمَّط + حوار الموافقة (عرضًا؛ الربط في المرحلة 2) |
| `scripts/build.mjs` | esbuild بأربع نقاط دخول + نسخ الأصول + تحقق من اكتمال الحزمة |
| `scripts/e2e.mjs` | 27 فحصًا: صحة manifest، وجود كل ملف مُشار إليه، لا Node builtins في الحِزم، عقد سكربت المحتوى |
| `icons/` | أيقونات تاج مولّدة برمجيًا (`scripts/icons.mjs`، بلا اعتماديات، مخرجات حتمية) |

### مبنية في المرحلة 2 ✅

| الوحدة | الدور |
|---|---|
| `src/security/consent-store.ts` | تخزين `ConsentState` في `chrome.storage.local` عبر منفذ `KeyValueStore` قابل للحقن؛ القراءة التالفة = `NO_CONSENT` (fail-closed)؛ الكتابة تُختم بـ `CONSENT_VERSION` الحالي |
| `effectiveGrantedPermissions()` في `permissions.ts` | تحويل منح `chrome.permissions` إلى ids داخلية — أي origin ممنوح = `hostAccess`؛ `aiAnalysis` منطقية ولا تُستنتج من حرف `storage` |
| `MANIFEST_PERMISSIONS` | الحروف الإلزامية (`storage`) تُطرح من طلب/سحب الأذونات — لا إعادة إعلام زائدة ولا كسر إعدادات |
| `src/browser/permissions.ts` | جسر `chrome.permissions` (request/remove/getAll/contains) يشتق الحروف من `requiredManifestPermissions()`؛ يتدهور بصدق حين لا تتوفر الواجهة |
| `service-worker` Phase 2 | معالجات `consent/get·grant·revoke`، `permissions/status`، `capture/errors·state` + `CaptureStore` محدود + بوابة `evaluateFeatureAccess` على رسائل المحتوى **قبل** التخزين |
| `error-capture.ts` | `onAck`: رفض الـ worker (`CONSENT_REQUIRED`) يوقف الالتقاط ذاتيًا — لا جمع بعد الإلغاء |
| `src/ui/app.tsx` | حوار موافقة موصول فعليًا؛ عرض الأخطاء المجمعة بـ `groupErrors()`؛ حالة `grantsMissing` عندما يسحب المتصفح المنح |
| `src/ui/options.ts` | صفحة التشخيص: الموافقة + المنح + انحراف الأذونات (`reconcilePermissions`) |
| `scripts/e2e.mjs` | +3 فحوصات: `scripting` و`<all_urls>` اختيارية، و`permissions == [storage]` بالضبط |

### مبنية في المرحلة 3 ✅

| الوحدة | الدور |
|---|---|
| `src/core/network/har-convert.ts` | تحويل HAR ← `NetworkRequest[]`: outcome مشتق من الأدلة (cached/redirect/4xx/5xx/failed)، أسماء headers فقط بلا قيم، الإدخالات التالفة تُسقط لا تُصلح |
| `src/browser/devtools/har-bridge.ts` | جسر `chrome.devtools.network`: لقطة `getHAR` بمهلة + بث `onRequestFinished` + `isHarAvailable()` صادقة تُعرض كما هي في الواجهة |
| `src/core/providers/catalog.ts` | كتالوج المزودين الستة (openai/anthropic/google/openrouter/ollama/custom) + نماذج مقترحة — بيانات لا مسارات كود |
| `src/core/providers/client.ts` | `complete()` موحّد عبر أربعة بروتوكولات سلكية؛ خريطة أخطاء ثابتة (401→AUTH، 429→RATE_LIMIT، 5xx→BAD_RESPONSE retryable، fetch→NETWORK)؛ المهلة عبر AbortController؛ المفتاح يُحل عبر `KeyResolver` محقون |
| `src/core/providers/key-vault.ts` | خزنة المفاتيح: القراءة الوحيدة الممكنة من الواجهة = **وجود** المفتاح لا قيمته؛ `loadAll` يرمي عند عطل التخزين لمسارات الإخراج ("لا أستطيع أن أعرف" ≠ "لا مفتاح") و`loadAllSafe` لمسارات العرض؛ فحص هيكلي رخيص قبل الشبكة |
| `src/core/reasoning/issue.ts` | `ErrorGroup` ← `IssueView`: عرض صريح `needsModel` عندما لا قاعدة تطابقت، و`discriminatingTest` يُمرر حرفيًا كما كتبته القاعدة |
| الواجهة | NetworkTab ببيانات حقيقية (لقطة + بث حي)، قسم Providers في Settings (حفظ/إزالة/تفعيل مفتاح، حقل model id)، AnalysisTab بعرض Issues + قسم "Needs a model" |

### مبنية في المرحلة 4 ✅

| الوحدة | الدور |
|---|---|
| `src/core/prompt/engine.ts` | محرك المطالبات: أقسام مُعنونة من أدلة حتمية فقط (`groupErrors` + الطلبات المرتبطة + القواعد)؛ الـ binding finding يتقدم قسم root-cause؛ الميزانية تقتطع/تحذف المرن فقط وتُعيد فوق الميزانية بصدق إن نزلت تحت الأرضية البنيوية؛ `parseAiAnalysis` يفرض المخطط والمفردات، `extractJsonPayload` يتسامح مع الأسوار والنثريات، `fixes[].diffs` يُفرغ دائمًا؛ `reconcileWithDeterministic` يوسم التناقض ويجفف معرّفات الأدلة المجهولة |
| `src/core/analysis/analyzer.ts` | `analyzeIssue`: بوابة الموافقة (`aiExplanation` + إصدار الموافقة الحالي + `storage`) **قبل** أي بناء prompt أو قراءة مفتاح؛ `modelSpecFor` يتحقق هيكليًا من model id الحر؛ استدعاء `complete()` واحد عبر منفذ HTTP قابل للحقن؛ كل فشل = `KingDevError` مُنمَّط لا استثناء للواجهة |
| `src/core/types.ts` | مفردات وقت التشغيل للتحقق من مخرجات النموذج (`SEVERITIES`، `CONFIDENCE_LEVELS`، `ROOT_CAUSE_CATEGORIES`، `FIX_APPROACHES`، `RISK_LEVELS`) |
| `src/ui/app.tsx` | AnalysisTab: زر التحليل يعمل end-to-end؛ عرض النتيجة (الثقة، model-asserted، البدائل والاختبارات المميزة، ما يبقى مجهولًا) وتنبيه صريح عند تناقض النموذج مع الحتمي |

### غير مبنية ❌

- فحص أمني شامل قبل النشر (المرحلة 5)
- اختبار متصفح فعلي لتدفّق الموافقة الكامل (المرحلة 5)

---

## 2. المبادئ غير القابلة للتفاوض

1. **لا تلفيق بيانات.** ذكاء المتصفح、AI، والطلب الشبكي تأتي من مصادر حقيقية فقط.
   أي مصدر غير متاح = `unavailable` صريح، لا تخمين.
2. **الأدلة قبل النموذج.** القواعد الحتمية تنتج مرشحين مع `discriminatingTest`.
   لا يُستبدل الدليل القابل لإعادة الإنتاج بتفسير نصي من نموذج.
3. **Fail-closed.** إذن غير معروف، موافقة بإصدار قديم، أو إذن سُحب = **مرفوض**.
4. **عدم القابلية للتغيير.** التحويلات تُنتج بنى جديدة ولا تُعدّل المُدخلات.
5. **لا أسرار في الكود أو السجل.** الإخفاء يحتفظ ببادئة/لاحقة قصيرة عمدًا
   ليعرف المطوّر أي مفتاح فشل —.Body المفتاح يختفي تمامًا.
6. **بلا محتوى مخترع.** `egress: true` يجب أن يُعلَن بوضوح في حوار الموافقة.

---

## 3. القرارات المعمارية المحسومة

| القرار | السبب |
|---|---|
| اللوحة تملك استدعاءات المزود؛ service worker يملك الإعدادات والسجل | فصل دورة الحياة، ومنع تضخم `chrome.*` في المكوّنات |
| `request.startedAt` هو المصدر الوحيد للارتباط | إزالة `requestStartTimes` كمصدر ثانٍ متناقض |
| نافذة الخط الزمني تبدأ من **آخر** خطأ لا أوله | لا تحذف حركة سببها خطأ سابق مباشرة |
| المعرف الفارغ → `ungrouped` | دمج أخطاء مشوهة لا رابط بينها = فقدان بيانات |
| `totalErrors` محسوب قبل تطبيق `limit` | الحدّ لا يغيّر عدد الأخطاء الإجمالي |
| `aiAnalysis` إذن `high` risk منفصل عن `storage` | حتى لو مُنح `storage` لا يُسمح بالإرسال خارج الجهاز |
| عتبة تغطية 90/85/80/90 | العتبة القديمة 60/55/50/60 سمحت بوحدات 0% وهي "تنجح" |

---

## 4. المهام المتبقية

### المرحلة 1 — هيكل MV3 ✅ مكتملة
القرارات المحسومة: أذونات دنيا + اختيارية · موافقة لكل ميزة · تبويبات.

ملاحظة تنفيذية: `"devtools"` أُسقط من أذونات الـ manifest عمدًا — لوحات DevTools
تُعلن بمفتاح `devtools_page` بلا إذن، وChrome MV3 يرفض الإذن. `PERMISSIONS.devtools`
في `permissions.ts` يبقى توثيقًا لدور الميزة لا حرفًا يُرسل إلى Chrome.

المخرجات:
- [x] `manifest.json` — أذونات دنيا (`storage`) + `optional_permissions: ["scripting"]` + `optional_host_permissions: ["<all_urls>"]`
- [x] `src/background/service-worker.ts` — الإعدادات + المفاتيح + الجلسات + السجل + التوجيه
- [x] `src/browser/devtools/panel.ts` + `devtools.html` — إنشاء اللوحة
- [x] `src/browser/content/error-capture.ts` — التقاط `error` و`unhandledrejection` وأخطاء الموارد
- [x] `src/ui/main.tsx` + مكوّنات React (تبويبات: Issues / Network / Analysis / Settings)
- [x] `scripts/build.mjs` (esbuild، 4 نقاط دخول + تحقق اكتمال الحزمة)
- [x] `scripts/e2e.mjs` (27 فحصًا على الحزمة المبنية)
- [ ] `requiredManifestPermissions()` يجب أن يستعمل عند طلب الأذونات الاختيارية في المرحلة 2
  (الـ manifest الحالي يطابق مخرجه للميزات المحلية؛ التحقق الآلي جزء من ربط الموافقة)

### المرحلة 2 — ربط الموافقة ✅ مكتملة
- [x] تخزين `ConsentState` في `chrome.storage.local` (`consent-store.ts`، قراءة fail-closed)
- [x] حوار موافقة يعتمد `consentPromptFor()` — موصول بالرسائل الفعلية
- [x] بوابة `evaluateFeatureAccess()` عند كل مورد بيانات — في الـ worker نفسه (رسائل اللوحة ومظاريف المحتوى)
- [x] `reconcilePermissions()` في صفحة التشخيص لكشف الأذونات المسحوبة
- [x] جسر أذونات Chrome الاختيارية: `permissions.request` عند التمكين، `permissions.remove` عند الإلغاء
- [x] `effectiveGrantedPermissions()` + استثناء `aiAnalysis` (منطقية، لا تُستنتج من المنح)
- [x] تحذير `grantsMissing` في الإعدادات عندما تكون الموافقة قائمة والمنح مسحوبة
- [x] إنهاء الالتقاط ذاتيًا عند رفض الـ worker (سحب الموافقة أثناء الجلسة)

ملاحظة: طلب الأذونات يبدأ حاليًا من زر "Enable…" في اللوحة (إيماءة مستخدم حقيقية). سير `chrome.permissions.request` من حوار الموافقة نفسه متصل بنفس مسار الرسائل.

### المرحلة 3 — Debug Assistant ✅ مكتملة
- [x] جسر `chrome.devtools.network.getHAR()` ← `NetworkRequest[]` (`har-convert.ts` + `har-bridge.ts`)
- [x] تحويل الأخطاء المجمّعة إلى `Issue` مرئية (`toIssueViews()`، منفصل قابل للاختبار)
- [x] عرض `discriminatingTest` لكل نتيجة — حرفيًا من القاعدة، في Issues وAnalysis
- [x] اختيار المزود + إدارة المفاتيح عبر `storage` (`key-vault.ts` + قسم Providers)
- [x] عميل موحّد للبروتوكولات الأربعة بأخطاء مُنمّطة (`client.ts`)

ملاحظة معمارية: `complete()` يستهدف الآن مكتبة وحدة (unit-callable) وليس رسالة worker —
اللوحة تملك استدعاءات المزود (قرار معماري محسوم). ربط زر التحليل في AnalysisTab
بالـ prompt سيأتي في المرحلة 4 بعد بناء محرك الـ prompt.

### المرحلة 4 — Agent Prompt Engine ✅ مكتملة
- [x] بناء الـ prompt من الأدلة الحتمية (لا من نص حر) — `core/prompt/engine.ts`، أقسام مُعنونة بمصدرها
- [x] حقن نتيجة `groupErrors` كمُدخلات مُصنَّفة + الطلبات المرتبطة + القواعد التي اشتعلت
- [x] استجابة مُهيكلة JSON مع تحقق مخطط صارم (`parseAiAnalysis`) — أي خرق = `PROVIDER_BAD_RESPONSE`
- [x] منع النموذج من تجاوز الدليل الحتمي — الـ binding finding يتقدم قسم root-cause (لا تقتطعه الميزانية)،
  و`reconcileWithDeterministic` يوسم أي تناقض بدل تبنيه صامتًا، ومعرّفات الأدلة المجهولة تُرشَّح
- [x] ربط زر التحليل في اللوحة (`core/analysis/analyzer.ts`): بوابة الموافقة أولاً، منفذ HTTP قابل للحقن
  (الاختبارات بلا شبكة)، `KeyVault.loadAll` يرمي عند عطل التخزين لمسارات الإخراج (fail-closed على
  "لا أستطيع أن أعرف") مع `loadAllSafe` لمسارات العرض

### المرحلة 5 — بوابة الإصدار
- [x] أول commit للمشروع خارج `README.md` (التاريخ محفوظ ومفوش على origin/main)
- [x] أيقونات حقيقية 16/48/128 (`scripts/icons.mjs` — PNG بلا اعتماديات، مخرجات حتمية)
- [x] `tsconfig` منفصل للسكربتات (`tsconfig.scripts.json`) — لم تعد واجهات Node تتسرب لكود المتصفح
- [ ] `npm run verify` كامل (typecheck + lint + test + build) — يعمل؛ يبقى تحذيرا `fingerprint.ts` المعروفان
- [ ] فحص أمني قبل النشر
- [ ] اختبار متصفح فعلي لتدفّق الموافقة (فتح اللوحة → حوار → منح)

---

## 5. الأوامر

```bash
cd kingdev
npm run typecheck     # tsc --noEmit — نظيف
npm run lint          # biome check — 0 أخطاء (تحذيرا fingerprint.ts المعروفان فقط)
npm test              # 388 اختبارًا عبر 16 ملفًا
npm run test:coverage # 96.46% — يفرض 90/85/80/90 وينجح
npm run build         # dist/ جاهزة للتحميل من chrome://extensions
npm run e2e           # 30 فحصًا على الحزمة المبنية — ينجح
npm run verify        # كل ما سبق — ينجح
```

---

## 6. التحذيرات المعروفة

1. تحذيران غير مؤثرين: `noExcessiveCognitiveComplexity` في `fingerprint.ts:174` و `:304`.
2. `src/ui/**` مستثناة من عتبات التغطية مؤقتًا؛ منطق الواجهة مُختبر عبر `rpc.ts` ووحدات `security/`، والعرض عبر e2e.
3. طلب الأذونات الاختيارية يتم من اللوحة بزر Enable (إيماءة مستخدم). تدفّق تجربة الاعتماد
   الكامل (فتح اللوحة → حوار → منح) يحتاج اختبار متصفح فعلي في المرحلة 5.
4. `CaptureStore` يُبقي الأخطاء في ذاكرة الـ worker (`session`-like): المزامنة عبر
   إعادة تشغيل الـ worker تتم عند القراءة من اللوحة، والتخزين الدائم للجلسات في `chrome.storage.local` فقط.
5. أسماء الموديلات في `SUGGESTED_MODELS` قائمة اقتراحات تتقادم مع دورة نشر المزودين؛
   حقل model id حر في الإعدادات دائمًا.
6. الأيقونات مولّدة برمجيًا (`npm run icons`) — تُعاد التوليد إذا تغيّر الهوية البصرية؛
   المخرجات حتمية فلا تتغيّر البايتات بين التشغيلات.
