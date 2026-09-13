/* 발주·물류 정보 입력 - 2026-09-12 [사용자 확정 정책]
   MISSING_PROCUREMENT_DATA(원가·발주정보 없음)로 재고판단이 '데이터확인'에 머문 상품의 발주·물류 정보를 입력해요.
   - 매입원가는 제품 마스터(products.cost_price)가 원본 - 이 화면은 보여주기만 하고 저장하지 않아요.
   - 저장할 때마다 그 원가가 "VAT 별도 공급가액"인지 "VAT 포함 금액"인지 반드시 골라야 해요(기본 선택 없음).
   - 세트 상품(제습제 24개·아가드 2개/3개 등)은 입력하지 않아요 - 부모 상품 값을 상속하고, 원가·기본수량만
     구성수량만큼 동기화가 계산해요. 실제 발주·중복 방지는 부모 ERP 코드 기준.
   - 참고값(최근 발주 공급처·제품 마스터 박스 입수·현재 계산 기본값)은 회색 제안으로만 보여요. 자동 저장 없음.
   - 저장은 DB fn_save_product_procurement() 하나 - 승인 권한자(profiles.approver)만, 필수값·정수·0 이하를 DB가 다시
     검사하고 감사 이력을 남겨요. 화면 검사는 같은 규칙을 저장 전에 먼저 보여주는 용도예요.
   - 운송비 요율은 이 화면에 없어요(읽지도 쓰지도 않음).
   2026-09-13 [사용자 확정]
   - 부분 저장: 원가 VAT 기준만 있으면 저장돼요. 공급처·발주단위·최소발주·리드타임(BOX 면 BOX 입수, PLT 면 PLT 입수)이
     비어 있으면 "물류정보 입력 필요" - 채울 때까지 BigQuery 반영·정식 추천 발주수량·자동 발주·WING 입고 초안이 막혀요.
   - 재입고 제외·SKU 사용 보류 관리(승인 권한자만 등록·해제, 사유 필수, 이력 보존) - vendor_item_exclusions.
     연결 ERP 상품은 DB 함수가 쿠팡 SKU 연결(product_channel_mapping - 화면 계정은 못 읽음)에서 찾아 기록해요.
   - 버튼: 발주·물류 정보는 [편집]→[저장]/[취소]·[변경 이력], 제외 관리는 [재입고 제외]·[해제]·[제외 사유 보기]·[변경 이력]·[새로고침].
     승인 권한자만 쓰기 · 처리 중엔 다시 누를 수 없음 · 실패하면 서버 상태를 다시 읽어 화면을 맞춤. */
