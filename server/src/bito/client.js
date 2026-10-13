// Bito REST API adapter. Everything Bito-specific lives here so the rest of the
// server does not change when the API details are filled in.
//
// TODO(bito-docs): endpoint paths, auth header and payload fields must be taken
// from https://docs.bito.uz (API section). Until then every call throws, so no
// fake data ever reaches the database.

export class BitoNotConfiguredError extends Error {}

export function createBitoClient({ baseUrl, token } = {}) {
  async function request(method, path, body) {
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
    request,
    /** @returns {Promise<Array<{bito_id:string,name:string,phone?:string,address?:string}>>} */
    async listSuppliers() { return notYet('yetkazib beruvchilar ro\'yxati'); },
    /** @returns {Promise<Array<{bito_id:string,name:string,unit?:string}>>} */
    async listProducts() { return notYet('mahsulotlar ro\'yxati'); },
    /** @returns {Promise<Array<{bito_id:string,name:string}>>} */
    async listWarehouses() { return notYet('omborlar ro\'yxati'); },
    /**
     * Create and save a purchase (goods receipt into warehouse).
     * @param {{supplierBitoId:string, warehouseBitoId:string, date:string,
     *          items:Array<{productBitoId:string, quantity:number, price:number}>,
     *          externalId:string}} purchase
     * @returns {Promise<{docId:string}>}
     */
    async createPurchase(_purchase) { return notYet('xarid yaratish'); },
  };
}
