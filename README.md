# Yaya

Sut yig'uvchilar uchun oflayn ishlaydigan mobil ilova + admin panel + Bito integratsiyasi.
To'liq reja: [docs/PLAN.md](docs/PLAN.md)

## Tuzilma
- `server/` — Node.js API (mobil sinxron, admin, Bito ulagichi)
- `admin/` — admin panel (keyingi bosqich)
- `mobile/` — Android ilova (keyingi bosqich)

## Serverni ishga tushirish
```bash
cd server
npm install
npm run create-admin -- admin MaxfiyParol
JWT_SECRET=uzun-tasodifiy-satr npm start
npm test
```
