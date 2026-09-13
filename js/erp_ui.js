/* erp_ui.js - ERP 공통 화면 부품 (2026-09-13 ERP UI 정리)
 * -------------------------------------------------------------------------
 * 화면 표시·버튼 안전장치만 모았어요. 계산·판정·저장 규칙은 각 화면 모듈과 DB 함수가 그대로 해요.
 *
 *   badge(kind, opts)      상태 배지 - 색 + 아이콘 + 문구(색만으로 상태를 말하지 않아요)
 *   summaryHtml(items)     화면 위쪽 핵심 요약 카드(누르면 필터 - onclick 은 호출부가 줘요)
 *   displayName(code, name) 표준 상품명 미리보기 - window.ERP_STANDARD_NAMES 가 있을 때만(미리보기 전용).
 *                          운영 화면에는 이 값이 없어서 DB 상품명을 그대로 보여줘요(DB 이름은 바꾸지 않음).
 *   run(opts)              쓰기 버튼 공통 흐름: 권한 확인 → (최신 상태 재확인) → 확인창(사유) → 중복 클릭 방지·
 *                          처리 중 표시 → 서버 함수 1번 → 성공·실패 안내 → 성공·실패 모두 서버 상태 다시 읽기.
 *                          같은 key 가 처리 중이면 다시 실행하지 않아요(중복 감사 이력 방지는 DB 함수가 최종 판단).
 *   toggleRow(id)          표 행 펼쳐보기(상세 행)
 */
