# Yaya

Sut yig'uvchilar uchun oflayn ishlaydigan mobil ilova + boshqaruv paneli. To'liq mustaqil tizim.
Reja: [docs/PLAN.md](docs/PLAN.md) · Deploy va o'rnatish: [docs/DEPLOY.md](docs/DEPLOY.md)

## Tuzilma
- `server/` — Node.js API (mobil sinxron, panel, hisobotlar), SQLite
- `admin/` — boshqaruv paneli (`/admin/`)
- `mobile/` — Android ilova (Expo / React Native). Brauzer versiyasi `/app/` da (test uchun)
- `.github/workflows/android.yml` — APK avtomatik yig'iladi

## Lokal ishga tushirish
```bash
cd server && npm install
ADMIN_LOGIN=admin ADMIN_PASSWORD=MaxfiyParol123 npm start   # http://localhost:3000/admin/
npm test

# brauzer test-ilovasi uchun (ixtiyoriy):
cd ../mobile && npm install && npx expo export --platform web   # server /app/ da beradi
```