(function (root) {
  "use strict";

  const VAT_LABEL = { VAT_EXCLUDED: "VAT 별도 공급가액", VAT_INCLUDED: "VAT 포함 금액" };
  const UNIT_LABEL = { UNIT: "낱개(UNIT)", BOX: "박스(BOX)", PLT: "팔레트(PLT)" };
  const FIELD_LABEL = {
    supplier_name: "공급처", orderable_unit: "발주단위", min_order_quantity: "최소발주",
    units_per_box: "BOX 입수", units_per_plt: "PLT 입수", lead_time_days: "리드타임", cost_vat_basis: "VAT 기준",
    cost_price_confirmation: "원가 VAT 확인",
  };
  const INT_FIELDS = ["min_order_quantity", "units_per_box", "units_per_plt", "lead_time_days"];
  const EDIT_FIELDS = ["supplier_name", "orderable_unit", ...INT_FIELDS, "cost_vat_basis"];
  const MAX_INT = 1000000;
  const PO_INACTIVE = new Set(["rejected", "canceled"]);
  // 물류정보 필수 칸(백엔드 erp_procurement_sync.logistics_missing_fields · DB fn_save_product_procurement 와 같은 규칙)
  const LOGISTICS_FIELDS = ["supplier_name", "orderable_unit", "min_order_quantity", "lead_time_days"];
  const EXCLUSION_KIND = {
    RESTOCK_EXCLUDED: { label: "재입고 제외", chip: "rejected", badge: "excluded", note: "추천 발주수량 없음 · 자동 발주·WING 입고 초안 대상 아님 · 원가·과거 이력은 그대로" },
    CANDIDATE_EXCLUDED: { label: "SKU 사용 보류", chip: "waiting", badge: "hold", note: "연결은 그대로 두고 발주정보 동기화·발주·WING 입고 SKU 후보에서만 뺌(같은 상품의 정상 SKU 로 진행)" },
  };
  // 2026-09-13 [ERP UI 정리] 동기화 상태 → 공통 배지(색 + 아이콘 + 문구). 값·판정은 서버(procurement_sync_state) 그대로.
  const SYNC_LABEL = {
    SYNCED: ["ok", "BigQuery 반영됨"],
    LOGISTICS_INCOMPLETE: ["logistics", "물류정보 입력 필요 · 동기화 안 함"],
    PENDING_CONFIRMATION: ["check", "VAT 확인 대기"],
    SYNCING: ["awaiting", "반영 중"],
    DATA_CHECK_NEEDED: ["error", "데이터 확인 필요 · 자동 발주 막힘"],
    COST_APPROVAL_REQUIRED: ["check", "원가 변경 승인 필요 · 자동 발주 막힘"],
  };
  const UI = () => root.ErpUi;

  const escHtml = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const won = n => (n === null || n === undefined || n === "") ? "—" : `${Number(n).toLocaleString("ko-KR")}원`;
  const num = n => (n === null || n === undefined || n === "") ? "—" : Number(n).toLocaleString("ko-KR");
  const isSet = p => !!(p && (p.is_set || p.set_parent_id));
  const fmtKst = ts => {
    if (!ts) return "—";
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? String(ts) : d.toLocaleString("sv-SE", { timeZone: "Asia/Seoul", hour12: false }).slice(0, 16);
  };

  // ── 순수 함수(테스트 대상) ────────────────────────────────────────────────
  /** 정수 칸 하나 검사. 빈칸은 value=null. 쉼표·공백은 허용("1,000"), 소수·문자·0 이하는 오류(반올림 안 함). */
  function parseIntField(raw, required) {
    const s = String(raw ?? "").replace(/[,\s]/g, "");
    if (s === "") return required ? { value: null, error: "필수 항목이에요" } : { value: null, error: null };
    if (!/^-?\d+(\.\d+)?$/.test(s)) return { value: null, error: "숫자로 입력해 주세요" };
    const n = Number(s);
    if (!Number.isInteger(n)) return { value: null, error: "소수는 입력할 수 없어요" };
    if (n <= 0) return { value: null, error: "0보다 커야 해요" };
    if (n > MAX_INT) return { value: null, error: "값이 너무 커요" };
    return { value: n, error: null };
  }

  /** 비어 있는 필수 물류 칸(저장된 행이든 입력 중인 값이든). BOX·PLT 면 입수도 필수. */
  function logisticsMissing(v) {
    if (!v) return [...LOGISTICS_FIELDS];
    const empty = x => x === null || x === undefined || String(x).trim() === "";
    const out = LOGISTICS_FIELDS.filter(f => empty(v[f]));
    if (v.orderable_unit === "BOX" && empty(v.units_per_box)) out.push("units_per_box");
    if (v.orderable_unit === "PLT" && empty(v.units_per_plt)) out.push("units_per_plt");
    return out;
  }
  const missingText = m => m.map(f => FIELD_LABEL[f] || f).join("·");

  /** 한 상품의 입력값 검사 → { errors:{칸:문구}, warnings:[], payload, missing, complete } (DB fn_save_product_procurement 와 같은 규칙)
      2026-09-13 부분 저장 - VAT 기준만 필수. 물류 칸은 비워도 되고(missing 으로 알려줌), 넣은 값은 검사해요. */
  function validateRow(form, product) {
    const errors = {};
    const warnings = [];
    const unit = form.orderable_unit || "";
    const supplier = String(form.supplier_name ?? "").trim();
    if (supplier.length > 100) errors.supplier_name = "공급처 이름이 너무 길어요";
    if (unit && !UNIT_LABEL[unit]) errors.orderable_unit = "발주단위를 다시 골라 주세요";
    const required = { min_order_quantity: false, lead_time_days: false, units_per_box: unit === "BOX", units_per_plt: unit === "PLT" };
    const vals = {};
    for (const f of INT_FIELDS) {
      const r = parseIntField(form[f], required[f]);
      if (r.error) errors[f] = r.error;
      vals[f] = r.value;
    }
    if (!VAT_LABEL[form.cost_vat_basis]) errors.cost_vat_basis = "VAT 기준을 골라 주세요";
    if (!product || !(Number(product.cost_price) > 0)) errors.cost_price = "제품 마스터에 매입원가를 먼저 입력해 주세요";
    if (isSet(product)) errors.product = "세트 상품은 부모 상품에 입력해요";
    if (vals.units_per_box && vals.units_per_plt && vals.units_per_plt % vals.units_per_box !== 0)
      warnings.push(`PLT 입수(${vals.units_per_plt})가 BOX 입수(${vals.units_per_box})의 배수가 아니에요`);
    if (unit === "BOX" && vals.units_per_box && vals.min_order_quantity && vals.min_order_quantity % vals.units_per_box !== 0)
      warnings.push(`BOX 발주인데 최소발주(${vals.min_order_quantity})가 BOX 입수의 배수가 아니에요`);
    const payload = {
      supplier_name: supplier || null, orderable_unit: unit || null, min_order_quantity: vals.min_order_quantity,
      units_per_box: vals.units_per_box, units_per_plt: vals.units_per_plt, lead_time_days: vals.lead_time_days,
      cost_vat_basis: form.cost_vat_basis || null,
    };
    const missing = logisticsMissing(payload).filter(f => !errors[f]);
    return { errors, warnings, payload, ok: Object.keys(errors).length === 0, missing, complete: missing.length === 0 };
  }

  /** DB 행 → 입력칸 문자열. VAT 는 "마지막 확인 때 본 원가 = 지금 원가"일 때만 미리 선택(아니면 다시 확인). */
  function formFromRow(pp, product, lastSeenCost) {
    const s = v => (v === null || v === undefined ? "" : String(v));
    const vatStillValid = !!(pp && pp.cost_vat_basis && lastSeenCost !== null && lastSeenCost !== undefined
                             && Number(lastSeenCost) === Number(product && product.cost_price));
    return {
      supplier_name: s(pp && pp.supplier_name), orderable_unit: s(pp && pp.orderable_unit),
      min_order_quantity: s(pp && pp.min_order_quantity), units_per_box: s(pp && pp.units_per_box),
      units_per_plt: s(pp && pp.units_per_plt), lead_time_days: s(pp && pp.lead_time_days),
      cost_vat_basis: vatStillValid ? pp.cost_vat_basis : "",
    };
  }

  const normField = (f, v) => {
    if (INT_FIELDS.includes(f)) { const r = parseIntField(v, false); return r.error ? String(v ?? "").trim() : r.value; }
    return String(v ?? "").trim() || null;
  };

  /** 원래 값 대비 바뀐 칸 [{field,label,before,after}] */
  function diffRow(orig, form) {
    const out = [];
    for (const f of EDIT_FIELDS) {
      const a = normField(f, orig[f]);
      const b = normField(f, form[f]);
      if (a !== b) out.push({ field: f, label: FIELD_LABEL[f], before: a, after: b });
    }
    return out;
  }

  /** 입력 대상 계산 - 활성 MISSING_PROCUREMENT_DATA 상품 중 단품·부모만(세트는 부모로 올림) + 이미 입력된 상품 + 세트 목록 */
  function buildTargets({ products, procurements, recoRows }) {
    const pById = new Map((products || []).map(p => [p.id, p]));
    const ppBy = new Map((procurements || []).map(r => [r.product_id, r]));
    const active = (recoRows || []).filter(r => r.is_active !== false && r.product_id);
    const skusBy = new Map();
    const recoBy = new Map();
    for (const r of active) {
      if (!skusBy.has(r.product_id)) skusBy.set(r.product_id, []);
      if (!skusBy.get(r.product_id).includes(r.vendor_item_id)) skusBy.get(r.product_id).push(r.vendor_item_id);
      if (!recoBy.has(r.product_id)) recoBy.set(r.product_id, r);
    }
    const targetIds = new Set();
    const setChildren = [];
    for (const r of active.filter(x => x.status === "MISSING_PROCUREMENT_DATA")) {
      const p = pById.get(r.product_id);
      if (!p) continue;
      if (isSet(p)) {
        const parent = pById.get(p.set_parent_id);
        if (!setChildren.some(c => c.product.id === p.id))
          setChildren.push({ product: p, parent: parent || null, set_qty: p.set_qty, reco: r });
        if (parent && !isSet(parent) && !ppBy.has(parent.id)) targetIds.add(parent.id);
      } else if (!ppBy.has(p.id)) {
        targetIds.add(p.id);
      }
    }
    const view = p => ({ product: p, reco: recoBy.get(p.id) || null, skus: skusBy.get(p.id) || [], procurement: ppBy.get(p.id) || null });
    const byName = (a, b) => String(a.product.code || "").localeCompare(String(b.product.code || ""));
    const targets = [...targetIds].map(id => view(pById.get(id))).sort(byName);
    const entered = (procurements || []).map(r => pById.get(r.product_id)).filter(p => p && !isSet(p)).map(view).sort(byName);
    setChildren.sort((a, b) => String(a.product.code || "").localeCompare(String(b.product.code || "")));
    // 2026-09-13 저장은 됐지만 물류정보가 빈 상품(원가·VAT 만 먼저 저장, 또는 예전 입력에 최소발주 등이 없음)
    const incomplete = entered.filter(v => logisticsMissing(v.procurement).length > 0);
    return { targets, entered, setChildren, incomplete };
  }

  /** 회색 제안(자동 저장 안 함) - 최근 유효 발주의 공급처, 제품 마스터 박스 입수, 현재 계산 기본 리드타임, 최근 발주 수량 */
  function suggestionsFor(product, poItems, reco) {
    const refs = (poItems || []).filter(it => it.product_id === product.id && it.purchase_orders
                                          && !PO_INACTIVE.has(it.purchase_orders.status))
      .sort((a, b) => String(b.purchase_orders.date || b.purchase_orders.po_no || "").localeCompare(String(a.purchase_orders.date || a.purchase_orders.po_no || "")));
    const last = refs[0];
    const shortPo = no => String(no || "").replace(/^.*-(\d{3})$/, "PO-$1");
    return {
      supplier_name: last && last.purchase_orders.supplier ? { value: last.purchase_orders.supplier, note: shortPo(last.purchase_orders.po_no) } : null,
      units_per_box: product.box_qty ? { value: String(product.box_qty), note: "제품 마스터" } : null,
      lead_time_days: reco && reco.lead_time_days ? { value: null, note: `지금 계산은 기본값 ${reco.lead_time_days}일(참고)` } : null,
      min_order_quantity: last && last.qty ? { value: null, note: `최근 발주 ${Number(last.qty).toLocaleString("ko-KR")}개` } : null,
      last_unit_cost: last ? last.unit_cost : null,
    };
  }

  /** BigQuery·공헌이익에 쓰는 VAT 제외 공급가액 미리보기(정수 연산만 - 동기화의 Decimal 규칙과 같음).
      VAT 별도 → 원가 그대로. VAT 포함 → 원가 ÷ 1.1 = 원가×10÷11 이 나누어떨어질 때만 값, 아니면 exact=false(동기화가 멈춤). */
  function supplyPreview(cost, basis) {
    const c = Number(cost);
    if (!Number.isInteger(c) || c <= 0 || !VAT_LABEL[basis]) return null;
    if (basis === "VAT_EXCLUDED") return { exact: true, value: c };
    return (c * 10) % 11 === 0 ? { exact: true, value: (c * 10) / 11 } : { exact: false, value: null };
  }

  function supplyHtml(cost, basis) {
    const sp = supplyPreview(cost, basis);
    if (!sp) return "";
    return sp.exact
      ? `<div class="pi-sub">BigQuery·공헌이익 공급가액 <b>${won(sp.value)}</b>${basis === "VAT_INCLUDED" ? " (÷1.1)" : ""}</div>`
      : `<div class="pi-warn">${won(cost)} ÷ 1.1 이 나누어떨어지지 않아요 - 반올림하지 않으므로 BigQuery 반영이 '데이터 확인 필요'로 멈춰요. 원가를 확인해 주세요</div>`;
  }

  // ── VAT 확인 대기(2026-09-12 사용자 확정) - 백엔드 inventory_decision.compute_procurement_vat_status 와 같은 규칙 ──
  //  CONFIRMED: 발주정보 있음 + VAT 기준 확인 + 확인 때 본 원가 = 지금 원가
  //  VAT_UNCONFIRMED: 발주정보는 있는데 VAT 기준 미확인(또는 확인 뒤 원가 변경) → 추천은 참고용, 자동 발주안 제외,
  //                   사람이 경고를 확인하고 명시적으로 넣고·올리고·승인하는 것만 허용
  //  NO_PROCUREMENT: 발주정보 없음(MISSING_PROCUREMENT_DATA - 재고판단이 이미 데이터확인으로 막음)
  //  VAT_STATUS_UNKNOWN: 조회 실패 - 확인 못 함은 미확인과 똑같이 다룸
  const VAT_STATUS = { CONFIRMED: "CONFIRMED", UNCONFIRMED: "VAT_UNCONFIRMED", NONE: "NO_PROCUREMENT", UNKNOWN: "VAT_STATUS_UNKNOWN" };
  const vatNeedsAck = st => st === VAT_STATUS.UNCONFIRMED || st === VAT_STATUS.UNKNOWN;

  function computeVatStatus(productIds, products, procurements, audits) {
    const pBy = new Map((products || []).map(p => [p.id, p]));
    const ppBy = new Map((procurements || []).map(r => [r.product_id, r]));
    const lastSeen = new Map();
    [...(audits || [])].sort((a, b) => (b.id || 0) - (a.id || 0)).forEach(a => {
      if ((a.action || "UPDATE") !== "CREATE" && (a.action || "UPDATE") !== "UPDATE") return;
      if (!lastSeen.has(a.product_id)) lastSeen.set(a.product_id, a.cost_price_seen);
    });
    const out = {};
    for (const pid of productIds || []) {
      const p = pBy.get(pid) || {};
      const baseId = p.set_parent_id || pid;
      const base = pBy.get(baseId) || {};
      const pp = ppBy.get(baseId);
      const suffix = baseId !== pid ? ` (세트 - 부모 ${base.code || ""} 기준)` : "";
      const seen = lastSeen.get(baseId);
      if (!pp) out[pid] = { status: VAT_STATUS.NONE, reason: "발주정보 없음" + suffix };
      else if (!pp.cost_vat_basis) out[pid] = { status: VAT_STATUS.UNCONFIRMED, reason: "매입원가 VAT 기준 미확인" + suffix };
      else if (seen == null || base.cost_price == null || String(Number(seen)) !== String(Number(base.cost_price)))
        out[pid] = { status: VAT_STATUS.UNCONFIRMED, reason: `VAT 확인 뒤 원가가 바뀜(${seen ?? "-"} → ${base.cost_price ?? "-"}) - 다시 확인 필요` + suffix };
      else out[pid] = { status: VAT_STATUS.CONFIRMED, reason: "VAT 기준 확인됨" + suffix };
    }
    return out;
  }

  /** ERP 에서 읽어 계산. 하나라도 실패하면 전부 VAT_STATUS_UNKNOWN(자동으로 넣지 않고 경고 확인 필요). */
  async function fetchVatStatus(sb, productIds) {
    const ids = [...new Set((productIds || []).filter(Boolean))];
    if (!ids.length) return {};
    try {
      const q = p => p.then(r => { if (r.error) throw r.error; return r.data || []; });
      let products = await q(sb.from("products").select("id,code,cost_price,set_parent_id").in("id", ids));
      const baseIds = [...new Set([...ids, ...products.map(p => p.set_parent_id || p.id)])];
      const missing = baseIds.filter(id => !products.some(p => p.id === id));
      if (missing.length) products = products.concat(await q(sb.from("products").select("id,code,cost_price,set_parent_id").in("id", missing)));
      const [procurements, audits] = await Promise.all([
        q(sb.from("product_procurement").select("product_id,cost_vat_basis").in("product_id", baseIds)),
        q(sb.from("product_procurement_audit").select("id,product_id,action,cost_price_seen").in("product_id", baseIds).in("action", ["CREATE", "UPDATE"])),
      ]);
      return computeVatStatus(ids, products, procurements, audits);
    } catch (e) {
      return Object.fromEntries(ids.map(id => [id, { status: VAT_STATUS.UNKNOWN, reason: "VAT 확인 상태를 불러오지 못했어요" }]));
    }
  }

  const vatChipHtml = v => v && vatNeedsAck(v.status)
    ? `<span class="chip progress pi-vat-chip" title="${escHtml(v.reason)}">참고용 · VAT 미확인</span>` : "";

  /** DB 오류 문구 → {code, text}. 함수가 'CODE 한국어 설명' 형식으로 올려요. */
  function errorMessage(error) {
    const msg = String((error && (error.message || error.details)) || error || "알 수 없는 오류");
    const m = msg.match(/^([A-Z_]+(?::[a-z_]+)?)\s+(.*)$/);
    if (m) return { code: m[1], text: m[2] };
    if (/permission denied|row-level security/i.test(msg)) return { code: "PERMISSION", text: "권한이 없어요 - 승인 권한자만 저장할 수 있어요" };
    return { code: "ERROR", text: msg };
  }

  /** 세트 상품 미리보기(저장 안 함) - 원가 = 부모 원가 × 구성수량, 나머지는 부모 값 그대로 */
  function setPreview(child, parent, parentPP) {
    const qty = Number(child.set_qty);
    const pc = parent ? Number(parent.cost_price) : NaN;
    const sp = parentPP && parentPP.cost_vat_basis ? supplyPreview(pc, parentPP.cost_vat_basis) : null;
    return {
      cost: Number.isInteger(qty) && qty > 0 && pc > 0 ? pc * qty : null,
      supply: sp && sp.exact && Number.isInteger(qty) && qty > 0 ? sp.value * qty : null,
      supply_exact: sp ? sp.exact : null,
      inherited: !!parentPP,
      supplier_name: parentPP ? parentPP.supplier_name : null,
      lead_time_days: parentPP ? parentPP.lead_time_days : null,
    };
  }

  // ── 화면 상태 ─────────────────────────────────────────────────────────────
  const S = { sb: null, me: null, ctx: null, forms: {}, orig: {}, tab: "targets", loadError: null, editing: false, busy: false };
  const canEdit = () => !!(S.me && S.me.approver) && !S.loadError;
  const canInput = () => canEdit() && S.editing;   // [편집]을 눌렀을 때만 입력칸이 열려요

  async function load(sb) {
    const q = (p) => p.then(r => { if (r.error) throw r.error; return r.data || []; });
    const [products, procurements, recoRows, suppliers] = await Promise.all([
      q(sb.from("products").select("id,code,name,cost_price,tax_type,is_set,set_parent_id,set_qty,box_qty,spec")),
      q(sb.from("product_procurement").select("product_id,supplier_name,orderable_unit,min_order_quantity,units_per_box,units_per_plt,lead_time_days,cost_vat_basis,cost_vat_confirmed_at,updated_at")),
      q(sb.from("purchase_recommendations").select("vendor_item_id,product_id,product_name,option_name,status,is_active,lead_time_days")),
      q(sb.from("suppliers").select("name,active").order("name")),
    ]);
    const { targets, entered, setChildren, incomplete } = buildTargets({ products, procurements, recoRows });
    const pids = [...new Set([...targets, ...entered].map(v => v.product.id))];
    let poItems = [], audits = [], syncStates = [], loadError = null;
    try {
      poItems = pids.length ? await q(sb.from("purchase_order_items")
        .select("product_id,qty,unit_cost,purchase_orders(po_no,supplier,status,date)").in("product_id", pids)) : [];
    } catch (e) { poItems = []; }
    try {
      audits = await q(sb.from("product_procurement_audit")
        .select("id,product_id,action,changed_fields,before,after,cost_price_seen,cost_vat_basis,actor_name,created_at")
        .order("id", { ascending: false }).limit(1000));
      syncStates = await q(sb.from("procurement_sync_state").select("*"));
    } catch (e) {
      loadError = "발주정보 저장 기능의 DB 준비(감사 이력·동기화 상태 테이블)가 아직 안 됐어요 - 보기만 가능해요.";
    }
    let exclusions = [], exclusionEvents = [], exclusionError = null;
    try {
      [exclusions, exclusionEvents] = await Promise.all([
        q(sb.from("vendor_item_exclusions").select("*").order("updated_at", { ascending: false })),
        q(sb.from("vendor_item_exclusion_events").select("*").order("id", { ascending: false }).limit(500)),
      ]);
    } catch (e) {
      exclusionError = "재입고 제외·SKU 사용 보류 목록을 불러오지 못했어요(DB 준비 전이거나 조회 실패) - 등록·해제를 잠시 막아요. [새로고침]으로 다시 읽어 보세요.";
    }
    return { products, procurements, recoRows, suppliers, targets, entered, setChildren, incomplete, poItems, audits, syncStates,
             loadError, exclusions, exclusionEvents, exclusionError };
  }

  function lastSeenCost(pid) {
    const a = (S.ctx.audits || []).find(x => x.product_id === pid && (x.action === "CREATE" || x.action === "UPDATE"));
    return a ? a.cost_price_seen : null;
  }

  function resetForms() {
    S.forms = {}; S.orig = {};
    for (const v of [...S.ctx.targets, ...S.ctx.entered]) {
      const f = formFromRow(v.procurement, v.product, lastSeenCost(v.product.id));
      S.orig[v.product.id] = { ...f };
      S.forms[v.product.id] = { ...f };
    }
  }

  async function view(sb, me) {
    S.sb = sb; S.me = me;
    try {
      S.ctx = await load(sb);
    } catch (e) {
      return `<div class="card"><p class="empty">발주·물류 정보를 불러오지 못했어요: ${escHtml(errorMessage(e).text)}</p></div>`;
    }
    S.loadError = S.ctx.loadError;
    S.editing = false; S.busy = false; S.touched = new Set();
    resetForms();
    return render();
  }

  // ── 렌더링 ───────────────────────────────────────────────────────────────
  function syncChip(pid) {
    const st = (S.ctx.syncStates || []).find(s => s.product_id === pid);
    if (!st) return UI().badge("muted", { text: "동기화 전", small: true });
    const [kind, label] = SYNC_LABEL[st.status] || ["muted", st.status];
    let extra = "";
    if (st.status === "COST_APPROVAL_REQUIRED" && st.pending_cost) {
      const pct = st.bq_cost ? Math.round((st.pending_cost - st.bq_cost) / st.bq_cost * 100) : null;
      extra = `<div class="pi-sub">${won(st.bq_cost)} → ${won(st.pending_cost)}${pct !== null ? ` (${pct > 0 ? "+" : ""}${pct}%)` : ""}</div>`
        + (canEdit() ? `<button class="btn sm secondary" data-erp-key="pi-cost-${escHtml(st.product_id)}" onclick="ProcurementInput.approveCost('${st.product_id}')">원가 변경 승인</button>` : "");
    } else if ((st.status === "DATA_CHECK_NEEDED" || st.status === "LOGISTICS_INCOMPLETE") && st.reason) {
      extra = `<div class="pi-sub">${escHtml(st.reason)}</div>`;
    } else if (st.status === "SYNCED" && st.last_synced_at) {
      extra = `<div class="pi-sub">${fmtKst(st.last_synced_at)}</div>`;
    }
    return `${UI().badge(kind, { text: label, small: true })}${extra}`;
  }

  function sugg(pid, field, s) {
    if (!s) return "";
    const fill = s.value !== null && s.value !== undefined && canInput()
      ? ` <button type="button" class="pi-fill" onclick="ProcurementInput.fill('${pid}','${field}')" title="제안값을 입력칸에 넣어요(저장은 따로)">넣기</button>` : "";
    return `<div class="pi-sugg">${s.value !== null && s.value !== undefined ? `제안 ${escHtml(s.value)} (${escHtml(s.note)})` : escHtml(s.note)}${fill}</div>`;
  }

  function inputCell(pid, field, form, errs, s, opts = {}) {
    const dis = canInput() ? "" : "disabled";
    const cls = errs[field] ? "pi-in bad" : "pi-in";
    const input = `<input id="pi-${pid}-${field}" class="${cls}" ${opts.numeric ? 'inputmode="numeric"' : ""} value="${escHtml(form[field])}"
      ${opts.list ? `list="${opts.list}"` : ""} placeholder="${escHtml(opts.placeholder || "")}" style="width:${opts.w || 76}px" ${dis}
      oninput="ProcurementInput.onInput('${pid}','${field}',this.value)" aria-label="${FIELD_LABEL[field]}">`;
    return `<td${opts.sep ? ` class="erp-sep"` : ""}${opts.label ? ` data-label="${escHtml(opts.label)}"` : ""}><span class="pi-inwrap">${input}${opts.suffix ? `<span class="pi-unit">${opts.suffix}</span>` : ""}</span>
      <div class="pi-err" id="pi-err-${pid}-${field}">${escHtml(errs[field] || "")}</div>${sugg(pid, field, s)}</td>`;
  }

  function rowHtml(v, touched) {
    const p = v.product;
    const pid = p.id;
    const form = S.forms[pid];
    const val = validateRow(form, p);
    const errs = touched || v.procurement ? val.errors : {};
    const s = suggestionsFor(p, S.ctx.poItems, v.reco);
    const dis = canInput() ? "" : "disabled";
    const lastSeen = lastSeenCost(pid);
    const costChanged = v.procurement && v.procurement.cost_vat_basis && lastSeen !== null && Number(lastSeen) !== Number(p.cost_price);
    const dirty = diffRow(S.orig[pid], form).length > 0;
    const vatRadio = k => `<label class="pi-vat ${form.cost_vat_basis === k ? "on" : ""}">
        <input type="radio" name="pi-vat-${pid}" value="${k}" ${form.cost_vat_basis === k ? "checked" : ""} ${dis}
          onchange="ProcurementInput.onInput('${pid}','cost_vat_basis','${k}')">${VAT_LABEL[k]}</label>`;
    const name = UI().displayName(p.code, p.name || (v.reco && v.reco.product_name) || p.code);
    const listing = [(v.reco && v.reco.product_name) || "", (v.reco && v.reco.option_name) || ""].filter(Boolean).join(" · ");
    return `<tr id="pi-row-${pid}" class="${dirty ? "pi-dirty" : ""}">
      <td class="pi-name erp-sticky erp-card-head"><b title="${escHtml(listing ? `쿠팡 상품: ${listing}` : name)}">${escHtml(name)}</b>
        <div class="pi-sub">${escHtml((v.reco && v.reco.option_name) || p.spec || "")}</div>
        <div class="pi-sub">SKU ${escHtml(v.skus.join(", ") || "—")}</div>
        <div class="pi-sub">ERP <code class="pi-code">${escHtml(p.code || "—")}</code></div>
        <div class="pi-sync">${syncChip(pid)} <button class="pi-link" onclick="ProcurementInput.history('${pid}')">변경 이력</button></div>
        ${(v.procurement || dirty) && !val.complete ? `<div class="pi-logi" id="pi-logi-${pid}">${logisticsNoteHtml(val.missing)}</div>` : `<div class="pi-logi" id="pi-logi-${pid}"></div>`}
        ${val.warnings.map(w => `<div class="pi-warn">${escHtml(w)}</div>`).join("")}</td>
      <td class="pi-cost-cell erp-sep ${errs.cost_vat_basis ? "bad" : ""}" data-label="원가·VAT 기준">
        <div class="pi-cost"><b>${won(p.cost_price)}</b> <span class="pi-sub">${escHtml(p.tax_type || "")}</span></div>
        ${s.last_unit_cost ? `<div class="pi-sub">최근 발주 단가 ${won(s.last_unit_cost)}</div>` : ""}
        ${errs.cost_price ? `<div class="pi-err">${escHtml(errs.cost_price)}</div>` : ""}
        <div class="pi-vat-q">이 금액은</div>${vatRadio("VAT_EXCLUDED")}${vatRadio("VAT_INCLUDED")}
        <div class="pi-err" id="pi-err-${pid}-cost_vat_basis">${escHtml(errs.cost_vat_basis || "")}</div>
        ${supplyHtml(p.cost_price, form.cost_vat_basis)}
        ${costChanged ? `<div class="pi-warn">확인 뒤 원가가 바뀌었어요(${won(lastSeen)} → ${won(p.cost_price)}) - 다시 골라 주세요</div>` : ""}</td>
      ${inputCell(pid, "supplier_name", form, errs, s.supplier_name, { list: "pi-suppliers", w: 104, placeholder: "공급처", label: "공급처", sep: true })}
      <td data-label="발주단위"><select id="pi-${pid}-orderable_unit" class="pi-in ${errs.orderable_unit ? "bad" : ""}" ${dis}
            onchange="ProcurementInput.onInput('${pid}','orderable_unit',this.value)" aria-label="발주단위">
          <option value="" ${form.orderable_unit ? "" : "selected"}>선택</option>
          ${Object.keys(UNIT_LABEL).map(k => `<option value="${k}" ${form.orderable_unit === k ? "selected" : ""}>${UNIT_LABEL[k]}</option>`).join("")}
        </select><div class="pi-err" id="pi-err-${pid}-orderable_unit">${escHtml(errs.orderable_unit || "")}</div></td>
      ${inputCell(pid, "min_order_quantity", form, errs, s.min_order_quantity, { numeric: true, suffix: "개", w: 62, label: "최소발주" })}
      ${inputCell(pid, "units_per_box", form, errs, s.units_per_box, { numeric: true, suffix: "개", placeholder: form.orderable_unit === "BOX" ? "필수" : "", w: 62, label: "BOX 입수", sep: true })}
      ${inputCell(pid, "units_per_plt", form, errs, s.units_per_plt, { numeric: true, suffix: "개", placeholder: form.orderable_unit === "PLT" ? "필수" : "", w: 62, label: "PLT 입수" })}
      ${inputCell(pid, "lead_time_days", form, errs, s.lead_time_days, { numeric: true, suffix: "일", w: 56, label: "리드타임" })}
    </tr>`;
  }

  const logisticsNoteHtml = missing => `${UI().badge("logistics", { small: true })}
    <div class="pi-sub">${escHtml(missingText(missing))} 없음 - 채울 때까지 BigQuery 반영·추천 발주수량·자동 발주·WING 입고 초안이 막혀요</div>`;

  function tableHtml(list, emptyMsg) {
    if (!list.length) return `<p class="empty">${emptyMsg}</p>`;
    const later = `<div class="pi-sub">나중에 입력 가능</div>`;
    return `<div class="erp-table-wrap"><table class="pi-table erp-table erp-cards">
      <thead><tr class="erp-grp"><th class="erp-sticky"></th><th class="erp-grp-sep">원가·VAT</th><th colspan="3" class="erp-grp-sep">발주정보</th>
          <th colspan="3" class="erp-grp-sep">물류정보</th></tr>
        <tr><th class="erp-sticky">상품명 · SKU · ERP 코드</th><th class="erp-sep">현재 cost_price<div class="pi-sub">VAT 기준 *</div></th><th class="erp-sep">공급처${later}</th><th>발주단위${later}</th>
        <th>최소발주${later}</th><th class="erp-sep">BOX 입수<div class="pi-sub">BOX면 필수</div></th><th>PLT 입수<div class="pi-sub">PLT면 필수</div></th><th>리드타임${later}</th></tr></thead>
      <tbody>${list.map(v => rowHtml(v, S.touched && S.touched.has(v.product.id))).join("")}</tbody></table></div>`;
  }

  function setPanelHtml() {
    const list = S.ctx.setChildren;
    if (!list.length) return "";
    const ppBy = new Map(S.ctx.procurements.map(r => [r.product_id, r]));
    return `<div class="card">
      <div class="card-head"><h2>세트 상품 ${list.length}개 · 따로 입력하지 않아요</h2></div>
      <details class="erp-help"><summary>세트 상품은 왜 따로 입력하지 않나요?</summary>부모 상품의 공급처·발주단위·포장·리드타임을 그대로 따라요. 원가와 필요한 기본수량만 구성수량을 곱해 동기화 때 계산하고,
        발주와 중복 방지는 부모 ERP 코드로 해요. 아래 원가는 미리보기이며 저장하지 않아요.</details>
      <div class="erp-table-wrap"><table class="pi-table erp-table erp-cards">
        <thead><tr><th class="erp-sticky">세트 상품</th><th>ERP 코드</th><th>부모 상품</th><th class="num">구성수량</th><th class="num">세트 cost_price(계산)</th><th>부모 입력 상태</th></tr></thead>
        <tbody>${list.map(c => {
          const pp = c.parent ? ppBy.get(c.parent.id) : null;
          const pv = setPreview(c.product, c.parent, pp);
          const st = !c.parent ? UI().badge("error", { text: "부모 상품 없음", small: true })
            : !pp ? UI().badge("check", { text: "부모 입력 필요", small: true })
            : pp.cost_vat_basis ? UI().badge("ok", { text: "부모 입력됨", small: true }) : UI().badge("check", { text: "부모 VAT 확인 필요", small: true });
          return `<tr><td class="erp-sticky erp-card-head"><b>${escHtml(UI().displayName(c.product.code, c.product.name || (c.reco && c.reco.product_name) || ""))}</b><div class="pi-sub">${escHtml((c.reco && c.reco.option_name) || "")} · SKU ${escHtml(c.reco ? c.reco.vendor_item_id : "—")}</div>
              ${UI().relationHtml({ role: "child", parentName: c.parent ? UI().displayName(c.parent.code, c.parent.name) : "", setQty: c.set_qty })}</td>
            <td data-label="ERP 코드"><code>${escHtml(c.product.code || "—")}</code></td>
            <td data-label="부모 상품">${c.parent ? `<code>${escHtml(c.parent.code)}</code> · ${won(c.parent.cost_price)}` : "—"}</td>
            <td class="num" data-label="구성수량">×${escHtml(c.set_qty ?? "?")}</td>
            <td class="num" data-label="세트 원가(계산)"><div>${pv.cost ? `${won(c.parent.cost_price)} × ${c.set_qty} = <b>${won(pv.cost)}</b>` : "계산 불가"}
              <div class="pi-sub">${pv.supply ? `공급가액 ${won(pv.supply)}` : pv.supply_exact === false ? "공급가액 계산 불가(÷1.1 안 나눠짐)" : "공급가액은 부모 VAT 확인 후"}</div></div></td>
            <td data-label="부모 입력 상태">${st}</td></tr>`;
        }).join("")}</tbody></table></div></div>`;
  }

  function summary() {
    const all = [...S.ctx.targets, ...S.ctx.entered];
    let dirty = 0, bad = 0;
    for (const v of all) {
      const pid = v.product.id;
      if (!diffRow(S.orig[pid], S.forms[pid]).length) continue;
      dirty++;
      if (!validateRow(S.forms[pid], v.product).ok) bad++;
    }
    return { dirty, bad };
  }

  function footerHtml() {
    if (!canEdit()) return `<div class="pi-foot" id="pi-foot"><span class="pi-sub">보기 전용이에요 - 승인 권한자만 편집할 수 있어요</span></div>`;
    if (!S.editing) return `<div class="pi-foot" id="pi-foot"><span class="pi-sub">[편집]을 누르면 입력칸이 열려요. 저장 전에는 아무것도 바뀌지 않아요.</span>
      <button class="btn" onclick="ProcurementInput.edit()">편집</button></div>`;
    const { dirty, bad } = summary();
    const dis = !dirty || bad || S.busy ? "disabled" : "";
    const msg = !dirty ? "바뀐 상품이 없어요" : bad ? `바뀐 ${dirty}개 중 ${bad}개에 고칠 칸이 있어요`
      : `바뀐 상품 ${dirty}개 - [저장]을 누르면 변경 내용을 한 번 더 보여드려요`;
    return `<div class="pi-foot" id="pi-foot"><span class="${bad ? "pi-err" : "pi-sub"}">${msg}</span>
      <button class="btn secondary" onclick="ProcurementInput.cancel()" ${S.busy ? "disabled" : ""}>취소</button>
      <button class="btn" onclick="ProcurementInput.review()" ${dis}>저장</button></div>`;
  }

  function render() {
    const c = S.ctx;
    const tabs = [["targets", `입력 필요 ${c.targets.length}`], ["logistics", `물류정보 입력 필요 ${c.incomplete.length}`],
                  ["entered", `입력됨 ${c.entered.length}`]];
    const list = S.tab === "entered" ? c.entered : S.tab === "logistics" ? c.incomplete : c.targets;
    const banner = S.loadError ? `<div class="pi-banner bad">${escHtml(S.loadError)}</div>`
      : !canEdit() ? `<div class="pi-banner">보기 전용 - 승인 권한자만 수정할 수 있어요.</div>` : "";
    // 2026-09-13 [ERP UI 정리] 위쪽 핵심 요약 - 동기화 상태·세트·제외 건수(탭은 아래 표 필터 그대로)
    const syncCount = st => (c.syncStates || []).filter(x => x.status === st).length;
    const exActive = Array.isArray(c.exclusions) ? c.exclusions.filter(e => e.active) : [];
    const summary = UI().summaryHtml([
      { label: "입력 필요", value: c.targets.length, kind: c.targets.length ? "check" : "ok" },
      { label: "물류정보 입력 필요", value: c.incomplete.length, kind: c.incomplete.length ? "logistics" : "ok", title: "채울 때까지 자동 발주·WING 초안 막힘" },
      { label: "BigQuery 반영됨", value: syncCount("SYNCED"), kind: "ok" },
      { label: "원가 변경 승인 필요", value: syncCount("COST_APPROVAL_REQUIRED"), kind: "check", hidden: !syncCount("COST_APPROVAL_REQUIRED") },
      { label: "VAT 확인 대기", value: syncCount("PENDING_CONFIRMATION"), kind: "check", hidden: !syncCount("PENDING_CONFIRMATION") },
      { label: "데이터 확인 필요", value: syncCount("DATA_CHECK_NEEDED"), kind: "error", hidden: !syncCount("DATA_CHECK_NEEDED") },
      { label: "재입고 제외", value: exActive.filter(e => e.kind === "RESTOCK_EXCLUDED").length, kind: "excluded",
        onclick: "document.getElementById('pi-ex-card')?.scrollIntoView({behavior:'smooth'})", hidden: !Array.isArray(c.exclusions) },
      { label: "SKU 사용 보류", value: exActive.filter(e => e.kind === "CANDIDATE_EXCLUDED").length, kind: "hold",
        onclick: "document.getElementById('pi-ex-card')?.scrollIntoView({behavior:'smooth'})", hidden: !Array.isArray(c.exclusions) },
    ], { label: "발주·물류 정보 요약" });
    return `
      <div class="card">
        <div class="card-head"><h2>발주·물류 정보${S.editing ? ` <span class="chip progress">편집 중</span>` : ""}${!canEdit() ? ` <span class="erp-readonly">🔒 읽기 전용</span>` : ""}</h2>
          <div class="pi-tabs">${tabs.map(([k, l]) => `<button class="pi-tab ${S.tab === k ? "on" : ""}" onclick="ProcurementInput.tab('${k}')">${l}</button>`).join("")}
            ${canEdit() && !S.editing ? `<button class="btn sm" onclick="ProcurementInput.edit()">편집</button>` : ""}</div></div>
        ${summary}
        <details class="erp-help"><summary>화면 설명 · 저장 규칙</summary>
          원가·발주정보가 없어 재고판단이 <b>데이터확인</b>에 머문 상품이에요. 매입원가는 <b>제품 마스터 값</b>을 그대로 쓰고 여기서는 바꾸지 않아요 -
          대신 그 금액이 <b>VAT 별도 공급가액</b>인지 <b>VAT 포함 금액</b>인지 꼭 골라 주세요. 고르기 전에는 저장도, BigQuery 반영도 안 돼요.
          BigQuery·공헌이익에는 VAT 를 뺀 공급가액이 들어가요(VAT 포함이면 ÷1.1, 나누어떨어지지 않으면 반영하지 않고 멈춤).
          공급처·발주단위·최소발주·리드타임은 나중에 채워도 저장돼요 - 다 채울 때까지는 <b>물류정보 입력 필요</b>로 두고
          BigQuery 반영·추천 발주수량·자동 발주·WING 입고 초안을 막아요. 회색 글씨는 참고용 제안이고 저장되지 않아요.</details>
        ${banner}
        ${tableHtml(list, S.tab === "entered" ? "아직 입력된 상품이 없어요." : S.tab === "logistics" ? "물류정보가 빈 상품이 없어요." : "입력이 필요한 상품이 없어요.")}
        <datalist id="pi-suppliers">${(c.suppliers || []).filter(s => s.active !== false).map(s => `<option value="${escHtml(s.name)}">`).join("")}</datalist>
        ${footerHtml()}
      </div>
      ${setPanelHtml()}
      ${exclusionPanelHtml()}`;
  }

  // ── 재입고 제외·SKU 사용 보류(2026-09-13 사용자 확정, 범용) ─────────────────
  const canExclude = () => !!(S.me && S.me.approver) && !S.ctx.exclusionError;
  // 쿠팡 상품명·옵션은 발주추천 표(화면 계정이 읽을 수 있음)에서, ERP 상품은 제외 행의 product_id 로
  const skuInfo = vid => (S.ctx.recoRows || []).find(r => String(r.vendor_item_id) === String(vid)) || null;
  const erpProduct = pid => (pid && (S.ctx.products || []).find(p => p.id === pid)) || null;
  function skuLabelHtml(e) {
    const r = skuInfo(e.vendor_item_id);
    const p = erpProduct(e.product_id);
    return `${r ? `<div>${escHtml(r.product_name || "")}${r.option_name ? ` <span class="pi-sub">${escHtml(r.option_name)}</span>` : ""}</div>` : ""}
      <div class="pi-sub">${p ? `ERP <code class="pi-code">${escHtml(p.code || "")}</code> ${escHtml(p.name || "")}` : "ERP 상품 연결 없음(쿠팡 SKU 만)"}</div>`;
  }
  const kindOf = k => EXCLUSION_KIND[k] || { label: k, chip: "waiting", note: "" };
  const eventsOf = (vid, kind) => (S.ctx.exclusionEvents || []).filter(e => e.vendor_item_id === vid && (!kind || e.kind === kind));

  function exclusionPanelHtml() {
    const c = S.ctx;
    const head = `<div class="card-head"><h2>재입고 제외 관리 <span class="pi-sub" style="font-weight:600">재입고 제외·SKU 사용 보류</span>${canExclude() ? "" : ` <span class="erp-readonly">🔒 읽기 전용</span>`}</h2>
        <button class="btn sm secondary" id="pi-ex-refresh" onclick="ProcurementInput.refreshExclusions()" ${S.busy ? "disabled" : ""}>새로고침</button></div>
      <details class="erp-help"><summary>재입고 제외와 SKU 사용 보류의 차이</summary><b>재입고 제외</b>: 앞으로 재고를 넣지 않는 SKU - 추천 발주수량이 없고 자동 발주·WING 입고 초안 대상에서 빠져요.
        <b>SKU 사용 보류</b>: 상품 연결은 그대로 두고 발주정보 동기화·발주·WING 입고 SKU 후보에서만 빼요(같은 상품의 정상 SKU 로 계속 진행).
        어느 쪽이든 상품과 원가, 과거 판매·재고·입고·공헌이익 자료는 지우지 않아요. 해제해도 바로 발주하거나 WING 초안을 만들지 않아요 -
        다음 재고 판단과 별도 승인을 거쳐요. 등록·해제는 승인 권한자만, 사유가 필요하고 이력이 남아요.</details>`;
    if (c.exclusionError) return `<div class="card">${head}<div class="pi-banner bad">${escHtml(c.exclusionError)}</div></div>`;
    const active = (c.exclusions || []).filter(e => e.active);
    const released = (c.exclusions || []).filter(e => !e.active);
    const edit = canExclude();
    const btn = (label, onclick, cls = "secondary") => `<button class="btn sm ${cls}" ${S.busy ? "disabled" : ""} onclick="${onclick}">${label}</button>`;
    const rows = active.map(e => {
      const k = kindOf(e.kind);
      const vid = escHtml(e.vendor_item_id);
      return `<tr><td class="erp-sticky erp-card-head"><code>${vid}</code>${skuLabelHtml(e)}</td>
        <td data-label="종류">${UI().badge(k.badge || "hold", { text: k.label, title: k.note })}</td>
        <td class="pi-ex-reason" data-label="사유">${escHtml(e.reason)}</td>
        <td data-label="등록"><div class="erp-stack"><span class="pi-sub">${escHtml(e.excluded_by_name || "")}</span><span class="pi-sub">${fmtKst(e.excluded_at)}</span></div></td>
        <td class="pi-ex-act erp-actions">${btn("제외 사유 보기", `ProcurementInput.exclusionDetail('${vid}','${e.kind}')`)}
          ${btn("변경 이력", `ProcurementInput.exclusionHistory('${vid}')`)}
          ${edit ? btn(`${k.label} 해제`, `ProcurementInput.releaseExclusion('${vid}','${e.kind}')`) : ""}</td></tr>`;
    }).join("");
    const form = edit ? `<div class="pi-ex-form">
        <select id="pi-ex-kind" class="pi-in" aria-label="제외 종류" onchange="ProcurementInput.exKindChanged(this.value)">
          <option value="RESTOCK_EXCLUDED">재입고 제외</option><option value="CANDIDATE_EXCLUDED">SKU 사용 보류</option></select>
        <input id="pi-ex-vid" class="pi-in" inputmode="numeric" placeholder="쿠팡 옵션 ID(vendorItemId)" style="width:190px" aria-label="쿠팡 옵션 ID">
        <input id="pi-ex-reason" class="pi-in" placeholder="사유(필수)" style="flex:1 1 220px;min-width:0" aria-label="사유">
        <button class="btn" id="pi-ex-add" ${S.busy ? "disabled" : ""} onclick="ProcurementInput.addExclusion()">재입고 제외</button></div>
        <div class="pi-err" id="pi-ex-err"></div>`
      : `<div class="pi-banner">보기 전용 - 승인 권한자만 등록·해제할 수 있어요. 목록·사유·이력은 볼 수 있어요.</div>`;
    const exSummary = UI().summaryHtml([
      { label: "재입고 제외", value: active.filter(e => e.kind === "RESTOCK_EXCLUDED").length, kind: "excluded" },
      { label: "SKU 사용 보류", value: active.filter(e => e.kind === "CANDIDATE_EXCLUDED").length, kind: "hold" },
      { label: "해제된 제외", value: released.length, kind: "muted", sub: "이력 보존" },
    ], { compact: true, label: "재입고 제외 요약" });
    return `<div class="card" id="pi-ex-card">${head}${exSummary}${form}
      ${active.length ? `<div class="erp-table-wrap"><table class="pi-table erp-table erp-cards">
        <thead><tr><th class="erp-sticky">쿠팡 SKU · 상품</th><th>종류</th><th>사유</th><th>등록</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table></div>` : `<p class="empty">제외된 SKU 가 없어요.</p>`}
      ${released.length ? `<details class="pi-ex-released"><summary>해제된 제외 ${released.length}건</summary>
        ${released.map(e => `<div class="pi-sub"><code>${escHtml(e.vendor_item_id)}</code> ${kindOf(e.kind).label} ·
          해제 ${escHtml(e.released_by_name || "")} ${fmtKst(e.released_at)} · ${escHtml(e.release_reason || "")}
          <button class="pi-link" onclick="ProcurementInput.exclusionDetail('${escHtml(e.vendor_item_id)}','${e.kind}')">제외 사유 보기</button></div>`).join("")}</details>` : ""}
    </div>`;
  }

  function exKindChanged(kind) {
    const b = root.document.getElementById("pi-ex-add");
    if (b) b.textContent = kindOf(kind).label;
  }

  function exclusionModal(title, bodyHtml, actionLabel, onclick) {
    root.document.getElementById("modal-root").innerHTML = `
      <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
        <div class="modal" style="max-width:600px">
          <h3>${title}</h3>${bodyHtml}
          <div class="pi-err" id="pi-ex-modal-err"></div>
          <div class="modal-actions">
            <button class="btn secondary" onclick="closeModal()">${actionLabel ? "취소" : "닫기"}</button>
            ${actionLabel ? `<button class="btn" id="pi-ex-go" onclick="${onclick}">${actionLabel}</button>` : ""}
          </div>
        </div>
      </div>`;
  }

  function eventsHtml(rows) {
    return !rows.length ? `<p class="empty">이력이 없어요.</p>` : rows.map(e => `<div class="pi-review-item"><div><b>${e.action === "EXCLUDE" ? "등록" : "해제"}</b> ·
        ${kindOf(e.kind).label} · ${escHtml(e.actor_name || "")} · <span class="pi-sub">${fmtKst(e.created_at)}</span></div>
        <div class="pi-sub">${escHtml(e.reason)}</div></div>`).join("");
  }

  /** SKU 상세 · 제외 사유(조회만) - ERP 매핑이 없는 SKU(크림화이트 등)도 여기서 봐요 */
  function exclusionDetail(vid, kind) {
    const e = (S.ctx.exclusions || []).find(x => x.vendor_item_id === vid && x.kind === kind);
    if (!e) return;
    const k = kindOf(kind);
    const r = skuInfo(vid);
    exclusionModal(`제외 사유 · <code>${escHtml(vid)}</code>`, `<table class="rg-detail"><tbody>
        <tr><th>쿠팡 SKU</th><td><code>${escHtml(vid)}</code>${r && r.status ? ` <span class="pi-sub">발주추천 상태 ${escHtml(r.status)}</span>` : ""}</td></tr>
        <tr><th>상품</th><td>${skuLabelHtml(e)}</td></tr>
        <tr><th>종류</th><td>${UI().badge(k.badge || "hold", { text: k.label })} ${e.active ? "" : UI().badge("muted", { text: "해제됨" })}<div class="pi-sub">${escHtml(k.note)}</div></td></tr>
        <tr><th>제외 사유</th><td>${escHtml(e.reason)}</td></tr>
        <tr><th>등록</th><td>${escHtml(e.excluded_by_name || "")} · ${fmtKst(e.excluded_at)}</td></tr>
        ${e.active ? "" : `<tr><th>해제</th><td>${escHtml(e.released_by_name || "")} · ${fmtKst(e.released_at)}<div class="pi-sub">${escHtml(e.release_reason || "")}</div></td></tr>`}
      </tbody></table><h4 style="font-size:13px;margin:12px 0 6px">변경 이력</h4>${eventsHtml(eventsOf(vid, kind))}`, "", "");
  }

  function exclusionHistory(vid) {
    exclusionModal(`변경 이력 · <code>${escHtml(vid)}</code>`, eventsHtml(eventsOf(vid)), "", "");
  }

  /** 등록 전 확인(쓰기 없음). 숫자 SKU·사유 필수, 이미 같은 종류로 제외돼 있으면 막아요. */
  function addExclusion() {
    if (!canExclude() || S.busy) return;
    const doc = root.document;
    const vid = String(doc.getElementById("pi-ex-vid").value || "").replace(/\s/g, "");
    const kind = doc.getElementById("pi-ex-kind").value || "RESTOCK_EXCLUDED";
    const reason = String(doc.getElementById("pi-ex-reason").value || "").trim();
    const err = doc.getElementById("pi-ex-err");
    const bad = !/^[0-9]{5,20}$/.test(vid) ? "쿠팡 옵션 ID(숫자)를 확인해 주세요"
      : !EXCLUSION_KIND[kind] ? "제외 종류를 골라 주세요" : !reason ? "사유를 입력해 주세요"
      : (S.ctx.exclusions || []).some(e => e.active && e.vendor_item_id === vid && e.kind === kind) ? "이미 같은 종류로 제외돼 있어요" : "";
    if (err) err.textContent = bad;
    if (bad) return;
    S.pendingExclusion = { vid, kind, reason };
    const k = kindOf(kind);
    const r = skuInfo(vid);
    exclusionModal(`${k.label} 등록 확인`, `<table class="rg-detail"><tbody>
        <tr><th>쿠팡 SKU</th><td><code>${escHtml(vid)}</code></td></tr>
        <tr><th>쿠팡 상품</th><td>${r ? `${escHtml(r.product_name || "")} <span class="pi-sub">${escHtml(r.option_name || "")}</span>` : `<span class="pi-sub">발주추천 표에 이름이 없어요</span>`}</td></tr>
        <tr><th>연결 ERP 상품</th><td><span class="pi-sub">저장할 때 DB 가 쿠팡 SKU 연결에서 찾아 기록해요(없으면 비워 둠)</span></td></tr>
        <tr><th>종류</th><td><b>${k.label}</b> - ${escHtml(k.note)}</td></tr>
        <tr><th>사유</th><td>${escHtml(reason)}</td></tr></tbody></table>
      <p class="pi-note">상품·매핑·원가·과거 판매·재고·입고 이력은 그대로 두고 이 SKU 에 제외 표시만 해요. 언제든 해제할 수 있어요.</p>`,
      k.label, "ProcurementInput.confirmExclusion()");
  }

  /** 처리 중 표시·중복 클릭 방지 → rpc 1번 → 성공·실패 모두 서버에서 다시 읽어 화면을 맞춰요 */
  async function runExclusionRpc(fn, args, doneText, label) {
    if (S.busy) return;
    S.busy = true;
    const btn = root.document.getElementById("pi-ex-go");
    if (btn) { btn.disabled = true; btn.textContent = "처리 중…"; }
    let result;
    try {
      const { data, error } = await S.sb.rpc(fn, args);
      result = error ? { ok: false, text: errorMessage(error).text } : { ok: true, status: data && data.status };
    } catch (e) {
      result = { ok: false, text: errorMessage(e).text };
    }
    S.busy = false;
    await reloadKeepForms();   // 성공·실패 모두 서버 상태로
    if (!result.ok) {
      const el = root.document.getElementById("pi-ex-modal-err");
      if (el) el.textContent = `${result.text} - 서버 상태를 다시 읽었어요`;
      if (btn) { btn.disabled = false; btn.textContent = label; }
      return result;
    }
    root.closeModal && root.closeModal();
    (root.toast || (() => {}))(doneText[result.status] || doneText.default);
    return result;
  }

  async function confirmExclusion() {
    const x = S.pendingExclusion;
    if (!x || !canExclude()) return;
    const r = await runExclusionRpc("fn_set_vendor_item_exclusion", { p_vendor_item_id: x.vid, p_kind: x.kind, p_reason: x.reason },
      { ALREADY_EXCLUDED: "이미 제외돼 있어요(이력 추가 없음)", default: "제외를 등록했어요 - 재고 판단은 다음 캐시 갱신 때 반영돼요" },
      kindOf(x.kind).label);
    if (r && r.ok) S.pendingExclusion = null;
  }

  function releaseExclusion(vid, kind) {
    if (!canExclude() || S.busy) return;
    const e = (S.ctx.exclusions || []).find(x => x.active && x.vendor_item_id === vid && x.kind === kind);
    if (!e) return;
    const k = kindOf(kind);
    S.pendingRelease = { vid, kind };
    exclusionModal(`${k.label} 해제`, `<p><code>${escHtml(vid)}</code></p>${skuLabelHtml(e)}
      <p class="pi-sub">제외 사유: ${escHtml(e.reason)} (${escHtml(e.excluded_by_name || "")} ${fmtKst(e.excluded_at)})</p>
      <input id="pi-ex-release-reason" class="pi-in" placeholder="해제 사유(필수)" style="width:100%;margin-top:8px" aria-label="해제 사유">
      <p class="pi-note" style="margin-top:8px">해제해도 바로 발주하거나 WING 입고 초안을 만들지 않아요 - 다음 재고 판단과 별도 사용자 승인을 거쳐요.</p>`,
      `${k.label} 해제`, "ProcurementInput.confirmRelease()");
  }

  async function confirmRelease() {
    const x = S.pendingRelease;
    if (!x || !canExclude() || S.busy) return;
    const reason = String((root.document.getElementById("pi-ex-release-reason") || {}).value || "").trim();
    const errEl = root.document.getElementById("pi-ex-modal-err");
    if (!reason) { if (errEl) errEl.textContent = "해제 사유를 입력해 주세요"; return; }
    const r = await runExclusionRpc("fn_release_vendor_item_exclusion", { p_vendor_item_id: x.vid, p_kind: x.kind, p_reason: reason },
      { ALREADY_RELEASED: "이미 해제돼 있어요(이력 추가 없음)", default: "제외를 해제했어요 - 발주·WING 초안은 다음 판단과 별도 승인 뒤에만" },
      `${kindOf(x.kind).label} 해제`);
    if (r && r.ok) S.pendingRelease = null;
  }

  async function refreshExclusions() {
    if (S.busy) return;
    await reloadKeepForms();
    (root.toast || (() => {}))("제외 목록을 다시 읽었어요");
  }

  /** 서버에서 다시 읽기 - 편집 중인 발주정보 칸은 지우지 않아요 */
  async function reloadKeepForms() {
    const forms = S.forms, orig = S.orig, touched = S.touched;
    S.ctx = await load(S.sb);
    S.loadError = S.ctx.loadError;
    resetForms();
    for (const pid of Object.keys(forms)) if (S.forms[pid] && diffRow(orig[pid], forms[pid]).length) S.forms[pid] = forms[pid];
    S.touched = touched;
    rerender();
  }

  function rerender() {
    const el = root.document && root.document.getElementById("content");
    if (el) el.innerHTML = render();
  }

  // ── 이벤트 ───────────────────────────────────────────────────────────────
  function onInput(pid, field, value) {
    if (!S.forms[pid] || !canInput()) return;
    S.forms[pid][field] = value;
    S.touched = S.touched || new Set();
    S.touched.add(pid);
    const v = [...S.ctx.targets, ...S.ctx.entered].find(x => x.product.id === pid);
    const val = validateRow(S.forms[pid], v.product);
    const doc = root.document;
    for (const f of EDIT_FIELDS) {
      const e = doc.getElementById(`pi-err-${pid}-${f}`);
      if (e) e.textContent = val.errors[f] || "";
      const inp = doc.getElementById(`pi-${pid}-${f}`);
      if (inp) inp.classList.toggle("bad", !!val.errors[f]);
    }
    if (field === "cost_vat_basis" || field === "orderable_unit") {
      const tr = doc.getElementById(`pi-row-${pid}`);
      if (tr) tr.outerHTML = rowHtml(v, true);
    }
    const tr = doc.getElementById(`pi-row-${pid}`);
    if (tr) tr.classList.toggle("pi-dirty", diffRow(S.orig[pid], S.forms[pid]).length > 0);
    const logi = doc.getElementById(`pi-logi-${pid}`);
    if (logi) logi.innerHTML = val.complete ? "" : logisticsNoteHtml(val.missing);
    const foot = doc.getElementById("pi-foot");
    if (foot) foot.outerHTML = footerHtml();
  }

  function fill(pid, field) {
    const v = [...S.ctx.targets, ...S.ctx.entered].find(x => x.product.id === pid);
    const s = suggestionsFor(v.product, S.ctx.poItems, v.reco)[field];
    if (!s || s.value === null || s.value === undefined) return;
    const inp = root.document.getElementById(`pi-${pid}-${field}`);
    if (inp) inp.value = s.value;
    onInput(pid, field, s.value);
  }

  function setTab(k) { S.tab = k; rerender(); }
  function edit() { if (!canEdit()) return; S.editing = true; rerender(); }
  function cancel() { if (S.busy) return; resetForms(); S.touched = new Set(); S.editing = false; rerender(); }

  function changedRows() {
    return [...S.ctx.targets, ...S.ctx.entered]
      .map(v => ({ v, changes: diffRow(S.orig[v.product.id], S.forms[v.product.id]), val: validateRow(S.forms[v.product.id], v.product) }))
      .filter(x => x.changes.length);
  }

  function reviewHtml(rows) {
    const show = (f, x) => x === null || x === undefined || x === "" ? "—"
      : f === "cost_vat_basis" ? VAT_LABEL[x] || x : f === "orderable_unit" ? UNIT_LABEL[x] || x : escHtml(x);
    return rows.map(({ v, changes, val }) => {
      const p = v.product;
      return `<div class="pi-review-item">
        <div><b>${escHtml((v.reco && v.reco.product_name) || p.name || p.code)}</b> <code>${escHtml(p.code)}</code></div>
        <div class="pi-review-cost">매입원가 <b>${won(p.cost_price)}</b> = <b>${VAT_LABEL[val.payload.cost_vat_basis]}</b>(으)로 확인 · 제품 마스터 원가는 그대로</div>
        ${supplyHtml(p.cost_price, val.payload.cost_vat_basis)}
        <table class="rg-detail"><tbody>${changes.map(c => `<tr><th>${c.label}</th><td>${show(c.field, c.before)} → <b>${show(c.field, c.after)}</b></td></tr>`).join("")}</tbody></table>
        ${val.complete ? "" : `<div class="pi-warn pi-warn-wide">물류정보 입력 필요 - ${escHtml(missingText(val.missing))} 없음. 원가·VAT 기준은 저장되지만,
          채울 때까지 BigQuery 반영·정식 추천 발주수량·자동 발주·WING 입고 초안이 막혀요.</div>`}
        ${val.warnings.map(w => `<div class="pi-warn">${escHtml(w)}</div>`).join("")}
      </div>`;
    }).join("");
  }

  function review() {
    if (!canInput() || S.busy) return;
    const rows = changedRows();
    if (!rows.length) return;
    const bad = rows.filter(r => !r.val.ok);
    if (bad.length) { S.touched = new Set(rows.map(r => r.v.product.id)); rerender(); return; }
    root.document.getElementById("modal-root").innerHTML = `
      <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
        <div class="modal" style="max-width:640px">
          <h3>변경 내용 확인 · ${rows.length}개 상품</h3>
          <p class="pi-note">저장하면 감사 이력에 남고, BigQuery 에는 06:20 통합수집 때 반영돼요(동기화 스위치가 켜져 있을 때만).
            30%가 넘는 원가 변경은 자동 반영하지 않고 승인을 기다려요.</p>
          ${reviewHtml(rows)}
          <div class="modal-actions">
            <button class="btn secondary" onclick="closeModal()">취소</button>
            <button class="btn" id="pi-save-btn" onclick="ProcurementInput.saveAll()">${rows.length}개 저장</button>
          </div>
        </div>
      </div>`;
  }

  async function saveAll() {
    if (!canInput() || S.busy) return;   // 중복 클릭 방지
    S.busy = true;
    const btn = root.document.getElementById("pi-save-btn");
    if (btn) { btn.disabled = true; btn.textContent = "저장 중…"; }
    const rows = changedRows().filter(r => r.val.ok);
    const results = [];
    for (const { v, val } of rows) {
      const p = v.product;
      let data = null, error = null;
      try {
        ({ data, error } = await S.sb.rpc("fn_save_product_procurement", {
          p_product_id: p.id, p_values: val.payload, p_cost_price_seen: p.cost_price,
          // PostgREST 가 준 문자열 그대로(마이크로초까지) - Date 로 바꾸면 정밀도가 잘려 STALE_ROW 가 나요
          p_expected_updated_at: v.procurement ? v.procurement.updated_at : null,
        }));
      } catch (e) { error = e; }
      results.push({ p, ok: !error, status: data && data.status, err: error ? errorMessage(error) : null,
                     missing: data && Array.isArray(data.logistics_missing) ? data.logistics_missing : [] });
    }
    const ok = results.filter(r => r.ok), bad = results.filter(r => !r.ok);
    root.document.getElementById("modal-root").innerHTML = `
      <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
        <div class="modal" style="max-width:560px">
          <h3>저장 결과 · ${ok.length}개 저장${bad.length ? ` · ${bad.length}개 실패` : ""}</h3>
          ${results.map(r => `<div class="pi-result ${r.ok ? "" : "bad"}"><code>${escHtml(r.p.code)}</code>
            ${r.ok ? (r.status === "NO_CHANGE" ? "바뀐 내용 없음" : "저장됨") : `${escHtml(r.err.text)} <span class="pi-sub">(${escHtml(r.err.code)})</span>`}
            ${r.ok && r.missing.length ? `<span class="chip progress">물류정보 입력 필요</span> <span class="pi-sub">${escHtml(missingText(r.missing))} 없음</span>` : ""}</div>`).join("")}
          ${bad.length ? `<p class="pi-note">실패한 상품은 입력한 값을 그대로 두고 편집 상태를 유지해요. 화면은 서버에서 다시 읽은 값이에요.</p>` : ""}
          <div class="modal-actions"><button class="btn" onclick="closeModal()">확인</button></div>
        </div>
      </div>`;
    // 성공·실패 모두 서버에서 다시 읽기 - 저장된 상품은 서버 값으로, 실패한 상품은 입력값 유지(화면만 성공 처리 안 함)
    S.busy = false;
    const failedIds = new Set(bad.map(r => r.p.id));
    const keep = Object.fromEntries(Object.entries(S.forms).filter(([pid]) => failedIds.has(pid)));
    S.ctx = await load(S.sb);
    S.loadError = S.ctx.loadError;
    resetForms();
    for (const [pid, f] of Object.entries(keep)) if (S.forms[pid]) S.forms[pid] = f;
    S.touched = new Set(Object.keys(keep));
    S.editing = bad.length > 0;
    rerender();
  }

  function history(pid) {
    const v = [...S.ctx.targets, ...S.ctx.entered].find(x => x.product.id === pid);
    const rows = (S.ctx.audits || []).filter(a => a.product_id === pid);
    const act = { CREATE: "처음 입력", UPDATE: "수정", COST_CHANGE_APPROVED: "원가 변경 승인", RESTORE: "복구(배포 전 스냅샷 값으로)" };
    root.document.getElementById("modal-root").innerHTML = `
      <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
        <div class="modal" style="max-width:600px">
          <h3>변경 이력 · <code>${escHtml(v ? v.product.code : "")}</code></h3>
          ${!rows.length ? `<p class="empty">아직 이력이 없어요.</p>` : rows.map(a => `<div class="pi-review-item">
            <div><b>${act[a.action] || a.action}</b> · ${escHtml(a.actor_name || "")} · <span class="pi-sub">${fmtKst(a.created_at)}</span></div>
            <div class="pi-sub">확인한 원가 ${won(a.cost_price_seen)}${a.cost_vat_basis ? ` · ${VAT_LABEL[a.cost_vat_basis] || a.cost_vat_basis}` : ""}</div>
            <div class="pi-sub">${(a.changed_fields || []).map(f => FIELD_LABEL[f] || f).join(", ")}</div></div>`).join("")}
          <div class="modal-actions"><button class="btn" onclick="closeModal()">닫기</button></div>
        </div>
      </div>`;
  }

  // 2026-09-13 [ERP UI 정리] 원가 변경 승인 - 같은 DB 함수 1번. 확인창(상품·원가 전후·변경률) · 중복 클릭 방지 · 처리 중 표시 ·
  // 성공·실패 모두 서버 상태 다시 읽기(편집 중 입력값은 유지). 이미 승인됐으면 DB 가 막아요(중복 이력 없음).
  async function approveCost(pid) {
    const st = (S.ctx.syncStates || []).find(s => s.product_id === pid);
    if (!st || st.status !== "COST_APPROVAL_REQUIRED") return;
    const v = [...S.ctx.targets, ...S.ctx.entered].find(x => x.product.id === pid);
    const p = (v && v.product) || (S.ctx.products || []).find(x => x.id === pid) || {};
    const pct = st.bq_cost ? Math.round((st.pending_cost - st.bq_cost) / st.bq_cost * 100) : null;
    return UI().run({
      key: `pi-cost-${pid}`, allowed: canEdit() && !S.busy, deniedText: "승인 권한자만 원가 변경을 승인할 수 있어요(읽기 전용)",
      confirm: { title: "원가 변경 승인", actionLabel: "원가 변경 승인",
        rows: [["상품", `${escHtml(UI().displayName(p.code, p.name || ""))} <code>${escHtml(p.code || "")}</code>`],
               ["BigQuery 원가", `${won(st.bq_cost)} → <b>${won(st.pending_cost)}</b>${pct !== null ? ` (${pct > 0 ? "+" : ""}${pct}%)` : ""}`]],
        notes: ["다음 06:20 동기화 때 반영돼요(동기화 스위치가 켜져 있을 때만).", "제품 마스터 원가는 바꾸지 않아요."] },
      exec: async () => {
        const { error } = await S.sb.rpc("fn_approve_procurement_cost_change", { p_product_id: pid, p_pending_cost_seen: st.pending_cost });
        return error ? { ok: false, message: errorMessage(error).text } : { ok: true };
      },
      successText: "원가 변경을 승인했어요 - 다음 동기화 때 반영돼요",
      refresh: reloadKeepForms,
    });
  }

  root.ProcurementInput = {
    VAT_LABEL, UNIT_LABEL, FIELD_LABEL,
    parseIntField, validateRow, formFromRow, diffRow, buildTargets, suggestionsFor, errorMessage, setPreview, supplyPreview,
    VAT_STATUS, vatNeedsAck, computeVatStatus, fetchVatStatus, vatChipHtml,
    LOGISTICS_FIELDS, EXCLUSION_KIND, logisticsMissing,
    view, render, onInput, fill, tab: setTab, edit, cancel, reset: cancel, review, saveAll, history, approveCost,
    addExclusion, confirmExclusion, releaseExclusion, confirmRelease, exclusionHistory, exclusionDetail, refreshExclusions, exKindChanged,
    _state: S,
  };
})(typeof window !== "undefined" ? window : globalThis);
