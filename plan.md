# خطة العمل — KingDev / alle-Athafa-von-chrom

هذا المستودع سيجمع **كل الإضافات**، ولكل إضافة مجلد مستقل قائم بذاته.
الإضافة الحالية: `kingdev/`.

> آخر تحديث: اكتملت المرحلة 2 — ربط الموافقة كاملًا (306 اختبارًا، تغطية 96.19%، `npm run verify` + `npm run e2e` ينجحان).
> المرحلة 1 مكتملة أيضًا: أذونات دنيا + اختيارية · موافقة لكل ميزة · تبويبات.

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
| `icons/` | أيقونات PNG مؤقتة (شمعونة) حتى يُصمم الشعار النهائي |

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

### غير مبنية ❌

- جسر HAR (`chrome.devtools.network.getHAR()`) وعرض الشبكة الحقيقي (المرحلة 3)
- Debug Assistant — مزودو الذكاء الاصطناعي واستدعاءات المزود (المرحلة 3)
- Agent Prompt Engine (المرحلة 4)
- اختبارات مكوّنات React بـ jsdom (منطق الواجهة مُختبر عبر وحداتها، والعرض عبر e2e)

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

### المرحلة 3 — Debug Assistant
- [ ] جسر `chrome.devtools.network.getHAR()` ← `CapturedRequest[]`
- [ ] تحويل الأخطاء المجمّعة إلى `Issue` مرئية
- [ ] عرض `discriminatingTest` لكل نتيجة
- [ ] اختيار المزود + إدارة المفاتيح عبر `storage`

### المرحلة 4 — Agent Prompt Engine
- [ ] بناء الـ prompt من الأدلة الحتمية (لا من نص حر)
- [ ] حقن نتيجة `groupErrors` كمُدخلات مُصنَّفة
- [ ] استجابة مُهيكلة `{ hypothesis, cause, test, confidence }`
- [ ] منع النموذج من تجاوز الدليل الحتمي

### المرحلة 5 — بوابة الإصدار
- [ ] `npm run verify` كامل (typecheck + lint + test + build)
- [ ] فحص أمني قبل النشر
- [ ] أول commit للمشروع خارج `README.md`

---

## 5. الأوامر

```bash
cd kingdev
npm run typecheck     # tsc --noEmit — نظيف
npm run lint          # biome check — 0 أخطاء (تحذيرا fingerprint.ts المعروفان فقط)
npm test              # 306 اختبارًا (257 أساسية + 49 من المرحلة 2)
npm run test:coverage # 96.19% — يفرض 90/85/80/90 وينجح
npm run build         # dist/ جاهزة للتحميل من chrome://extensions
npm run e2e           # 30 فحصًا على الحزمة المبنية — ينجح
npm run verify        # كل ما سبق — ينجح
```

---

## 6. التحذيرات المعروفة

1. `"types": ["node"]` في `tsconfig.json` يجعل واجهات Node متاحة لكود المتصفح.
   الحل طويل المدى: `tsconfig` منفصل لملفات `scripts/`.
2. تحذيران غير مؤثرين: `noExcessiveCognitiveComplexity` في `fingerprint.ts:174` و `:304`.
3. لم يُنشأ أي commit حتى الآن — التاريخ غير محفوظ.
4. أيقونات `icons/*.png` شمعونة (1×1 شفاف) — تحتاج شعارًا حقيقيًا قبل النشر.
5. `src/ui/**` مستثناة من عتبات التغطية مؤقتًا؛ منطق الواجهة مُختبر عبر `rpc.ts` ووحدات `security/`، والعرض عبر e2e.
6. طلب الأذونات الاختيارية يتم من اللوحة بزر Enable (إيماءة مستخدم). تدفّق تجربة الاعتماد
   الكامل (فتح اللوحة → حوار → منح) يحتاج اختبار متصفح فعلي في المرحلة 5.
7. `CaptureStore` يُبقي الأخطاء في ذاكرة الـ worker (`session`-like): المزامنة عبر
   إعادة تشغيل الـ worker تتم عند القراءة من اللوحة، والتخزين الدائم للجلسات في `chrome.storage.local` فقط.
