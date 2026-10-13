import { BitoNotConfiguredError } from './client.js';

const MAX_ATTEMPTS_BEFORE_ERROR = 10;

// Pushes pending collections to Bito as purchase documents. Safe to run
// repeatedly: a collection leaves 'pending' only after Bito confirms it.
export async function pushPendingCollections(db, bito, { limit = 50, log = console } = {}) {
  const rows = db.prepare(`
    SELECT c.*, s.bito_id AS supplier_bito_id, p.bito_id AS product_bito_id, w.bito_id AS warehouse_bito_id
    FROM collections c
    JOIN suppliers s ON s.id = c.supplier_id
    JOIN products p ON p.id = c.product_id
    LEFT JOIN warehouses w ON w.id = c.warehouse_id
    WHERE c.bito_status = 'pending'
    ORDER BY c.id LIMIT ?`).all(limit);

  const markSent = db.prepare(`UPDATE collections SET bito_status='sent', bito_doc_id=?, bito_error=NULL WHERE id=?`);
  const markFail = db.prepare(`UPDATE collections SET bito_attempts=bito_attempts+1, bito_error=?,
    bito_status=CASE WHEN bito_attempts+1 >= ? THEN 'error' ELSE 'pending' END WHERE id=?`);

  let sent = 0;
  for (const c of rows) {
    try {
      const { docId } = await bito.createPurchase({
        externalId: c.client_uuid,
        supplierBitoId: c.supplier_bito_id,
        warehouseBitoId: c.warehouse_bito_id,
        date: c.collected_at,
        items: [{ productBitoId: c.product_bito_id, quantity: c.quantity, price: c.price }],
      });
      markSent.run(String(docId), c.id);
      sent++;
    } catch (err) {
      if (err instanceof BitoNotConfiguredError) return { sent, skipped: rows.length - sent, reason: err.message };
      log.error?.(`Bito push failed for collection ${c.id}: ${err.message}`);
      markFail.run(err.message.slice(0, 500), MAX_ATTEMPTS_BEFORE_ERROR, c.id);
    }
  }
  return { sent, total: rows.length };
}
