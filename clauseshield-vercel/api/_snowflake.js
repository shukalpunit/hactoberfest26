const jwt = require("jsonwebtoken");
const crypto = require("crypto");

function getConfig() {
  return {
    account: process.env.SNOWFLAKE_ACCOUNT,
    user: process.env.SNOWFLAKE_USER,
    privateKey: process.env.SNOWFLAKE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  };
}

function generateJwt(config) {
  const account = config.account.toUpperCase();
  const user = config.user.toUpperCase();

  const pubKey = crypto.createPublicKey(config.privateKey);
  const der = pubKey.export({ type: "spki", format: "der" });
  const sha256 = crypto.createHash("sha256").update(der).digest("base64");
  const fingerprint = "SHA256:" + sha256;

  const qualified = `${account}.${user}`;
  const now = Math.floor(Date.now() / 1000);

  return jwt.sign(
    { iss: `${qualified}.${fingerprint}`, sub: qualified, iat: now },
    config.privateKey,
    { algorithm: "RS256", expiresIn: "1h" }
  );
}

async function executeSQL(sql) {
  const config = getConfig();
  const token = generateJwt(config);
  const host = config.account.toLowerCase().replace(/_/g, "-");

  const resp = await fetch(
    `https://${host}.snowflakecomputing.com/api/v2/statements`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-Snowflake-Authorization-Token-Type": "KEYPAIR_JWT",
        Accept: "application/json",
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

  if (result.code === "333334" && result.statementHandle) {
    result = await poll(token, result.statementHandle, host);
  }
  return result;
}

async function poll(token, handle, host) {
  const url = `https://${host}.snowflakecomputing.com/api/v2/statements/${handle}`;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Snowflake-Authorization-Token-Type": "KEYPAIR_JWT",
        Accept: "application/json",
      },
    });
    const data = await resp.json();
    if (data.code !== "333334") return data;
  }
  throw new Error("Query timed out");
}

function getValue(result) {
  if (result.data && result.data.length > 0) return result.data[0][0];
  throw new Error("No data in result");
}

function escapeSql(text) {
  return text.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function parseLlmJson(text) {
  let c = text.trim();
  if (c.startsWith("```json")) c = c.slice(7);
  else if (c.startsWith("```")) c = c.slice(3);
  if (c.endsWith("```")) c = c.slice(0, -3);
  return JSON.parse(c.trim());
}

function extractLlmText(raw) {
  const parsed = JSON.parse(raw);
  let text = parsed.choices?.[0]?.messages ?? parsed.messages ?? "";
  if (Array.isArray(text)) text = text[0]?.content ?? JSON.stringify(text);
  else if (typeof text === "object") text = text.content ?? JSON.stringify(text);
  return text;
}

module.exports = { executeSQL, getValue, escapeSql, parseLlmJson, extractLlmText };
