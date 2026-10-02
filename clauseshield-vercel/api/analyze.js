const { executeSQL, getValue, escapeSql, parseLlmJson, extractLlmText } = require("./_snowflake");

const MODEL = "llama3.1-70b";

const RISK_PROMPT = `You are a contract risk analyst. Analyze the following contract text and return a JSON object with exactly 5 risk categories. Return ONLY valid JSON, no markdown fences, no prose, no explanation.

The JSON schema:
{
  "risks": [
    {
      "category": "Indemnification",
      "severity": "high" | "medium" | "low",
      "reason": "One sentence explaining the risk",
      "verbatim_clause": "The exact sentence from the contract that is problematic"
    },
    { "category": "Liability" },
    { "category": "Termination" },
    { "category": "IP Ownership" },
    { "category": "Auto-Renewal" }
  ]
}

Rules:
- severity is ONLY "high", "medium", or "low"
- verbatim_clause MUST be a direct quote from the contract, not a paraphrase
- If a category is not mentioned in the contract, set severity to "low" and reason to "Not addressed in contract"
- Return ONLY the JSON object. No markdown. No backticks. No explanation before or after.`;

const META_PROMPT = 'Extract from this contract and return ONLY valid JSON, no markdown fences: {"parties": ["name1", "name2"], "effective_date": "...", "governing_law": "...", "contract_type": "...", "initial_term": "...", "notice_period": "..."}';

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { filename } = req.body || {};
  if (!filename) return res.status(400).json({ error: "filename required" });

  const results = {};

  try {
    // 1. Parse document
    const parseResult = await executeSQL(
      `SELECT SNOWFLAKE.CORTEX.PARSE_DOCUMENT('@CLAUSESHIELD_DB.APP.CONTRACTS', '${escapeSql(filename)}', {'mode': 'LAYOUT'})`
    );
    const parseJson = JSON.parse(getValue(parseResult));
    results.contract_text = parseJson.content || "";

    // 2. Risk analysis
    const msgs = JSON.stringify([
      { role: "system", content: RISK_PROMPT },
      { role: "user", content: results.contract_text },
    ]);
    const riskResult = await executeSQL(
      `SELECT SNOWFLAKE.CORTEX.COMPLETE('${MODEL}', PARSE_JSON($$ ${msgs} $$), {'temperature': 0}) AS response`
    );
    const riskText = extractLlmText(getValue(riskResult));
    const risksData = parseLlmJson(riskText);
    results.risks = risksData.risks;

    // Safety score
    const pts = { high: 30, medium: 15, low: 5 };
    results.safety_score = Math.max(0, 100 - results.risks.reduce((s, r) => s + (pts[r.severity] || 0), 0));

    // 3. Summary
    try {
      const sumResult = await executeSQL(`SELECT SNOWFLAKE.CORTEX.SUMMARIZE('${escapeSql(results.contract_text)}')`);
      results.summary = getValue(sumResult);
    } catch { results.summary = null; }

    // 4. Sentiment per clause
    results.sentiments = [];
    for (const risk of results.risks) {
      try {
        const sentResult = await executeSQL(`SELECT SNOWFLAKE.CORTEX.SENTIMENT('${escapeSql(risk.verbatim_clause)}')`);
        results.sentiments.push(parseFloat(getValue(sentResult)));
      } catch { results.sentiments.push(null); }
    }

    // 5. Metadata
    try {
      const metaMsgs = JSON.stringify([
        { role: "system", content: META_PROMPT },
        { role: "user", content: results.contract_text },
      ]);
      const metaResult = await executeSQL(
        `SELECT SNOWFLAKE.CORTEX.COMPLETE('${MODEL}', PARSE_JSON($$ ${metaMsgs} $$), {'temperature': 0}) AS response`
      );
      results.metadata = parseLlmJson(extractLlmText(getValue(metaResult)));
    } catch { results.metadata = null; }

    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
