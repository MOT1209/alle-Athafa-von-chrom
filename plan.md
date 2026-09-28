# خطة العمل — KingDev / alle-Athafa-von-chrom

هذا المستودع سيجمع **كل الإضافات**، ولكل إضافة مجلد مستقل قائم بذاته.
الإضافة الحالية: `kingdev/`.

> آخر تحديث: بعد نقل المشروع إلى `kingdev/` والتحقق من نجاح الاختبارات (257/257).

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

### غير مبنية ❌

- هيكل الإضافة MV3: `manifest.json`, `src/background/`, `src/browser/devtools/`, `src/ui/main.tsx`
- `scripts/build.mjs` و `scripts/e2e.mjs` (لا يمكن بناؤهما قبل وجود نقاط الدخول)
- Debug Assistant — تنسيق الواجهة ومزودو الذكاء الاصطناعي
- Agent Prompt Engine
- واجهة React للوحة DevTools

> **ملاحظة:** `npm run build` و `npm run e2e` لا يعملان حاليًا. لم نكتب السكربتات
> عمدًا، لأن كتابة `build` على Points دخول غير موجودة ينتج بناءً ناجحًا لا يشحن شيئًا.

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

### المرحلة 1 — هيكل MV3 ⛔ حاسمة
تحتاج قرارات من المالك قبل البدء:
- مجموعة أذونات الـ `manifest.json` النهائية
- هل الموافقة تُطلب لكل ميزة أم دفعة واحدة؟
- مسار التنقّل في اللوحة (تبويبات أم لوحة واحدة؟)

المخرجات:
- [ ] `manifest.json` مستعملًا `requiredManifestPermissions()`
- [ ] `src/background/service-worker.ts` — الإعدادات + السجل + التوجيه
- [ ] `src/browser/devtools/panel.ts` + `devtools.html` — إنشاء اللوحة
- [ ] `src/browser/content/error-capture.ts` — التقاط `error` و`unhandledrejection`
- [ ] `src/ui/main.tsx` + مكوّنات React
- [ ] `scripts/build.mjs` (esbuild، 4 نقاط دخول)
- [ ] `scripts/e2e.mjs` (اختبار تحميل حزمة الحزمة فعليًا)

### المرحلة 2 — ربط الموافقة
- [ ] تخزين `ConsentState` في `chrome.storage`
- [ ] حوار موافقة يعتمد `consentPromptFor()`
- [ ] بوابة `evaluateFeatureAccess()` عند كل مورد بيانات
- [ ] `reconcilePermissions()` في صفحة التشخيص لكشف الأذونات المسحوبة

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
npm run typecheck     # tsc --noEmit
npm run lint          # biome check
npm test              # 257 اختبار
npm run test:coverage # يفرض 90/85/80/90
npm run verify        # كل ما سبق + build (يحتاج المرحلة 1)
```

---

## 6. التحذيرات المعروفة

1. `"types": ["node"]` في `tsconfig.json` يجعل واجهات Node متاحة لكود المتصفح.
   الحل طويل المدى: `tsconfig` منفصل لملفات `scripts/`.
2. تحذيران غير مؤثرين: `noExcessiveCognitiveComplexity` في `fingerprint.ts:174` و `:304`.
3. لم يُنشأ أي commit حتى الآن — التاريخ غير محفوظ.
