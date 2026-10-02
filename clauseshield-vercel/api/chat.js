const { executeSQL, getValue, extractLlmText } = require("./_snowflake");

const MODEL = "llama3.1-70b";
const CHAT_SYSTEM = "You are a contract analyst assistant. Answer questions about the following contract. Be specific: cite section numbers and quote relevant clauses. If something is not in the contract, say so.\n\nContract text:\n";

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { question, contract_text, messages } = req.body || {};
  if (!question || !contract_text) return res.status(400).json({ error: "question and contract_text required" });

  try {
    const conversation = [
      { role: "system", content: CHAT_SYSTEM + contract_text },
      ...(messages || []).slice(-6),
      { role: "user", content: question },
    ];
    const msgsJson = JSON.stringify(conversation);
    const result = await executeSQL(
      `SELECT SNOWFLAKE.CORTEX.COMPLETE('${MODEL}', PARSE_JSON($$ ${msgsJson} $$), {'temperature': 0.3}) AS response`
    );
    const responseText = extractLlmText(getValue(result));
    res.json({ response: responseText });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
