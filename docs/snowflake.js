// Snowflake REST API client — runs entirely in the browser via Web Crypto API
// No secrets leave this tab. JWT is signed locally with the user's private key.

const SF = {
  account: null,
  user: null,
  privateKey: null, // CryptoKey object
  publicKeyFingerprint: null,

  async init(account, user, pemKey) {
    this.account = account.toUpperCase();
    this.user = user.toUpperCase();

    const keyData = this._pemToArrayBuffer(pemKey);
    this.privateKey = await crypto.subtle.importKey(
      "pkcs8", keyData,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      true, ["sign"]
    );

    // Compute public key fingerprint (SHA-256 of SPKI export)
    const spki = await crypto.subtle.exportKey("spki", this.privateKey);
    const sha = await crypto.subtle.digest("SHA-256", spki);
    this.publicKeyFingerprint = "SHA256:" + this._arrayBufferToBase64(sha);
  },

  async generateJwt() {
    const qualified = `${this.account}.${this.user}`;
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "RS256", typ: "JWT" };
    const payload = {
      iss: `${qualified}.${this.publicKeyFingerprint}`,
      sub: qualified,
      iat: now,
      exp: now + 3600,
    };

    const enc = new TextEncoder();
    const hB64 = this._b64url(enc.encode(JSON.stringify(header)));
    const pB64 = this._b64url(enc.encode(JSON.stringify(payload)));
    const sigInput = `${hB64}.${pB64}`;

    const sig = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5", this.privateKey, enc.encode(sigInput)
    );
    return `${sigInput}.${this._b64url(new Uint8Array(sig))}`;
  },

  async executeSQL(sql) {
    const jwt = await this.generateJwt();
    const host = this.account.toLowerCase().replace(/_/g, "-");

    const resp = await fetch(
      `https://${host}.snowflakecomputing.com/api/v2/statements`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${jwt}`,
          "X-Snowflake-Authorization-Token-Type": "KEYPAIR_JWT",
          "Accept": "application/json",
        },
        body: JSON.stringify({
          statement: sql,
          timeout: 300,
          database: "CLAUSESHIELD_DB",
          schema: "APP",
          warehouse: "COMPUTE_WH",
          role: "ACCOUNTADMIN",
        }),
      }
    );

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Snowflake ${resp.status}: ${text.slice(0, 300)}`);
    }

    let result = await resp.json();

    // Poll for async results
    if (result.code === "333334" && result.statementHandle) {
      result = await this._poll(jwt, result.statementHandle, host);
    }
    return result;
  },

  async _poll(jwt, handle, host) {
    const url = `https://${host}.snowflakecomputing.com/api/v2/statements/${handle}`;
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const resp = await fetch(url, {
        headers: {
          "Authorization": `Bearer ${jwt}`,
          "X-Snowflake-Authorization-Token-Type": "KEYPAIR_JWT",
          "Accept": "application/json",
        },
      });
      const data = await resp.json();
      if (data.code !== "333334") return data;
    }
    throw new Error("Query timed out after 120s");
  },

  getValue(result) {
    if (result.data && result.data.length > 0) return result.data[0][0];
    throw new Error("No data in result");
  },

  escapeSql(text) {
    return text.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  },

  parseLlmJson(text) {
    let c = text.trim();
    if (c.startsWith("```json")) c = c.slice(7);
    else if (c.startsWith("```")) c = c.slice(3);
    if (c.endsWith("```")) c = c.slice(0, -3);
    return JSON.parse(c.trim());
  },

  _pemToArrayBuffer(pem) {
    const lines = pem.split("\n").filter(l => !l.startsWith("-----") && l.trim());
    const b64 = lines.join("");
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  },

  _b64url(data) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },

  _arrayBufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  },
};
