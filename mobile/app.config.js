// Server URL is baked in at build time: YAYA_API_URL=https://... npx expo prebuild
// It can also be changed on the phone (tap the "Yaya" logo 5 times on the login screen).
export default ({ config }) => ({
  ...config,
  extra: { ...config.extra, apiUrl: process.env.YAYA_API_URL ?? '' },
});
