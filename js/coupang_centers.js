/* 쿠팡 물류센터 표시명 - 2026-09-11
   모든 화면·CSV·출력 문서는 이 파일 하나로만 센터명을 만들어요. 기준은 ERP 센터 마스터
   (Supabase coupang_centers) 하나뿐 - 새 센터는 그 테이블에만 추가하면 전부 반영돼요.

   규칙(사용자 명시)
   - INC4·CHA1 같은 코드만으로 표시하지 않아요. 마스터의 한글 센터명 + "센터" (예: 천안1센터).
   - 코드로 한글명을 추측하지 않아요. 마스터 이름에 한글이 없으면(예: XRC14) 매핑 없음으로 봐요.
   - 매핑이 없으면 "센터명 확인 필요 (코드: XXX)".
   - 코드는 보조정보로만: 화면은 작은 괄호 (CHA1) + 툴팁, CSV는 별도 "센터코드" 열.
   - 마스터를 못 읽으면(권한·네트워크) 전부 "센터명 확인 필요" - 추측 표시보다 안전해요. */
(function (root) {
  "use strict";
  const HANGUL = /[가-힣]/;
  let byId = new Map();
  let byCode = new Map();
  let loaded = false;
  let loadError = null;
  let pending = null;

  const escHtml = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const normCode = c => String(c ?? "").trim().toUpperCase();

  function setRows(rows) {
    byId = new Map();
    byCode = new Map();
    for (const r of rows || []) {
      if (r && r.id != null) byId.set(String(r.id), r);
      const code = normCode(r && r.center_code);
      if (code && !byCode.has(code)) byCode.set(code, r);
    }
    loaded = true;
    loadError = null;
  }

  async function load(sb, { force = false } = {}) {
    if (loaded && !force) return;
    if (pending) return pending;
    pending = (async () => {
      try {
        const { data, error } = await sb.from("coupang_centers").select("id,center_name,center_code");
        if (error) { loadError = error; return; }
        setRows(data || []);
      } catch (e) {
        loadError = e;
      } finally {
        pending = null;
      }
    })();
    return pending;
  }

  // ref: 코드 문자열 | { id, code } (id 우선 - destination_center_id 가 가장 정확해요)
  function resolve(ref) {
    const o = typeof ref === "string" ? { code: ref } : (ref || {});
    const row = (o.id != null && byId.get(String(o.id))) || (o.code && byCode.get(normCode(o.code))) || null;
    const code = normCode((row && row.center_code) || o.code) || null;
    const master = String((row && row.center_name) || "").trim();
    const known = !!master && HANGUL.test(master);
    const name = known ? (master.endsWith("센터") ? master : `${master}센터`) : null;
    if (!code && !name) return { known: false, name: null, code: null, text: "-", empty: true };
    return { known, name, code, text: known ? name : `센터명 확인 필요 (코드: ${code || "없음"})`, empty: false };
  }

  const text = ref => resolve(ref).text;
  const code = ref => resolve(ref).code || "";

  function html(ref) {
    const r = resolve(ref);
    if (r.empty) return "-";
    if (!r.known) {
      return `<span class="center-name unknown" title="센터 마스터(coupang_centers)에 한글 센터명이 없어요">${escHtml(r.text)}</span>`;
    }
    return `<span class="center-name" title="센터 코드 ${escHtml(r.code || "-")}">${escHtml(r.name)}`
      + (r.code ? ` <small class="center-code">(${escHtml(r.code)})</small>` : "") + `</span>`;
  }

  // <option> 처럼 태그를 못 쓰는 곳: "천안1센터 (CHA1)"
  function optionText(ref) {
    const r = resolve(ref);
    return r.known && r.code ? `${r.name} (${r.code})` : r.text;
  }

  root.CoupangCenters = {
    load, resolve, text, code, html, optionText, setRows,
    get loaded() { return loaded; },
    get loadError() { return loadError; },
  };
})(typeof window !== "undefined" ? window : globalThis);