(function (root) {
  "use strict";

  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // 상태 종류 → 색(클래스)·아이콘·기본 문구. 색은 CSS(.erp-badge--종류)에서만 정해요.
  const KINDS = {
    ok:        { icon: "✓", label: "정상" },
    awaiting:  { icon: "⏳", label: "입고대기" },
    check:     { icon: "⚠", label: "확인 필요" },
    logistics: { icon: "📦", label: "물류정보 입력 필요" },
    reinbound: { icon: "⏸", label: "재입고 승인 필요" },
    excluded:  { icon: "⛔", label: "재입고 제외" },
    hold:      { icon: "⏸", label: "SKU 사용 보류" },
    error:     { icon: "✕", label: "오류" },
    urgent:    { icon: "▲", label: "지금 발주" },
    soon:      { icon: "△", label: "곧 발주" },
    pending:   { icon: "⏳", label: "승인대기" },
    approved:  { icon: "✓", label: "승인됨" },
    rejected:  { icon: "✕", label: "거절됨" },
    muted:     { icon: "·", label: "이력" },
    info:      { icon: "ℹ", label: "" },
  };

  /** 상태 배지. opts = { text, reason, title, small } - text 가 없으면 기본 문구, reason 은 문구 뒤에 붙어요. */
  function badge(kind, opts = {}) {
    const k = KINDS[kind] ? kind : "info";
    const text = opts.text || KINDS[k].label || "";
    const reason = opts.reason ? `<span class="erp-badge-reason">${esc(opts.reason)}</span>` : "";
    const title = opts.title ? ` title="${esc(opts.title)}"` : "";
    return `<span class="erp-badge erp-badge--${k}${opts.small ? " erp-badge--sm" : ""}"${title}>`
      + `<span class="erp-ico" aria-hidden="true">${KINDS[k].icon}</span>${esc(text)}${reason}</span>`;
  }

  /** 재고 판단(서버 decision) → 배지 종류. 판정 자체는 서버 값 그대로(여기서 다시 계산하지 않음). */
  const DECISION_KIND = { ORDER_NOW: "urgent", ORDER_SOON: "soon", AWAITING_INBOUND: "awaiting", OK: "ok",
                          DATA_CHECK: "check", RESTOCK_EXCLUDED: "excluded" };
  function decisionBadge(d, opts = {}) {
    const kind = DECISION_KIND[d.decision] || "info";
    const text = d.decision === "DATA_CHECK" ? "확인 필요" : (KINDS[kind] || {}).label || d.decision;
    const reason = d.decision === "DATA_CHECK" && d.decision_check_label
      ? String(d.decision_check_label).replace(/^⚠️?\s*/, "") : "";
    return badge(kind, { text, reason: opts.noReason ? "" : reason, title: d.decision_reason || "" });
  }

  /** 자동화 상태(서버 automation_*) → 배지. 재고 판단과 따로 보여줘요. */
  function automationBadge(d) {
    if (d.decision === "RESTOCK_EXCLUDED") return badge("muted", { text: "자동화 대상 아님", small: true });
    if (!d.automation_blocked) return badge("ok", { text: "자동화 정상", small: true });
    const label = String(d.automation_label || "자동화 막힘");
    const kind = /물류정보/.test(label) ? "logistics" : /SKU 사용 보류/.test(label) ? "hold" : "check";
    return badge(kind, { text: label, title: d.automation_reason || "", small: true });
  }

  /** 요약 카드 한 줄. items = [{ label, value, kind, sub, active, onclick, title }] */
  function summaryHtml(items, opts = {}) {
    const cards = (items || []).filter(x => x && !x.hidden).map(x => {
      const tag = x.onclick ? "button" : "div";
      const act = x.onclick ? ` type="button" onclick="${x.onclick}" aria-pressed="${x.active ? "true" : "false"}"` : "";
      return `<${tag} class="erp-stat erp-stat--${esc(x.kind || "info")}${x.active ? " on" : ""}"${act}${x.title ? ` title="${esc(x.title)}"` : ""}>
        <span class="erp-stat-label"><span class="erp-ico" aria-hidden="true">${(KINDS[x.kind] || KINDS.info).icon}</span>${esc(x.label)}</span>
        <span class="erp-stat-value">${esc(x.value)}</span>${x.sub ? `<span class="erp-stat-sub">${esc(x.sub)}</span>` : ""}</${tag}>`;
    }).join("");
    return `<div class="erp-summary${opts.compact ? " erp-summary--compact" : ""}" role="group" aria-label="${esc(opts.label || "핵심 요약")}">${cards}</div>`;
  }

  /** 표준 상품명(미리보기). 없으면 원래 이름. */
  function displayName(code, name) {
    const map = root.ERP_STANDARD_NAMES;
    return (map && code && map[code]) || name || code || "";
  }

  /** 상품 칸: 이름 + 옵션 + 코드·SKU(작게) */
  function nameCellHtml({ code, name, option, skus, extra, title }) {
    const shown = displayName(code, name);
    const sub = [option, code ? `ERP ${code}` : "", skus && skus.length ? `SKU ${skus.join(", ")}` : ""].filter(Boolean);
    const t = title || (shown !== name && name ? `DB 상품명: ${name}` : "");
    return `<div class="erp-name"${t ? ` title="${esc(t)}"` : ""}><b>${esc(shown)}</b>${sub.length ? `<small>${sub.map(esc).join(" · ")}</small>` : ""}${extra || ""}</div>`;
  }

  /** 부모·세트 관계 배지 */
  function relationHtml(rel) {
    if (!rel) return "";
    if (rel.role === "child") return `<span class="erp-rel" title="같은 물리재고를 기준 상품과 나눠 써요">🔗 세트 · 기준 ${esc(rel.parentName || rel.parentCode || "상품")}${rel.setQty ? ` ×${esc(rel.setQty)}` : ""}</span>`;
    if (rel.role === "base") return `<span class="erp-rel" title="다른 구성(세트)이 이 재고를 나눠 써요">📦 공유재고 기준상품</span>`;
    return "";
  }

  // ── 행 펼쳐보기 ─────────────────────────────────────────────────────────────
  function toggleRow(id, btn) {
    const doc = root.document;
    const row = doc && doc.getElementById(id);
    if (!row) return;
    const open = row.hidden;
    row.hidden = !open;
    if (btn) { btn.setAttribute("aria-expanded", open ? "true" : "false"); btn.textContent = open ? "접기" : "상세"; }
  }

  // ── 쓰기 버튼 공통 흐름 ──────────────────────────────────────────────────────
  const inflight = new Set();
  let pending = null;   // 확인창 응답 대기 { resolve }

  const notify = msg => (typeof root.toast === "function" ? root.toast(msg) : null);
  const modalRoot = () => root.document && root.document.getElementById("modal-root");

  function setKeyButtons(key, busy) {
    const doc = root.document;
    if (!doc || !doc.querySelectorAll) return;
    doc.querySelectorAll(`[data-erp-key="${key}"]`).forEach(b => {
      if (busy) { b.dataset.erpLabel = b.dataset.erpLabel || b.textContent; b.disabled = true; b.textContent = "처리 중…"; b.setAttribute("aria-busy", "true"); }
      else { b.disabled = false; if (b.dataset.erpLabel) b.textContent = b.dataset.erpLabel; b.removeAttribute("aria-busy"); }
    });
  }

  function rowsHtml(rows) {
    return rows && rows.length ? `<table class="rg-detail erp-confirm-rows"><tbody>${rows.map(([k, v]) =>
      `<tr><th>${esc(k)}</th><td>${v}</td></tr>`).join("")}</tbody></table>` : "";
  }

  /** 확인창. c = { title, rows:[[라벨, html]], notes:[문구], reason:{label, required, placeholder, value, minLength}, actionLabel, danger }
      → Promise<{ ok, reason }> */
  function confirmModal(c) {
    const el = modalRoot();
    if (!el) return Promise.resolve({ ok: false });
    const r = c.reason;
    el.innerHTML = `
      <div class="modal-backdrop" onclick="if(event.target===this)ErpUi._answer(false)">
        <div class="modal erp-confirm" role="dialog" aria-modal="true" aria-labelledby="erp-confirm-title" style="max-width:620px">
          <h3 id="erp-confirm-title">${esc(c.title)}</h3>
          ${rowsHtml(c.rows)}
          ${(c.notes || []).length ? `<ul class="rg-modal-notes">${c.notes.map(n => `<li>${n}</li>`).join("")}</ul>` : ""}
          ${r ? `<label class="rg-reason-label">${esc(r.label || "사유")} ${r.required ? `<span class="req">필수</span>` : `<span class="rg-muted">(선택)</span>`}
              <textarea id="erp-confirm-reason" rows="3" maxlength="${r.maxLength || 500}" placeholder="${esc(r.placeholder || "")}">${esc(r.value || "")}</textarea></label>` : ""}
          <div class="pi-err" id="erp-confirm-err" role="alert"></div>
          <div class="modal-actions">
            <button class="btn secondary" id="erp-confirm-cancel" onclick="ErpUi._answer(false)">취소</button>
            <button class="btn ${c.danger ? "danger" : ""}" id="erp-confirm-go" onclick="ErpUi._answer(true)">${esc(c.actionLabel || "확인")}</button>
          </div>
        </div>
      </div>`;
    return new Promise(resolve => { pending = { resolve, reason: r }; });
  }

  function _answer(ok) {
    if (!pending) { if (!ok && typeof root.closeModal === "function") root.closeModal(); return; }
    const doc = root.document;
    if (ok && pending.reason) {
      const v = String((doc.getElementById("erp-confirm-reason") || {}).value || "").trim();
      const min = pending.reason.minLength || (pending.reason.required ? 1 : 0);
      if (pending.reason.required && v.length < min) {
        const e = doc.getElementById("erp-confirm-err");
        if (e) e.textContent = `${pending.reason.label || "사유"}를 입력해 주세요${min > 1 ? `(${min}자 이상)` : ""}`;
        return;
      }
    }
    const p = pending;
    pending = null;
    const reason = p.reason ? String((doc.getElementById("erp-confirm-reason") || {}).value || "").trim() : null;
    if (!ok && typeof root.closeModal === "function") root.closeModal();
    p.resolve({ ok, reason });
  }

  /** 결과·오류만 보여주는 창(닫기만 있음) */
  function infoModal(title, bodyHtml) {
    const el = modalRoot();
    if (!el) return;
    el.innerHTML = `<div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal erp-confirm" role="dialog" aria-modal="true" style="max-width:620px"><h3>${esc(title)}</h3>${bodyHtml}
        <div class="modal-actions"><button class="btn" onclick="closeModal()">닫기</button></div></div></div>`;
  }

  /**
   * opts = {
   *   key, allowed, deniedText,
   *   precheck: async () => ({ ok, title, rows, message }) - 확인창 직전 최신 상태 재확인(달라졌으면 멈춤)
   *   confirm: {...} 또는 (precheckResult) => ({...}),
   *   exec: async (reason) => ({ ok, message, data }),
   *   successText: 문자열 또는 (res) => 문자열,
   *   refresh: async () => {}  - 성공·실패 모두 서버에서 다시 읽기
   * }
   * 반환: { status: "BUSY"|"DENIED"|"STALE"|"CANCELLED"|"FAILED"|"DONE", message }
   */
  async function run(opts) {
    const key = opts.key || "erp-action";
    if (inflight.has(key)) return { status: "BUSY" };
    if (opts.allowed === false) {
      notify(opts.deniedText || "권한이 없어요 - 이 화면은 읽기 전용이에요");
      return { status: "DENIED" };
    }
    inflight.add(key);
    setKeyButtons(key, true);
    try {
      let pre = null;
      if (opts.precheck) {
        try { pre = await opts.precheck(); } catch (e) { pre = { ok: false, message: `최신 상태를 확인하지 못했어요: ${e && e.message || e}` }; }
        if (!pre || !pre.ok) {
          infoModal(pre && pre.title || "처리하지 않았어요 - 상태가 바뀌었어요",
            `${rowsHtml(pre && pre.rows)}<p class="rg-muted">${esc(pre && pre.message || "화면을 새로 읽었어요. 바뀐 내용을 확인한 뒤 다시 눌러 주세요.")}</p>`);
          if (opts.refresh) await opts.refresh();
          return { status: "STALE", message: pre && pre.message };
        }
      }
      const conf = typeof opts.confirm === "function" ? opts.confirm(pre) : opts.confirm;
      let reason = null;
      if (conf) {
        const ans = await confirmModal(conf);
        if (!ans.ok) return { status: "CANCELLED" };
        reason = ans.reason;
        const go = root.document.getElementById("erp-confirm-go");
        const cancel = root.document.getElementById("erp-confirm-cancel");
        if (go) { go.disabled = true; go.textContent = "처리 중…"; go.setAttribute("aria-busy", "true"); }
        if (cancel) cancel.disabled = true;
      }
      let res;
      try { res = await opts.exec(reason); } catch (e) { res = { ok: false, message: String(e && e.message || e) }; }
      if (!res || !res.ok) {
        const msg = (res && res.message) || "처리하지 못했어요";
        const errEl = root.document.getElementById("erp-confirm-err");
        if (errEl) {
          errEl.textContent = `${msg} - 서버 상태를 다시 읽었어요`;
          const go = root.document.getElementById("erp-confirm-go");
          const cancel = root.document.getElementById("erp-confirm-cancel");
          if (go) go.remove();
          if (cancel) { cancel.disabled = false; cancel.textContent = "닫기"; }
        } else {
          notify(`처리하지 못했어요: ${msg}`);
        }
        if (opts.refresh) await opts.refresh();
        return { status: "FAILED", message: msg };
      }
      if (conf && typeof root.closeModal === "function") root.closeModal();
      notify(typeof opts.successText === "function" ? opts.successText(res) : (opts.successText || "처리했어요"));
      if (opts.refresh) await opts.refresh();
      return { status: "DONE", data: res.data };
    } finally {
      inflight.delete(key);
      setKeyButtons(key, false);
    }
  }

  const isBusy = key => inflight.has(key);

  root.ErpUi = {
    KINDS, DECISION_KIND, esc, badge, decisionBadge, automationBadge, summaryHtml, displayName, nameCellHtml,
    relationHtml, toggleRow, run, confirmModal, infoModal, isBusy, _answer,
  };
})(typeof window !== "undefined" ? window : globalThis);
