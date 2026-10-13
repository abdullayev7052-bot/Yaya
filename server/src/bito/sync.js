// Pulls reference data (suppliers, products, warehouses) from Bito into the
// local mirror. Bito is the source of truth: whatever is opened in Bito appears
// in the app, and records that disappear from Bito are deactivated, not deleted,
// so past collections keep their references.

function upsertAll(db, table, rows, columns) {
  const now = new Date().toISOString();
  const cols = ['bito_id', ...columns];
  const hasActive = table !== 'warehouses';
  const insert = db.prepare(`INSERT INTO ${table} (${cols.join(', ')}, synced_at${hasActive ? ', active' : ''})
    VALUES (${cols.map(() => '?').join(', ')}, ?${hasActive ? ', ?' : ''})
    ON CONFLICT(bito_id) DO UPDATE SET ${columns.map((c) => `${c} = excluded.${c}`).join(', ')},
      synced_at = excluded.synced_at${hasActive ? ', active = excluded.active' : ''}`);
  db.transaction(() => {
    for (const r of rows) {
      const vals = cols.map((c) => r[c] ?? null);
      insert.run(...vals, now, ...(hasActive ? [r.active === false ? 0 : 1] : []));
    }
    if (hasActive) {
      // Anything Bito no longer returns was removed there.
      db.prepare(`UPDATE ${table} SET active = 0 WHERE synced_at IS NOT NULL AND synced_at < ?`).run(now);
    }
  })();
  return rows.length;
}

export async function syncReferenceData(db, bito) {
  const [suppliers, products, warehouses] = await Promise.all([
    bito.listSuppliers(), bito.listProducts(), bito.listWarehouses(),
  ]);
  return {
    suppliers: upsertAll(db, 'suppliers', suppliers, ['name', 'phone', 'address']),
    products: upsertAll(db, 'products', products, ['name', 'unit']),
    warehouses: upsertAll(db, 'warehouses', warehouses, ['name']),
  };
}
