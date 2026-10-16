# Keyingi yangilanishlar — tayyorgarlik

Quyidagilar hali **boshlanmagan**, lekin tizim ularga tayyorlab qo'yilgan.

## 1. Telegram'ga kunlik hisobot
**Nima bo'ladi:** har kuni belgilangan soatda (masalan 20:00) rahbar(lar)ning Telegram'iga xabar:
bugungi kg, summa, o'rtacha tannarx (yakuniy/dastlabki), har bir sut yig'uvchi bo'yicha kg,
tasdiqlanmagan smenalar, jami qarz. AI ishlatilmaydi — server oddiy matn yuboradi.

**Tayyor:** hisobot uchun barcha raqamlar serverda bor (`/api/admin/dashboard`, `reports.dailyCost`).
Sozlamalar `settings` jadvalida saqlanadi — yangi kalitlar: `telegram_bot_token`, `telegram_chat_ids`, `telegram_hour`.

**Sizdan kerak bo'ladi (5 daqiqa):**
1. Telegram'da **@BotFather** → `/newbot` → nom bering → **token** oling.
2. Botni hisobot keladigan guruhga qo'shing (yoki botga o'zingiz `/start` yozing).
3. Token'ni panelning "Sozlamalar" bo'limiga kiritasiz (bu bo'lim keyingi yangilanishda qo'shiladi).

**Texnik reja:** server ichida jadval (har daqiqa tekshiradi, Toshkent vaqti), `api.telegram.org`'ga HTTPS so'rov;
Railway tarmog'i bunga ruxsat beradi. Panelda "Sinov xabarini yuborish" tugmasi. Jurnalga yoziladi.

## 2. Yetkazib beruvchi manzili va geolokatsiya
**Nima bo'ladi:**
- Sut yig'uvchi uy oldida "📍 Joylashuvni saqlash" ni bosadi — telefon GPS koordinatasi yetkazib beruvchiga yoziladi.
- Ilovada har bir yetkazib beruvchi yonida "Yo'l ko'rsatish" — Google/Yandex xaritada ochiladi.
- Panelda xarita: barcha yetkazib beruvchilar nuqtalari (OpenStreetMap, bepul), qarz/kg bo'yicha rang.
- Excel importga "Kenglik/Uzunlik" ustunlari.

**Tayyor:** bazada `suppliers.lat` va `suppliers.lng` ustunlari allaqachon bor (3-versiya migratsiyasi).

**Texnik reja:** `expo-location` (faqat tugma bosilganda, fon kuzatuvi yo'q — batareya va maxfiylik uchun),
yangi ruxsat `app.set_location`; panel xaritasi — Leaflet (CDN), kalit kerak emas.

## 3. iOS versiya
**Tayyor:** ilova React Native (Expo) — **kodning o'zi iOS'da ham ishlaydi**. `app.json`'da
`ios.bundleIdentifier = uz.yaya.collector` belgilangan. Telefon bazasi (SQLite), oflayn navbat va
dialoglar iOS'ga mos yozilgan.

**Sizdan kerak bo'ladi:**
1. **Apple Developer** hisobi (yiliga 99$) — ilovani iPhone'larga tarqatish uchun majburiy.
2. Mac kompyuter **shart emas**: iOS yig'ish Expo EAS bulut xizmatida bajariladi (bepul tarif yetadi).
3. Tarqatish: **TestFlight** (90 kungacha sinov, 10 000 tagacha foydalanuvchi) yoki App Store.

**Texnik reja:** `eas.json` qo'shish, GitHub Actions'da `eas build -p ios` va `eas submit`,
ikonka — Android'dagi kabi yuklangan logodan.
