import { existsSync } from 'node:fs';

// Server the app talks to. Can be overridden at build time (YAYA_API_URL) or on
// the phone itself (tap the logo/name 5 times on the login screen).
const DEFAULT_API_URL = 'https://yaya-production-8d61.up.railway.app';

// If the company logo was fetched before the build (see .github/workflows/android.yml),
// it becomes the launcher icon. Otherwise the default Yaya icon is used.
const BRAND_ICON = './assets/brand-icon.png';
const BRAND_FG = './assets/brand-foreground.png';

export default ({ config }) => {
  const branded = existsSync(BRAND_ICON) && existsSync(BRAND_FG);
  return {
    ...config,
    icon: branded ? BRAND_ICON : config.icon,
    android: {
      ...config.android,
      adaptiveIcon: branded
        ? { foregroundImage: BRAND_FG, backgroundColor: '#FFFFFF' }
        : config.android.adaptiveIcon,
    },
    extra: { ...config.extra, apiUrl: process.env.YAYA_API_URL || DEFAULT_API_URL },
  };
};
