// erp_ledger_harness.mjs
// ------------------------------------------------
// 2026-09-15 app.js 의 실제 loadErpBase · cmOfSale · sumCM 을 잘라 가짜 DB(sb)로 실행하는 공용 도구(네트워크 0건).
// 테스트(fixtures_resale_ledger_stock.mjs)와 운영 자료 전후 비교가 같은 코드를 써요.
import { readFileSync } from "fs";
import vm from "vm";

export function loadApp(appPath, freightPath) {
  const app = readFileSync(appPath, "utf8");
  const grabFn = name => {
    const m = app.match(new RegExp(`\\n(async )?function ${name}\\([\\s\\S]*?\\n}`));
    if (!m) throw new Error(`${name} 없음`);
    return m[0];
  };
  const grabLine = re => { const m = app.match(re); if (!m) throw new Error(String(re)); return m[0]; };
  const erpBlock = app.slice(app.indexOf("/* ==================== ERP: 매출 / 매입 / 재고 / 리포트"), app.indexOf("const prodName = id =>"));
  const src = `
    let TODAY_FIXED = "2026-09-15";
    const today = () => TODAY_FIXED;
    let vatCfg = { enabled: true, salePriceIncludesVat: true, purchaseCostIncludesVat: false, expenseIncludesVat: true };
    const VAT_RATE = 0.1;
    ${grabLine(/const netAmt = [\s\S]*?\n};/)}
    ${grabLine(/const vatAmt = [\s\S]*?\n};/)}
    ${grabLine(/const isTaxable = .*/)}
    ${grabLine(/const saleNet = .*/)}
    ${grabLine(/const saleVat = .*/)}
    ${grabLine(/const buyNet = .*/)}
    ${grabLine(/const buyVat = .*/)}
    ${grabLine(/const expNet = .*/)}
    ${grabLine(/const expVat = .*/)}
    ${erpBlock}
    ${grabLine(/const monthOf = .*/)}
    ${grabLine(/\nconst fmt = .*/).trim()}
    ${grabLine(/const tradeTypeOf = .*/)}
    ${grabLine(/const isSetProd = .*/)}
    ${grabLine(/const setBaseOf = .*/)}
    ${grabFn("effCost")}
    ${grabFn("isCoupangPoolSale")}
    ${grabFn("dedupeAutoOverManualSales")}
    ${grabFn("channelSetting")}
    ${grabFn("shipKeyOf")}
    ${grabFn("shipChargedRows")}
    ${grabFn("cmOfSale")}
    ${grabFn("sumCM")}
    ${grabFn("loadErpBase")}
    ${app.includes("function erpStockLabel(") ? grabFn("erpStockLabel") : ""}
    // 기존 공헌이익 계산과 같은 범위(그 달 · 끝날까지). withCancels=true 는 '정정도 반영하면'을 계산만 해 보는 용도(화면 코드엔 없음).
    function monthCm(sales, month, cutoff, withCancels = false) {
      const inRange = r => monthOf(r) === month && (r.date || "") <= TODAY_FIXED && (r.date || "") <= cutoff;
      const rows = sales.filter(inRange).concat(withCancels && typeof erpCancelRows !== "undefined" ? erpCancelRows.filter(inRange) : []);
      const sc = shipChargedRows(rows); const per = {};
      rows.forEach(r => { per[r.id] = cmOfSale(r, sc); });
      return { t: sumCM(rows), per };
    }
    globalThis.__api = { loadErpBase, monthCm, stock: () => erpStock, freight: () => erpFreight,
      resale: () => ({ vids: [...(typeof erpResaleVids === "undefined" ? [] : erpResaleVids)], error: typeof erpResaleRolesError === "undefined" ? null : erpResaleRolesError }),
      stockCheck: () => (typeof erpStockCheck === "undefined" ? null : erpStockCheck),
      checkOf: pid => (typeof erpStockCheckOf === "undefined" ? null : erpStockCheckOf(pid)),
      label: pid => erpStockLabel(erpProducts.find(p => p.id === pid)),
      setLive: m => { erpLiveStockByProduct = m; },
      setVat: v => { vatCfg = { ...vatCfg, ...v }; }, setToday: d => { TODAY_FIXED = d; } };
  `;
  return { src, freight: readFileSync(freightPath, "utf8") };
}

// 가짜 Supabase: from(table).select().order().eq()... → await 하면 { data, error }
export function fakeSb(tables, errors = {}) {
  return {
    from(table) {
      const filters = []; let single = false;
      const q = {
        select() { return q; }, order() { return q; }, is() { return q; }, in() { return q; },
        eq(k, v) { filters.push([k, v]); return q; }, maybeSingle() { single = true; return q; },
        then(res, rej) {
          if (errors[table]) return Promise.resolve({ data: null, error: { message: errors[table] } }).then(res, rej);
          let rows = JSON.parse(JSON.stringify(tables[table] || [])).filter(r => filters.every(([k, v]) => String(r[k]) === String(v)));
          return Promise.resolve({ data: single ? (rows[0] || null) : rows, error: null }).then(res, rej);
        },
      };
      return q;
    },
  };
}

export async function runLedger(appPath, freightPath, tables, { errors = {}, vat = null, todayStr = "2026-09-15" } = {}) {
  const { src, freight } = loadApp(appPath, freightPath);
  const ctx = vm.createContext({ console, Map, Set, Math, Number, String, Object, Array, JSON, Promise, Intl, Date, RegExp, sb: fakeSb(tables, errors) });
  vm.runInContext(freight, ctx);
  vm.runInContext(src, ctx);
  const api = ctx.__api;
  api.setToday(todayStr);
  if (vat) api.setVat(vat);
  const base = await api.loadErpBase();
  return { api, base };
}
