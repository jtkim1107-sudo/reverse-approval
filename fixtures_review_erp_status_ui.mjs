import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const src = fs.readFileSync(new URL("./js/app.js", import.meta.url), "utf8");
const start = src.indexOf("function vocAgeText(");
const end = src.indexOf("async function viewVoc(", start);
assert(start >= 0 && end > start);

async function render(source, erp) {
  const rows = { review_voc_collect: source, erp_review_sheet_sync: erp };
  const context = {
    Date,
    sb: { from: () => ({ select: () => ({ eq: (key, name) => ({
      maybeSingle: async () => ({ data: rows[name] || null, error: null }),
    }) }) }) },
    esc: text => String(text),
  };
  vm.createContext(context);
  vm.runInContext(src.slice(start, end), context);
  return context.renderVocStatusBanner();
}

const source = { last_success_at: "2026-09-17T00:10:00Z", consecutive_failures: 0 };
const synced = { last_success_at: "2026-09-17T00:11:00Z", consecutive_failures: 0 };
assert.match(await render(source, null), /ERP 반영을 확인해야/);
assert.match(await render(source, { ...synced, last_success_at: "2026-09-16T03:00:00Z" }), /ERP 반영을 확인해야/);
assert.match(await render(source, { ...synced, consecutive_failures: 1 }), /재시도 중/);
assert.match(await render(source, synced), /리뷰 수집·ERP 반영 정상/);
assert.doesNotMatch(await render(source, synced), /ERP 반영을 확인해야/);
console.log("review ERP status UI: 5 cases passed");
