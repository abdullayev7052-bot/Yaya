# Yaya — Sut yig'ish ilovasi: to'liq reja

## 1. Maqsad
Sut yig'uvchi (haydovchi) yo'lda, internet bo'lmasa ham, 3 ta bosishda xaridni kiritadi:
**yetkazib beruvchini bosadi → kg kiritadi → OK**.
Server bu yozuvni avtomatik ravishda **Bito**da "Yangi xarid" (kirim) hujjatiga aylantiradi:
yetkazib beruvchi, mahsulot, narx, ombor — hammasi admin panelda oldindan sozlangan.
AI/token ishlatilmaydi — oddiy server + REST API.

## 2. Arxitektura

```
 [Android ilova]  --(HTTPS, navbat)-->  [Yaya server]  --(REST API)-->  [Bito]
  SQLite (oflayn)                        SQLite/Postgres                kokand-test.bito.online
                                          + Bito sync worker
 [Admin panel (brauzer)] -------------->  [Yaya server]
```

| Qism | Texnologiya | Nega |
|---|---|---|
| Server | Node.js + Fastify + SQLite | Bitta fayl baza, oddiy deploy, tez |
| Admin panel | Server ichida statik HTML (alohida build yo'q) | Sodda, bitta joyga joylanadi |
| Mobil | React Native (Expo) + expo-sqlite | Bitta kod, APK GitHub Actions orqali avtomatik yig'iladi |
| APK yig'ish | GitHub Actions (`gradlew assembleRelease`) | Kompyuteringizga Android Studio kerak emas |

## 3. Ma'lumotlar modeli (server)
- `admins` — admin login/parol (bcrypt)
- `employees` — sut yig'uvchilar (ism, telefon, PIN/parol, faol/nofaol, Bitodagi ombor = mashina ombori)
- `suppliers` — Bitodan sinxronlanadi (bito_id, ism, telefon, manzil)
- `products` — Bitodan sinxronlanadi (bito_id, nom, o'lchov birligi)
- `warehouses` — Bitodan sinxronlanadi (har bir mashina = ombor)
- `supplier_products` — qaysi yetkazib beruvchi qaysi mahsulotni qancha narxda beradi
- `employee_suppliers` — qaysi xodimga qaysi yetkazib beruvchilar biriktirilgan
- `shifts` — smena (ochildi/yopildi, xodim)
- `collections` — har bir sut olish: `client_uuid` (qurilmada yaratiladi, takrorlanishdan himoya), xodim, yetkazib beruvchi, mahsulot, miqdor, narx, vaqt, holat (`pending` → `sent` / `error`), Bito hujjat ID

## 4. Bito integratsiyasi (nima qamrab olinadi)
1. **Ulanish**: admin panelda Bito manzili + API kalit/token kiritiladi (login/parol serverda saqlanmaydi, faqat token).
2. **Spravochniklarni olish** (Bito → Yaya): yetkazib beruvchilar, mahsulotlar, omborlar, (kerak bo'lsa) narx turlari. Har N daqiqada + webhook bo'lsa darhol.
3. **Xarid yaratish** (Yaya → Bito): har bir yig'ilgan sut uchun (yoki smena yopilganda bitta jamlangan hujjat — *savol 3*) "xarid" hujjati: yetkazib beruvchi, ombor, mahsulot, miqdor, narx → saqlash → omborga kirim.
4. **Qayta urinish**: Bito javob bermasa, yozuv `pending` qoladi va worker keyinroq qayta yuboradi. Ikki marta yuborilmasligi uchun `client_uuid` ishlatiladi.
5. **Holatni ko'rsatish**: admin panelda har bir yozuvning Bitoga tushgan/tushmaganligi.

> Bito API'ning aniq endpointlari docs.bito.uz dan o'qilgandan keyin `server/src/bito/client.js` ichida to'ldiriladi. Qolgan butun tizim shu modulga bog'liq emas.

## 5. Mobil ilova oqimi
1. **Kirish** — telefon + PIN (bir marta; keyin eslab qoladi, oflayn ham ochiladi).
2. **Smenani ochish** — bitta katta tugma.
3. **Ro'yxat** — faqat shu xodimga biriktirilgan yetkazib beruvchilar; tepada qidiruv; bugun olinganlar ✓ belgisi va kg bilan.
4. **Kiritish** — katta raqamli klaviatura, mahsulot avtomatik (admin sozlagan), narx avtomatik, **OK**.
5. **Smenani yopish** — jami kg, nechta uy, sinxron holati.

### Oflayn kafolatlar
- Har bir yozuv **OK bosilishi bilan darhol** telefonning ichki SQLite bazasiga yoziladi (ilovaning shaxsiy xotirasi). Android "Keshni tozalash" bu ma'lumotni **o'chirmaydi** (faqat "Ma'lumotlarni tozalash"/o'chirib tashlash o'chiradi — bunga qarshi ham himoya: ilova sozlamasida `allowBackup` + PIN bilan himoyalangan "ma'lumotni tozalash" ogohlantiruvchi ko'rsatma).
- Kiritish oynasidagi yozilayotgan raqam ham har bosishda saqlanadi → ilovani "oxirgilar"dan o'chirib yuborsa ham, qayta ochilganda o'sha joyidan davom etadi.
- Internet paydo bo'lishi bilan (va har 30 soniyada) navbatdagi yozuvlar serverga yuboriladi. Server `client_uuid` bo'yicha takrorni rad etadi → hech narsa ikki marta tushmaydi.
- Yozuv qurilmadan faqat server "qabul qildim" deganidan keyin ham **o'chirilmaydi**, faqat "yuborildi" belgisi qo'yiladi (tarix uchun 30 kun saqlanadi).

## 6. Bosqichlar
| # | Bosqich | Holat |
|---|---|---|
| 1 | Reja, repo tuzilmasi | ✅ |
| 2 | Server: baza, admin login, xodimlar, biriktirishlar, mobil sinxron API | 🔄 boshlandi |
| 3 | Bito ulagichi (docs.bito.uz + test akkaunt) | ⏳ hujjatlarga kirish kerak |
| 4 | Admin panel (web) | ⏳ |
| 5 | Mobil ilova (oflayn navbat, UI) | ⏳ |
| 6 | APK avtomatik yig'ish (GitHub Actions) + imzolash | ⏳ |
| 7 | Serverga deploy (VPS) + HTTPS | ⏳ |
| 8 | Test akkauntda sinov → ishlab chiqarishga o'tish | ⏳ |
