// Catalogue of everything a role can be allowed to do. Roles are just named sets
// of these keys; the admin builds them in the panel and assigns them to panel
// users (managers, storekeepers, accountants) and to milk collectors.

export const PERMISSIONS = [
  // --- management (panel and the manager mode of the mobile app)
  { key: 'dashboard.view', group: 'Boshqaruv', label: 'Bugungi ko\'rsatkichlarni ko\'rish' },
  { key: 'reports.view', group: 'Boshqaruv', label: 'Hisobotlar va o\'rtacha tannarx' },
  { key: 'reports.export', group: 'Boshqaruv', label: 'Excel\'ga eksport qilish' },
  { key: 'amounts.view', group: 'Boshqaruv', label: 'Narx va summalarni ko\'rish', hint: 'O\'chirilsa, faqat kg ko\'rinadi' },

  { key: 'collections.view', group: 'Xaridlar', label: 'Xaridlarni ko\'rish' },
  { key: 'collections.edit', group: 'Xaridlar', label: 'Har qanday xaridni tahrirlash (miqdor, mahsulot)' },
  { key: 'collections.void', group: 'Xaridlar', label: 'Har qanday xaridni bekor qilish / tiklash' },

  { key: 'shifts.view', group: 'Smenalar', label: 'Smenalar tarixini ko\'rish' },
  { key: 'shifts.approve', group: 'Smenalar', label: 'Yopilgan smenani tasdiqlash yoki rad etish' },

  { key: 'suppliers.view', group: 'Yetkazib beruvchilar', label: 'Yetkazib beruvchilar va kartochkasini ko\'rish' },
  { key: 'suppliers.manage', group: 'Yetkazib beruvchilar', label: 'Qo\'shish, tahrirlash, Excel\'dan import' },
  { key: 'prices.manage', group: 'Yetkazib beruvchilar', label: 'Narxlarni belgilash' },

  { key: 'payments.view', group: 'To\'lovlar', label: 'Qarzlar va to\'lovlar tarixini ko\'rish' },
  { key: 'payments.create', group: 'To\'lovlar', label: 'To\'lov kiritish' },
  { key: 'payments.void', group: 'To\'lovlar', label: 'To\'lovni bekor qilish' },

  { key: 'employees.manage', group: 'Xodimlar', label: 'Sut yig\'uvchilarni boshqarish va biriktirish' },
  { key: 'catalog.manage', group: 'Xodimlar', label: 'Mahsulot va omborlarni boshqarish' },
  { key: 'tester.use', group: 'Xodimlar', label: 'Ilovani brauzerda sinash' },

  { key: 'users.manage', group: 'Tizim', label: 'Foydalanuvchilar va ruxsatlarni boshqarish' },
  { key: 'settings.manage', group: 'Tizim', label: 'Sozlamalar (logo va boshqalar)' },
  { key: 'audit.view', group: 'Tizim', label: 'Harakatlar jurnalini ko\'rish' },

  // --- milk collector (mobile app, collector mode)
  { key: 'app.collect', group: 'Sut yig\'uvchi ilovasi', label: 'Sut qabul qilish' },
  { key: 'app.edit_own', group: 'Sut yig\'uvchi ilovasi', label: 'O\'z yozuvini tahrirlash (smena tasdiqlanguncha)' },
  { key: 'app.void_own', group: 'Sut yig\'uvchi ilovasi', label: 'O\'z yozuvini bekor qilish (smena tasdiqlanguncha)' },
  { key: 'app.history', group: 'Sut yig\'uvchi ilovasi', label: 'O\'z yopilgan smenalari tarixini ko\'rish' },
  { key: 'app.pay', group: 'Sut yig\'uvchi ilovasi', label: 'Yetkazib beruvchiga naqd to\'lov kiritish' },
];

export const PERMISSION_KEYS = new Set(PERMISSIONS.map((p) => p.key));
const ALL = PERMISSIONS.map((p) => p.key);
const MANAGEMENT = ALL.filter((k) => !k.startsWith('app.'));

// Built-in roles created on first start. "admin" is locked to every permission
// so the owner can never lock themselves out.
export const BUILTIN_ROLES = [
  { code: 'admin', name: 'Admin', locked: 1, perms: ALL },
  { code: 'manager', name: 'Menejer', locked: 0, perms: MANAGEMENT.filter((k) => !['users.manage', 'settings.manage', 'audit.view'].includes(k)) },
  { code: 'storekeeper', name: 'Omborchi', locked: 0,
    perms: ['dashboard.view', 'collections.view', 'collections.edit', 'collections.void', 'shifts.view', 'shifts.approve', 'suppliers.view'] },
  { code: 'viewer', name: 'Kuzatuvchi (buxgalter)', locked: 0,
    perms: ['dashboard.view', 'reports.view', 'reports.export', 'amounts.view', 'collections.view', 'shifts.view', 'suppliers.view', 'payments.view'] },
  { code: 'collector', name: 'Sut yig\'uvchi', locked: 0, perms: ['app.collect', 'app.edit_own', 'app.void_own', 'app.history'] },
];

export function permsOf(db, roleId) {
  const r = db.prepare('SELECT code, permissions FROM roles WHERE id = ?').get(roleId);
  if (!r) return new Set();
  if (r.code === 'admin') return new Set(ALL);
  return new Set(JSON.parse(r.permissions || '[]').filter((k) => PERMISSION_KEYS.has(k)));
}
