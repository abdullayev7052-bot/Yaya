# Yaya — ishga tushirish (qadamma-qadam)

## 1. Railway'ga server joylash (≈10 daqiqa)
1. https://railway.com → **New Project** → **Deploy from GitHub repo** → `abdullayev7052-bot/Yaya`.
2. Service → **Settings → Source → Branch**: `claude/dreamy-euler-syspqn` (keyinchalik `main`).
   Railway `Dockerfile` va `railway.json` ni o'zi topadi.
3. Service → **Settings → Volumes → + Add Volume** → Mount path: **`/data`**.
   ⚠️ Volume'siz har deployda baza o'chib ketadi.
4. Service → **Variables** → qo'shing:
   | Nomi | Qiymati |
   |---|---|
   | `ADMIN_LOGIN` | masalan `admin` |
   | `ADMIN_PASSWORD` | kuchli parol (kamida 12 belgi) |

   `JWT_SECRET` shart emas — server o'zi yaratib, bazada saqlaydi.
5. Service → **Settings → Networking → Generate Domain** → masalan `yaya-production.up.railway.app`.
6. Tekshirish: `https://<domen>/health` → `{"ok":true}`; admin panel: `https://<domen>/admin/`.
7. Kirgandan so'ng **Sozlamalar → Admin parolini o'zgartirish** (ixtiyoriy) va Railway'dagi
   `ADMIN_PASSWORD` ni o'chirib qo'yishingiz mumkin — admin bazada saqlangan.

## 2. GitHub Secrets (APK imzosi) — bir marta
GitHub → repo → **Settings → Secrets and variables → Actions**.

**Secrets** tabida → **New repository secret** (4 marta), qiymatlar `yaya-github-secrets.txt` faylida:
- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

Server manzili ilova kodiga yozilgan (`mobile/app.config.js`). Boshqa serverga o'tilsa,
**Variables** tabida `YAYA_API_URL` = `https://<domen>` qo'shiladi.

Keyin **Actions → Android APK → Run workflow** → branch tanlang → **Run**.
~10 daqiqadan so'ng run sahifasida **Artifacts → yaya-apk-N** paydo bo'ladi.
Imzo to'g'ri bo'lsa, logda "Sign with Yaya release key" qadamida sertifikat chiqadi (ogohlantirish emas).

## 3. Telefonga o'rnatish
1. APK zipni kompyuterga yuklab oling, ochib `yaya.apk` ni Telegram (o'zingizga "Saved Messages")
   yoki USB orqali telefonga o'tkazing.
2. Telefonda faylni bosing → "Noma'lum manbalardan o'rnatish"ga **faqat shu ilova (Telegram/Fayllar)** uchun ruxsat bering.
3. Play Protect ogohlantirsa: **Batafsil → Baribir o'rnatish** (ilova Play Market'da emasligi uchun).
4. O'rnatgach, o'sha ruxsatni qayta o'chirib qo'ying (Sozlamalar → Ilovalar → Telegram → Noma'lum ilovalarni o'rnatish → O'chirish).
5. Yangilash: yangi APK'ni xuddi shunday o'rnating — eski ma'lumotlar saqlanib qoladi (imzo bir xil bo'lgani uchun).
   ⚠️ Ilovani **o'chirmang** va "Ma'lumotlarni tozalash"ni bosmang — yuborilmagan yozuvlar yo'qoladi.

## 4. Birinchi sozlash (boshqaruv paneli)
1. **Mahsulot va omborlar** → mahsulotlar (Yog'li sut, Yog'siz sut) va har bir sut yig'uvchi uchun ombor.
2. **Yetkazib beruvchilar** → qo'shish → **+ Narx** bilan mahsulot va narx (★ asosiy).
3. **Sut yig'uvchilar** → qo'shish (telefon + PIN + ombor) → **Biriktirish** (tartib = yo'nalish).
4. **Foydalanuvchilar** → menejer / kuzatuvchi (buxgalter) qo'shish.
5. **Ilovani sinash** → test xodim bilan noutbukda sinab ko'ring.
6. Xodim telefonida: telefon raqami + PIN bilan kiradi → **Smenani ochish**.
