/* bank_statement_upload.js - 자금일보 '통장 파일 올리기' (2026-10-02)
 * 은행 API 가 없어 은행에서 받은 '거래내역조회' 엑셀을 VM(/api/bank-statement/import)에 올려 대사해요.
 *   1) preview: ERP 에 없는 거래 수 · 통장 최종 잔액 · 기준 시각 · 정리될 지급계획 수 (DB 쓰기 없음)
 *   2) 사용자가 확인하면 apply: 같은 파일(SHA-256)만 반영 - 서버가 잔액 연속·기초잔액·동액 거래를 다시 확인
 * 금액 계산 없음 - 서버 응답을 문장으로만 바꿔요.
 */
(function (root) {
  "use strict";
  const fmt = n => Math.round(Number(n) || 0).toLocaleString("ko-KR");
  const asOf = s => String(s || "").replace("T", " ").slice(0, 19);

  /** 확인 문장(미리보기) - 반영할 것이 없으면 null */
  function previewText(b) {
    if (!b || b.status !== "PREVIEW") return null;
    if (!Number(b.new) && !Number(b.paid_plans_to_close)) return null;
    return [`통장 ${asOf(b.bank_as_of)} 기준 잔액 ₩${fmt(b.bank_balance)}`,
            `ERP에 없는 실제 거래 ${fmt(b.new)}건을 추가합니다(이미 있는 ${fmt(b.matched)}건은 그대로).`,
            Number(b.paid_plans_to_close) ? `통장에서 지급이 확인된 '나갈 돈' 예정 ${fmt(b.paid_plans_to_close)}건을 정리합니다.` : "",
            Number(b.plans_to_review) ? `금액이 딱 맞지 않는 지급 예정 ${fmt(b.plans_to_review)}건은 그대로 두니 직접 확인하세요.` : "",
            "반영할까요?"].filter(Boolean).join("\n");
  }

  /** 결과 한 줄 */
  function resultText(b, code) {
    if (code === 401) return "ERP 로그인이 필요합니다";
    if (!b) return `통장 파일 처리 실패(HTTP ${code})`;
    if (b.status === "APPLIED") return `통장 ${asOf(b.bank_as_of)} 기준으로 ${fmt(b.new)}건 반영했습니다 · 잔액 ₩${fmt(b.bank_balance)}`;
    if (b.status === "UP_TO_DATE" || (b.status === "PREVIEW" && !previewText(b)))
      return `이미 최신입니다 - 통장 ${asOf(b.bank_as_of)} 기준 · 새 거래 없음`;
    return b.message || `통장 파일 처리 실패(${b.status || code})`;
  }

  async function post(file, mode, sha, { base, token, fetchFn = root.fetch }) {
    const fd = new FormData();
    fd.append("file", file, file.name);
    fd.append("mode", mode);
    if (sha) fd.append("expect_sha256", sha);
    const r = await fetchFn(`${base}/api/bank-statement/import`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: fd, cache: "no-store" });
    let body = null;
    try { body = await r.json(); } catch (_) { body = null; }
    return { code: r.status, body };
  }

  /** 미리보기 → 확인 → 반영. confirmFn(text) 가 false 면 반영하지 않아요. 반환: 화면에 띄울 한 줄 + 반영 여부 */
  async function run(file, { base, token, fetchFn, confirmFn = t => root.confirm(t) }) {
    const pv = await post(file, "preview", null, { base, token, fetchFn });
    if (pv.code !== 200) return { text: resultText(pv.body, pv.code), applied: false };
    const ask = previewText(pv.body);
    if (!ask) return { text: resultText(pv.body, 200), applied: false };
    if (!confirmFn(ask)) return { text: "반영하지 않았습니다", applied: false };
    const ap = await post(file, "apply", pv.body.source_sha256, { base, token, fetchFn });
    return { text: resultText(ap.body, ap.code), applied: ap.code === 200 && ap.body && ap.body.status === "APPLIED" };
  }

  root.BankStatementUpload = { previewText, resultText, run };
})(typeof window !== "undefined" ? window : globalThis);
