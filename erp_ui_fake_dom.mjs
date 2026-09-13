// erp_ui_fake_dom.mjs - 화면 테스트(fixtures_*.mjs)용 가짜 DOM + 확인창 자동 응답 (2026-09-13 ERP UI 정리)
// ErpUi.run 의 확인창(#modal-root)을 사람 대신 눌러 줘요. 실제 네트워크·DB 는 없어요.
//   const dom = fakeErpDom();  ctx = vm.createContext({ ...dom.globals, ... });  vm.runInContext(erpUiSrc, ctx); dom.bind(ctx);
//   dom.user = { answer: "confirm" | "cancel", reason: "사유" };   // 다음 확인창에서 할 행동
//   dom.modals  - 열린 확인창 HTML 기록,  dom.toasts - 안내 문구 기록
const unesc = s => String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

export function fakeErpDom(preset = {}) {
  const els = new Map();
  const state = { user: { answer: "confirm", reason: undefined }, modals: [], infos: [], toasts: [], ctx: null };
  const mk = id => ({
    id, value: "", textContent: "", disabled: false, hidden: false, dataset: {}, attrs: {}, _html: "",
    setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; },
    remove() { els.delete(id); }, focus() {},
    get innerHTML() { return this._html; },
    set innerHTML(h) { this._html = h; if (id === "modal-root") onModal(h); },
  });
  for (const [id, v] of Object.entries(preset)) els.set(id, Object.assign(mk(id), v));
  els.set("modal-root", mk("modal-root"));

  function onModal(h) {
    for (const m of h.matchAll(/id="([^"]+)"/g)) els.set(m[1], mk(m[1]));
    const ta = h.match(/<textarea id="erp-confirm-reason"[^>]*>([\s\S]*?)<\/textarea>/);
    if (ta) els.get("erp-confirm-reason").value = unesc(ta[1]);
    if (!h.includes('id="erp-confirm-go"')) { if (h.trim()) state.infos.push(h); return; }
    state.modals.push(h);
    const u = state.user;
    setTimeout(() => {
      const ui = state.ctx.ErpUi;
      if (u.reason !== undefined && els.get("erp-confirm-reason")) els.get("erp-confirm-reason").value = u.reason;
      ui._answer(u.answer === "confirm");
      // 필수 사유가 비어 확인창이 그대로면(오류 문구) 사람이 취소를 누른 것으로
      const err = els.get("erp-confirm-err");
      if (u.answer === "confirm" && err && err.textContent) { state.lastError = err.textContent; ui._answer(false); }
    }, 0);
  }

  const document = { getElementById: id => els.get(id) || null, querySelectorAll: () => [] };
  return {
    els, state,
    get modals() { return state.modals; }, get infos() { return state.infos; }, get toasts() { return state.toasts; },
    set user(u) { state.user = { answer: "confirm", reason: undefined, ...u }; },
    globals: { document, toast: m => state.toasts.push(m), closeModal: () => { els.get("modal-root")._html = ""; }, setTimeout },
    bind(ctx) { state.ctx = ctx; },
  };
}
