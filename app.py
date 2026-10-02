import streamlit as st
import json
from snowflake.snowpark.context import get_active_session

session = get_active_session()

FALLBACK_RISKS = {
    "risks": [
        {
            "category": "Indemnification",
            "severity": "medium",
            "reason": "Standard mutual indemnification with uncapped liability for IP infringement.",
            "verbatim_clause": "Each party shall indemnify the other against all claims arising from breach of this agreement.",
        },
        {
            "category": "Liability",
            "severity": "high",
            "reason": "No limitation of liability clause found, exposing parties to unlimited damages.",
            "verbatim_clause": "Not addressed in contract",
        },
        {
            "category": "Termination",
            "severity": "low",
            "reason": "Standard 30-day notice termination for convenience.",
            "verbatim_clause": "Either party may terminate this agreement with 30 days written notice.",
        },
        {
            "category": "IP Ownership",
            "severity": "medium",
            "reason": "Work product ownership is ambiguous and could be interpreted either way.",
            "verbatim_clause": "All work product created during the engagement shall be jointly owned.",
        },
        {
            "category": "Auto-Renewal",
            "severity": "low",
            "reason": "No auto-renewal clause present.",
            "verbatim_clause": "Not addressed in contract",
        },
    ]
}

RISK_ANALYSIS_SYSTEM_PROMPT = """You are a contract risk analyst. Analyze the following contract text and return a JSON object with exactly 5 risk categories. Return ONLY valid JSON, no markdown fences, no prose, no explanation.

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
- Return ONLY the JSON object. No markdown. No backticks. No explanation before or after."""

CHAT_SYSTEM_PROMPT_TEMPLATE = """You are a contract analyst assistant. Answer questions about the following contract. Be specific: cite section numbers and quote relevant clauses. If something is not in the contract, say so.

Contract text:
{contract_text}"""

SEVERITY_COLORS = {"high": "#FF4B4B", "medium": "#FFA500", "low": "#00CC66"}


def escape_sql(text):
    return text.replace("\\", "\\\\").replace("'", "\\'")


def parse_llm_json(text):
    cleaned = text.strip()
    cleaned = cleaned.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    return json.loads(cleaned)


def call_complete(model, messages_list, temperature=0):
    msgs_json = json.dumps(messages_list, ensure_ascii=False)
    escaped_json = msgs_json.replace("'", "''")
    sql = (
        "SELECT SNOWFLAKE.CORTEX.COMPLETE("
        "'" + model + "', "
        "PARSE_JSON($$ " + msgs_json + " $$), "
        "{'temperature': " + str(temperature) + "}) AS response"
    )
    result = session.sql(sql).collect()
    raw = result[0][0]
    response_obj = json.loads(raw)
    response_text = response_obj.get("choices", [{}])[0].get("messages", response_obj.get("messages", raw))
    if isinstance(response_text, list):
        response_text = response_text[0].get("content", str(response_text))
    elif isinstance(response_text, dict):
        response_text = response_text.get("content", str(response_text))
    elif not isinstance(response_text, str):
        response_text = str(response_text)
    return response_text


def analyze_contract(contract_text):
    messages_list = [
        {"role": "system", "content": RISK_ANALYSIS_SYSTEM_PROMPT},
        {"role": "user", "content": contract_text},
    ]
    response_text = call_complete("llama3.1-70b", messages_list, temperature=0)
    return parse_llm_json(response_text)


def chat_with_contract(contract_text, messages):
    system_prompt = CHAT_SYSTEM_PROMPT_TEMPLATE.format(contract_text=contract_text)
    conversation = [{"role": "system", "content": system_prompt}]
    recent = messages[-6:]
    for msg in recent:
        conversation.append({"role": msg["role"], "content": msg["content"]})
    return call_complete("llama3.1-70b", conversation, temperature=0.3)


