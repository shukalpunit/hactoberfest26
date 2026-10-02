const { executeSQL } = require("./_snowflake");

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  try {
    const result = await executeSQL("LIST @CLAUSESHIELD_DB.APP.CONTRACTS");
    const files = [];
    if (result.data) {
      for (const row of result.data) {
        const name = row[0];
        if (name.toLowerCase().endsWith(".pdf")) {
          files.push(name.split("/").pop() || name);
        }
      }
    }
    res.json({ files });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
