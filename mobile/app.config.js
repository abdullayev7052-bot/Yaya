// Server the app talks to. Can be overridden at build time (YAYA_API_URL) or on
// the phone itself (tap the "Yaya" logo 5 times on the login screen).
const DEFAULT_API_URL = 'https://yaya-production-8d61.up.railway.app';

export default ({ config }) => ({
  ...config,
  extra: { ...config.extra, apiUrl: process.env.YAYA_API_URL || DEFAULT_API_URL },
});