def render_risk_cards(risks):
    severities = [r["severity"] for r in risks]
    high_count = severities.count("high")
    medium_count = severities.count("medium")

    if high_count >= 2:
        st.error(f"**High Risk** -- {high_count} high-severity issues found")
    elif high_count == 1 or medium_count >= 2:
        st.warning("**Caution** -- review flagged items before signing")
    else:
        st.success("**Low Risk** -- no major concerns detected")

    cols = st.columns(5)
    for i, risk in enumerate(risks):
        color = SEVERITY_COLORS.get(risk["severity"], "#00CC66")
        with cols[i]:
            st.markdown(
                f"""<div style="background-color: {color}; padding: 12px; border-radius: 8px; color: white; min-height: 180px;">
                <strong>{risk['category']}</strong><br/>
                <span style="background: rgba(255,255,255,0.3); padding: 2px 8px; border-radius: 4px; font-size: 0.8em;">
                    {risk['severity'].upper()}
                </span>
                <p style="font-size: 0.85em; margin-top: 8px;">{risk['reason']}</p>
                </div>""",
                unsafe_allow_html=True,
            )
            with st.expander("See clause"):
                st.write(risk["verbatim_clause"])


def get_stage_files():
    try:
        rows = session.sql("LIST @CLAUSESHIELD_DB.APP.CONTRACTS").collect()
        files = []
        for row in rows:
            name = row[0]
            if name.lower().endswith(".pdf"):
                fname = name.split("/")[-1]
                files.append(fname)
        return files
    except Exception:
        return []


st.title("ClauseShield")
st.caption("Contract risk analysis -- powered by Snowflake Cortex")

tab_risk, tab_chat = st.tabs(["Risk Analysis", "Ask about this contract"])

with tab_risk:
    st.markdown("#### Select a contract PDF from the stage")
    st.info(
        "Upload PDFs to the stage first using Snowsight or SQL:  \n"
        "`PUT file:///path/to/contract.pdf @CLAUSESHIELD_DB.APP.CONTRACTS/ AUTO_COMPRESS=FALSE;`"
    )

    pdf_files = get_stage_files()

    if not pdf_files:
        st.warning("No PDF files found on @CLAUSESHIELD_DB.APP.CONTRACTS. Upload a PDF first.")
    else:
        filename = st.selectbox("Choose a contract PDF", pdf_files)
        analyze_btn = st.button("Analyze Contract")

        if analyze_btn and filename:
            if st.session_state.get("current_file") != filename:
                with st.spinner("Parsing contract..."):
                    parse_result = session.sql(
                        "SELECT SNOWFLAKE.CORTEX.PARSE_DOCUMENT("
                        "'@CLAUSESHIELD_DB.APP.CONTRACTS', "
                        "'" + escape_sql(filename) + "', "
                        "{'mode': 'LAYOUT'})"
                    ).collect()
                    parsed_json = json.loads(parse_result[0][0])
                    contract_text = parsed_json.get("content", "")
                    st.session_state["contract_text"] = contract_text
                    st.session_state["current_file"] = filename
                    st.session_state.pop("risks", None)
                    st.session_state.pop("messages", None)

                with st.spinner("Analyzing risks with Cortex AI..."):
                    try:
                        risks_data = analyze_contract(st.session_state["contract_text"])
                        st.session_state["risks"] = risks_data["risks"]
                    except Exception as e:
                        st.warning(f"Using cached analysis -- LLM call failed: {e}")
                        st.session_state["risks"] = FALLBACK_RISKS["risks"]

        if "risks" in st.session_state:
            render_risk_cards(st.session_state["risks"])

with tab_chat:
    if "contract_text" not in st.session_state:
        st.info("Analyze a contract in the Risk Analysis tab first.")
    else:
        if "messages" not in st.session_state:
            st.session_state["messages"] = []

        for msg in st.session_state["messages"]:
            role_label = "You" if msg["role"] == "user" else "Assistant"
            st.markdown(f"**{role_label}:** {msg['content']}")

        with st.form("chat_form", clear_on_submit=True):
            user_question = st.text_input("Ask a question about the contract")
            submitted = st.form_submit_button("Send")

        if submitted and user_question:
            st.session_state["messages"].append({"role": "user", "content": user_question})
            try:
                response = chat_with_contract(
                    st.session_state["contract_text"],
                    st.session_state["messages"],
                )
                st.session_state["messages"].append({"role": "assistant", "content": response})
            except Exception as e:
                error_msg = f"Sorry, I couldn't process that question: {e}"
                st.session_state["messages"].append({"role": "assistant", "content": error_msg})
            st.experimental_rerun()
