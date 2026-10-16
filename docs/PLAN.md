# Yaya — reja

## Maqsad
Sut yig'uvchi (haydovchi) yo'lda, internet bo'lmasa ham, 3 ta bosishda xaridni kiritadi:
**yetkazib beruvchini bosadi → kg kiritadi → OK**.
Yaya — **to'liq mustaqil** tizim: o'z bazasi, o'z hisob-kitobi, o'z analitikasi, o'z ruxsatlar tizimi.

## Arxitektura
```
 [Android ilova]  --(HTTPS, oflayn navbat)-->  [Yaya server: Node.js + SQLite]  <--  [Boshqaruv paneli (brauzer)]
  · Sut yig'uvchi rejimi (oflayn)               Railway, volume /data                  + ilovaning brauzer versiyasi (/app/)
  · Rahbar rejimi (onlayn)
```

| Qism | Texnologiya |
|---|---|
| Server | Node.js + Fastify + SQLite (bitta fayl baza, volume'da) |
| Boshqaruv paneli | Server ichida statik HTML/JS, grafiklar o'zimizniki (SVG) |
| Mobil | React Native (Expo); telefonda SQLite; iOS ham shu koddan |
| Brauzer test | Mobil ilovaning o'zi web'ga yig'iladi (`/app/`) |
| APK | GitHub Actions; doimiy kalit bilan imzolanadi; ikonka = yuklangan logo |

## Ruxsatlar tizimi
Admin **rollar** tuzadi (ruxsatlar to'plami) va ularni odamlarga biriktiradi. Tayyor rollar:

| Rol | Kimga | Asosiy ruxsatlar |
|---|---|---|
| **Admin** | Egasi | Hammasi (o'zgartirib bo'lmaydi — o'zini qulflab qo'ymaslik uchun) |
| **Menejer** | Boshqaruvchi | Ma'lumotlar, narxlar, to'lovlar, hisobotlar |
| **Omborchi** | Qabul qiluvchi | Xaridlarni ko'rish/tuzatish, smenani tasdiqlash yoki rad etish; summalarni ko'rmaydi |
| **Kuzatuvchi** | Buxgalter | Faqat ko'rish, hisobotlar, Excel |
| **Sut yig'uvchi** | Haydovchi | Sut qabul qilish, o'z xatosini tuzatish/bekor qilish (smena tasdiqlanguncha), tarix |

26 ta ruxsat bor (panelda "Foydalanuvchilar va ruxsatlar" bo'limida guruhlab ko'rsatilgan), jumladan:
narx/summalarni ko'rish, to'lov kiritish/bekor qilish, smenani tasdiqlash, Excel import/eksport, logo,
sut yig'uvchining dalada naqd to'lov kiritishi. Ruxsatlar **serverda** tekshiriladi; summalarni ko'rish
ruxsati bo'lmasa, server javobidan narx va summalar olib tashlanadi.

## Hisob-kitob qoidalari
- Narx har bir yetkazib beruvchi + mahsulot uchun alohida; yozuv tushganda narx **muhrlanadi**.
- Summa = `round(miqdor × narx)` har bir yozuv uchun; jami — shu summalar yig'indisi.
- **Qarz** = boshlang'ich qarz + olingan sut summasi − to'lovlar (musbat — biz qarzmiz, manfiy — avans).
- **O'rtacha tannarx** = jami summa ÷ jami miqdor (vaznli o'rtacha). Kunning barcha smenalari yopilib,
  tasdiqlangandan keyin "yakuniy" deb belgilanadi.
- Kun — Toshkent vaqti (UTC+5). Xato yozuv va to'lov **o'chirilmaydi** — sababi bilan bekor qilinadi.
- Test sut yig'uvchining yozuv va to'lovlari hisobotlar va qarzlarga kirmaydi.

## Smena oqimi
`ochiq` → (sut yig'uvchi yopadi) → `tasdiq kutmoqda` → (omborchi/rahbar) → `tasdiqlangan` yoki `rad etilgan` (sababi bilan).
Tasdiqlangan smena yozuvlarini sut yig'uvchi endi o'zgartira olmaydi; rad etilgan smena sababi ilovada ko'rinadi.

## Himoya
- Parollar bcrypt; panel sessiyasi 12 soat, mobil 180 kun (oflayn ishlash uchun).
- Login'ga 8 xato urinishdan keyin 15 daqiqa blok. O'chirilgan foydalanuvchi darhol chiqariladi.
- Har bir muhim amal jurnalga yoziladi. Excel eksportda formula-injection'dan himoya.
- Logo faqat PNG (brauzerda kvadrat 512×512 ga keltiriladi), SVG qabul qilinmaydi.

## Oflayn kafolatlar (telefon)
- Har bir yozuv, tuzatish va to'lov OK bosilishi bilan telefon bazasiga yoziladi; "Keshni tozalash" o'chirmaydi.
- Internet chiqishi bilan (va har 30 soniyada) yuboriladi; takror yuborish ikki marta yozmaydi.
- Server rad etgan yozuv sababi bilan ko'rsatiladi va admin tuzatgach qayta yuboriladi.

## Bosqichlar
| # | Bosqich | Holat |
|---|---|---|
| 1 | Server, baza, mobil sinxron, panel, APK, Railway | ✅ |
| 2 | Mustaqil tizim: analitika, grafiklar, Excel, bekor qilish, jurnal, brauzer test | ✅ |
| 3 | To'lovlar va qarz, yetkazib beruvchi kartochkasi (akt-sverka), o'rtacha tannarx | ✅ |
| 4 | Rollar va ruxsatlar, smenani tasdiqlash, sut yig'uvchining o'z xatosini tuzatishi, dala to'lovi | ✅ |
| 5 | Mobil "Rahbar" rejimi, telefon bo'yicha qidiruv, Excel import, logo | ✅ |
| 6 | Telegram'ga kunlik hisobot | ⏳ tayyorgarlik: [NEXT.md](NEXT.md) |
| 7 | Manzil va geolokatsiya | ⏳ tayyorgarlik: [NEXT.md](NEXT.md) |
| 8 | iOS versiya | ⏳ tayyorgarlik: [NEXT.md](NEXT.md) |
