// fixtures_cancel_status_card.mjs
// 2026-09-16 취소·회수 확인 기능 꺼짐(DISABLED)은 '자동 수집 상태' 카드와 대시보드 할 일에서 실패로 보이지 않아요(네트워크 0건).
//   · 백엔드는 꺼짐을 record_success(detail.state = DISABLED)로 남김 → consecutive_failures 0 · last_error 없음
//   · 진짜 실패(record_failure)는 그대로 빨간/주황 표시
import { readFileSync } from "fs";
import vm from "vm";
const app = readFileSync(new URL("./js/app.js", import.meta.url).pathname, "utf8");
const grabFn = name => { const m = app.match(new RegExp(`\\n(async )?function ${name}\\([\\s\\S]*?\\n}`)); if (!m) throw new Error(name); return m[0]; };
let n = 0; const fails = [];
const check = (label, got, want) => { n++; const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) { console.log(`        기대=${JSON.stringify(want)}\n        실제=${JSON.stringify(got)}`); fails.push(label); } };
const NOW = new Date(Date.now() - 3600000).toISOString();
const disabled = { job_name: "rg_ledger_cancel_status", last_success_at: NOW, last_attempt_at: NOW, last_error: null, error_kind: null,
  consecutive_failures: 0, detail: { version: 3, state: "DISABLED", writes_enabled: false, complete: false } };
const failed = { ...disabled, last_error: "RuntimeError: 503", error_kind: "API_ERROR", consecutive_failures: 1, last_attempt_at: new Date().toISOString() };
async function card(jobs) {
  const ctx = { sb: { from: t => ({ select: () => ({ is: () => Promise.resolve({ data: [], error: null }),
      then: (res, rej) => Promise.resolve({ data: t === "sync_job_status" ? jobs : [], error: null }).then(res, rej) }) }) },
    esc: s => String(s), console, Date, Object, Math, String, Number, Promise };
  vm.createContext(ctx);
  vm.runInContext(`${grabFn("syncAgeText")}\n${grabFn("renderSyncHealthCard")}\nglobalThis.__r = renderSyncHealthCard;`, ctx);
  return ctx.__r();
}
const green = h => h.includes("border-left:4px solid var(--green)");
check("꺼짐(DISABLED) 행만 있음 → 자동 수집 상태 카드 초록(실패 아님)", green(await card([disabled])), true);
check("진짜 실패 → 빨간 테두리", green(await card([failed])), false);
// 대시보드 할 일: 정해진 작업만 보고, last_error 가 성공보다 최근일 때만 실패
const dash = readFileSync(new URL("./js/erp_dashboard.js", import.meta.url).pathname, "utf8");
check("대시보드 실패 목록 대상에 취소 기록 작업 없음(꺼짐·실패 모두 재고 화면에서만 표시)", /rg_ledger_cancel_status/.test(dash), false);
console.log(fails.length ? `\n실패 ${fails.length}/${n}` : `\n전부 통과 ${n}/${n}`);
process.exit(fails.length ? 1 : 0);
