import { getSetting } from '../settings.js';

// Unauthenticated branding, so the login screens can show the company logo.
export default async function publicRoutes(app, { db }) {
  app.get('/brand', async () => {
    const logo = db.prepare("SELECT updated_at FROM files WHERE key = 'logo'").get();
    const version = getSetting(db, 'brand_version') ?? '0';
    return { companyName: getSetting(db, 'company_name') ?? '', version, logoUrl: logo ? `/api/public/logo.png?v=${version}` : null };
  });

  app.get('/logo.png', async (req, reply) => {
    const f = db.prepare("SELECT mime, data FROM files WHERE key = 'logo'").get();
    if (!f) return reply.code(404).send({ error: 'Logo yo\'q' });
    reply.header('Content-Type', f.mime);
    // Versioned URL: safe to cache long; a new upload changes ?v=.
    reply.header('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache');
    return f.data;
  });
}
