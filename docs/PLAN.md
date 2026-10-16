# Yaya — reja

## Maqsad
Sut yig'uvchi (haydovchi) yo'lda, internet bo'lmasa ham, 3 ta bosishda xaridni kiritadi:
**yetkazib beruvchini bosadi → kg kiritadi → OK**.
Yaya — **to'liq mustaqil** tizim: o'z bazasi, o'z hisob-kitobi, o'z analitikasi.
Hech qanday tashqi dasturga bog'liq emas.

## Arxitektura
```
 [Android ilova]  --(HTTPS, oflayn navbat)-->  [Yaya server: Node.js + SQLite]  <--  [Boshqaruv paneli (brauzer)]
  SQLite (telefonda)                            Railway, volume /data                  + ilovaning brauzer versiyasi (test)
```

| Qism | Texnologiya |
|---|---|
| Server | Node.js + Fastify + SQLite (bitta fayl baza, volume'da) |
| Boshqaruv paneli | Server ichida statik HTML/JS, grafiklar o'zimizniki (SVG) |
| Mobil | React Native (Expo), telefonda SQLite; iOS ham shu koddan |
| Brauzer test | Mobil ilovaning o'zi web'ga yig'iladi (`/app/`), panel ichida telefon ramkasida |
| APK | GitHub Actions, bitta doimiy kalit bilan imzolanadi |

## Rollar
| Rol | Qayerda | Nima qila oladi |
|---|---|---|
| **Admin** | Panel | Hammasi: foydalanuvchilar, rollar, jurnal, test ma'lumotlarini tozalash |
| **Menejer** | Panel | Sut yig'uvchilar, yetkazib beruvchilar, narxlar, mahsulot/omborlar, yozuvni bekor qilish |
| **Kuzatuvchi** | Panel | Faqat ko'rish, hisobotlar, Excel eksport (masalan, buxgalter) |
| **Sut yig'uvchi** | Mobil ilova | Smena, o'ziga biriktirilgan yetkazib beruvchilardan sut qabul qilish. Narx va summani **ko'rmaydi** |

## Hisob-kitob qoidalari
- Narx har bir yetkazib beruvchi + mahsulot uchun alohida; yozuv tushganda narx **o'sha paytdagi** qiymat bilan muhrlanadi — keyin narx o'zgarsa, tarix o'zgarmaydi.
- Summa = `round(miqdor × narx)` har bir yozuv uchun; jami — shu yaxlitlangan summalar yig'indisi. Barcha ekran va Excel bir xil raqam beradi.
- Kun — Toshkent vaqti (UTC+5) bo'yicha.
- Xato yozuv **o'chirilmaydi** — sababi bilan "bekor qilinadi", jamidan chiqadi, tiklash mumkin.
- Test sut yig'uvchi yozuvlari hisobotlarga kirmaydi.

## Himoya
- Parollar bcrypt; panel sessiyasi 12 soat, mobil 180 kun (oflayn ishlash uchun).
- Login'ga ketma-ket 8 xato urinishdan keyin 15 daqiqa blok.
- O'chirilgan foydalanuvchi/xodim darhol tizimdan chiqariladi.
- Oxirgi admin o'zini o'chira olmaydi.
- Har bir muhim amal jurnalga yoziladi (kim, qachon, nima).
- Excel eksportda formula-injection'dan himoya.

## Oflayn kafolatlar (telefon)
- Har bir yozuv OK bosilishi bilan telefonning ichki bazasiga yoziladi; "Keshni tozalash" uni o'chirmaydi.
- Kiritilayotgan raqam ham har bosishda saqlanadi — ilova yopilsa, o'sha joydan davom etadi.
- Internet chiqishi bilan (va har 30 soniyada) avtomatik yuboriladi; takror yuborish ikki marta yozmaydi.

## Bosqichlar
| # | Bosqich | Holat |
|---|---|---|
| 1 | Server, baza, mobil sinxron | ✅ |
| 2 | Boshqaruv paneli: ma'lumotnomalar, narxlar, biriktirish | ✅ |
| 3 | Mobil ilova (oflayn), APK avtomatik yig'ish | ✅ |
| 4 | Railway deploy (volume) | ✅ |
| 5 | Mustaqil tizim: rollar, analitika, grafiklar, Excel, bekor qilish, jurnal | ✅ |
| 6 | Brauzerda ilovani sinash (`/app/`) | ✅ |
| 7 | Telefonda real sinov, xodimlarga tarqatish | ⏳ |
| 8 | Keyingi funksiyalar: to'lovlar va qarz balansi, yetkazib beruvchi kartochkasi, sifat (yog'lilik), SMS/Telegram xabar, iOS | ⏳ |
