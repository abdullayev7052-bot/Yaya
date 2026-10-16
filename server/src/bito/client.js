// Bito REST API adapter. Everything Bito-specific lives here so the rest of the
// server does not change when the API details are filled in.
//
// TODO(bito-docs): endpoint paths, auth (OAuth 2.0 per docs.bito.uz/guide/oauth)
// and payload fields must be taken from the Bito API reference. Until then every
// call throws, so no fake data ever reaches the database or Bito.

export class BitoNotConfiguredError extends Error {}

// `getConfig` lets the admin change the Bito connection at runtime (settings page)
// without restarting the server.
export function createBitoClient({ baseUrl, token, getConfig } = {}) {
  const config = () => (getConfig ? getConfig() : { baseUrl, token });
  const isConfigured = () => { const c = config(); return !!(c.baseUrl && c.token); };

  async function request(method, path, body) {
    const { baseUrl, token } = config();
    if (!baseUrl || !token) throw new BitoNotConfiguredError('Bito ulanishi sozlanmagan');
    const res = await fetch(new URL(path, baseUrl), {
      method,
      headers: {
        'Content-Type': 'application/json',
        // TODO(bito-docs): confirm header name/format.
        Authorization: `Bearer ${token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(`Bito ${method} ${path}: HTTP ${res.status} ${JSON.stringify(json)}`);
    }
    // Bito wraps payloads in an envelope with the result under `data`.
    return json?.data ?? json;
  }

  const notYet = (what) => {
    throw new BitoNotConfiguredError(`Bito API: ${what} hali docs.bito.uz bo'yicha to'ldirilmagan`);
  };

  return {
    isConfigured,
    request,
    /** @returns {Promise<Array<{bito_id:string,name:string,phone?:string,address?:string,active?:boolean}>>} */
    async listSuppliers() { return notYet('yetkazib beruvchilar ro\'yxati'); },
    /** @returns {Promise<Array<{bito_id:string,name:string,unit?:string,active?:boolean}>>} */
    async listProducts() { return notYet('mahsulotlar ro\'yxati'); },
    /** @returns {Promise<Array<{bito_id:string,name:string}>>} */
    async listWarehouses() { return notYet('omborlar ro\'yxati'); },
    /** @returns {Promise<{bito_id:string}>} */
    async createSupplier(_s /* {name, phone, address} */) { return notYet('yetkazib beruvchi yaratish'); },
    /** @returns {Promise<{bito_id:string}>} */
    async createProduct(_p /* {name, unit} */) { return notYet('mahsulot yaratish'); },
    /** @returns {Promise<{bito_id:string}>} */
    async createWarehouse(_w /* {name} */) { return notYet('ombor yaratish'); },
    /**
     * Create and confirm a purchase (goods receipt into warehouse). One document per pickup.
     * @param {{supplierBitoId:string, warehouseBitoId:string, date:string,
     *          items:Array<{productBitoId:string, quantity:number, price:number}>,
     *          externalId:string}} purchase
     * @returns {Promise<{docId:string}>}
     */
    async createPurchase(_purchase) { return notYet('xarid yaratish'); },
  };
}
