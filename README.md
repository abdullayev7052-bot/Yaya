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
npm run create-admin -- admin MaxfiyParol
JWT_SECRET=uzun-tasodifiy-satr npm start
npm test
```

## Railway'ga deploy
1. Railway → New Project → Deploy from GitHub repo → `yaya`.
2. Service → Settings → Volumes → **Add volume**, mount path: `/data` (baza shu yerda saqlanadi).
3. Variables: `JWT_SECRET` (uzun tasodifiy satr), `BITO_BASE_URL`, `BITO_TOKEN`.
4. Settings → Networking → **Generate domain**. Admin panel: `https://<domen>/admin/`.
5. Birinchi admin: Railway service → ⋯ → Shell: `npm run create-admin -- admin <parol>`.
