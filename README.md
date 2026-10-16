# Yaya

Sut yig'uvchilar uchun oflayn ishlaydigan mobil ilova + admin panel + Bito integratsiyasi.
To'liq reja: [docs/PLAN.md](docs/PLAN.md)

## Tuzilma
- `server/` — Node.js API (mobil sinxron, admin, Bito ulagichi)
- `admin/` — admin panel (server `/admin/` manzilida ochiladi)
- `mobile/` — Android ilova (Expo / React Native; iOS ham shu koddan)
- `.github/workflows/android.yml` — har push'da APK avtomatik yig'iladi (GitHub → Actions → Artifacts)

## Serverni ishga tushirish
```bash
cd server
npm install
ADMIN_LOGIN=admin ADMIN_PASSWORD=MaxfiyParol npm start
npm test
```

## Deploy va o'rnatish
Qadamma-qadam: [docs/DEPLOY.md](docs/DEPLOY.md) (Railway, GitHub Secrets, APK, telefonga o'rnatish, birinchi sozlash).
