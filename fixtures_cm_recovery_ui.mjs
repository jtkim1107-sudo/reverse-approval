// fixtures_cm_recovery_ui.mjs - js/cm_recovery.js(반품 원가환입 제안·승인 검토·승인 취소) 로컬 검증. 네트워크·DB 없음(가짜 sb 로 호출만 기록).
//   node fixtures_cm_recovery_ui.mjs
import fs from "node:fs";
import vm from "node:vm";
const ctx = { console, crypto: globalThis.crypto, Blob: globalThis.Blob, btoa: globalThis.btoa, atob: globalThis.atob };
ctx.globalThis = ctx; ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(new URL("./js/erp_ui.js", import.meta.url), "utf8"), ctx);
vm.runInContext(fs.readFileSync(new URL("./js/cm_recovery.js", import.meta.url), "utf8"), ctx);
const R = ctx.CmRecovery;
let n = 0, fail = 0;
const check = (label, got, want) => { n++; const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n       기대=${JSON.stringify(want)}\n       실제=${JSON.stringify(got)}`}`); };
const SHA = "ab".repeat(32), SHA2 = "cd".repeat(32);
const cand = { order_id: "1102498108125", option_id: "95928260688", refund_date: "2026-09-02", product_id: "p1", refund_qty: 3, unit_cost: 8500,
               cost_basis: "CURRENT_MASTER", period: "2026-09-01~2026-09-06", file: "f.xlsx", file_sha256: SHA, est_label: "반품(추정)" };
const rec = (id, status, qty, extra = {}) => ({ id, status, qty, refund_qty: 3, order_id: cand.order_id, option_id: cand.option_id, refund_date: cand.refund_date,
  amount: qty * 8500, unit_cost: 8500, evidence_type: "WING_RETURN", wing_ref: "RT-" + id, wing_status: "반품완료", wing_restock_qty: 3, evidence_file_sha256: SHA, ...extra });
const good = { evidence_type: "WING_RETURN", wing_ref: "RT-0009", wing_status: "반품완료", wing_restock_qty: "2", qty: "2", source_file: "wing.xlsx",
               source_sha256: SHA, reason: "반품 입고 확인" };
const meta = { [SHA]: { sha256: SHA, file_name: "wing_returns_0902.xlsx", byte_size: 23456, uploaded_by: "u-staff", uploaded_at: "2026-09-16T08:50:00+09:00" } };
const userName = id => ({ "u-staff": "김사원", "u-approver": "장팀장" }[id] || "?");

console.log("[1] 남은 수량 · 입력 검사(최종 판단은 DB)");
check("제안·승인 합을 빼고 남은 수량(취소·무효는 다시 사용)", [R.remaining(cand, []), R.remaining(cand, [rec("a", "PENDING_APPROVAL", 1), rec("b", "APPROVED", 1), rec("c", "VOID", 1)])], [3, 1]);
check("정상 입력 → 통과", R.validateProposal(good, cand, []), []);
check("[핵심] 남은 수량보다 많이 → 막음(중복·초과)", R.validateProposal({ ...good, qty: "2" }, cand, [rec("a", "APPROVED", 2)]).some(x => x.includes("남은 수량")), true);
check("반품인데 재입고 수량보다 많이 → 막음", R.validateProposal({ ...good, qty: "2", wing_restock_qty: "1" }, cand, []).some(x => x.includes("재입고")), true);
check("[핵심] 추정 분류('반품(추정)')는 유형으로 못 씀 - WING 유형만", R.validateProposal({ ...good, evidence_type: "RETURN_EST" }, cand, []).some(x => x.includes("WING 에서 확인한 유형")), true);
check("WING 번호·파일 해시·사유 없으면 막음", R.validateProposal({ ...good, wing_ref: "", source_sha256: "x", reason: "" }, cand, []).length, 3);
check("소수 수량 막음", R.validateProposal({ ...good, qty: "1.5" }, cand, []).some(x => x.includes("정수")), true);
const bp = R.buildProposal(good, cand);
check("제안 payload: 정산취소 행 식별·정산 파일 해시·근거 파일(이름·SHA-256) · 사용자 ID 칸 없음",
      [bp.order_id, bp.refund_qty, bp.qty, bp.settlement_ref.file_sha256, bp.evidence.source_sha256, Object.keys(bp).filter(k => /_by$|uid|user/.test(k))],
      [cand.order_id, 3, 2, SHA, SHA, []]);

console.log("[2] 화면 - 메타정보 · 권한 · 무결성 문구");
const st = { month: "2026-09", candidates: [cand], meta, userName,
  records: [rec("p1", "PENDING_APPROVAL", 1), rec("a1", "APPROVED", 1, { integrity_checked_at: "2026-09-16T09:30:00+09:00", content_reviewed_at: "2026-09-16T09:28:00+09:00" }),
            rec("v1", "VOID", 1, { evidence_file_sha256: SHA2 })],
  events: [{ recovery_id: "a1", event: "PROPOSED", created_at: "2026-09-16T10:00" }, { recovery_id: "a1", event: "APPROVED", reason: "입고 확인", created_at: "2026-09-16T11:00" }],
  isApprover: false, productCode: { p1: "1M1N-001-02" } };
const hs = R.panelHtml(st), ha = R.panelHtml({ ...st, isApprover: true });
check("대상 표: 참고(추정) · 승인 기록 있는 행 = 확인 완료(회수 1 · 손실 2 ₩17,000) · 다시 기록 버튼 없음",
      [hs.includes("반품(추정)"), hs.includes("확인 완료"), hs.includes("회수 1개 · 손실 2개 ₩17,000"), hs.includes("회수 확인 기록</button>")], [true, true, true, false]);
check("[핵심] 직원: 승인 검토·승인 취소·내려받기 버튼 없음 / 승인자: 승인 검토·승인 취소 있음(목록에 바로 승인 버튼 없음)",
      [hs.includes("openApprove("), hs.includes("승인 취소</button>"), /downloadEvidence|reviewDownload|내려받기/.test(hs),
       ha.includes("CmRecovery.openApprove('p1')"), ha.includes("CmRecovery.voidRec('a1')"), ha.includes("CmRecovery.approve(")], [false, false, false, true, true, false]);
check("근거 파일 메타(파일명·크기·올린 사람·시각·해시 앞자리) · 메타가 없는 파일은 '권한 밖'",
      [ha.includes("wing_returns_0902.xlsx · 23KB · 김사원 09-16 08:50"), ha.includes(SHA.slice(0, 12) + "…"), ha.includes("근거 파일 정보 없음(권한 밖)")], [true, true, true]);
check("[핵심] 승인 행 표시 = '업로드 후 무결성 확인(해시 일치)' + '승인자 파일 열람' · 어디에도 '인증' 문구 없음",
      [ha.includes("업로드 후 무결성 확인(해시 일치) 09-16 09:30 · 승인자 파일 열람 09-16 09:28"), /인증/.test(ha + hs)], [true, false]);

console.log("[3] 승인 검토 창 - 정보 표시 · 내려받기 뒤 확인 체크 · 승인");
const calls = [], toasts = [], saved = [], modals = [];
const els = {};
const el = id => (els[id] = els[id] || { value: "", checked: false, disabled: true, textContent: "" });
const deps = (over = {}) => ({ sb: { rpc: async (name, args) => { calls.push([name, args]); if (over.error) return { data: null, error: { message: over.error } };
    if (name === "fn_upload_cm_evidence_file") return { data: over.serverSha ?? SHA, error: null };
    if (name === "fn_download_cm_evidence_file") return { data: [{ file_name: "wing_returns_0902.xlsx", byte_size: 4, sha256: SHA, content_base64: "UEsDBA==" }], error: null };
    return { data: null, error: null }; } },
  b64: async () => "UEsDBA==", save: (blob, name) => saved.push(name), toast: m => toasts.push(m), prompt: () => over.reason ?? "WING 재확인",
  confirm: () => over.confirm ?? true, close: () => {}, rerender: async () => {}, modal: h => modals.push(h), sha: async () => over.clientSha ?? SHA,
  doc: { getElementById: id => ({ "cmr-type": { value: "WING_RETURN" }, "cmr-ref": { value: "RT-0100" }, "cmr-status": { value: "반품완료" }, "cmr-restock": { value: "1" },
    "cmr-qty": { value: "1" }, "cmr-reason": { value: "반품 입고 1개" }, "cmr-file": { files: [{ name: "wing.xlsx", size: 4 }] } })[id] || el(id) } });
R.set({ ...st, isApprover: true }, deps());
const c0 = calls.length;
await R.approve("p1");
const mh = modals.at(-1);
check("[핵심] 승인 → 검토 창만 열림(RPC 호출 0) · 주문·수량·WING 번호·파일명·크기·올린 사람·올린 시각·전체 해시·무결성 한계 안내",
      [calls.length - c0, ["1102498108125", "1 / 3", "RT-p1", "wing_returns_0902.xlsx · 23KB", "김사원 · 2026-09-16 08:50", SHA, "WING 에서 받은 원본이라는 증명이 아니에요"]
        .map(t => mh.includes(t)), /인증 완료/.test(mh)], [0, [true, true, true, true, true, true, true], false]);
el("cmr-approve-reason").value = "WING 반품 목록에서 번호·수량 확인";
await R.submitApprove("p1");
check("[핵심] 내려받기 전 승인 → 호출 없이 안내", [calls.length - c0, toasts.at(-1)], [0, "근거 파일을 먼저 내려받아 열어 주세요"]);
await R.reviewDownload("p1");
const dlc = calls.at(-1);
check("[핵심] 검토 중 내려받기 = 승인자 RPC(fn_download_cm_evidence_file · 해시 · 사유 · 기록 번호) · 해시 재확인 뒤 저장 · 체크 켜짐",
      [dlc[0], dlc[1].p_sha256, dlc[1].p_reason, dlc[1].p_recovery_id, saved.at(-1), el("cmr-reviewed").disabled], ["fn_download_cm_evidence_file", SHA, "회수·손실 확인 승인 검토", "p1", "wing_returns_0902.xlsx", false]);
const c1 = calls.length;
await R.submitApprove("p1");
check("내려받았어도 '내용 확인' 체크 없으면 → 호출 없이 안내", [calls.length - c1, toasts.at(-1)], [0, "파일 내용을 직접 확인했다는 체크가 필요해요"]);
el("cmr-reviewed").checked = true;
await R.submitApprove("p1");
check("[핵심] 체크 뒤 승인 → fn_approve_cost_recovery(p_id, p_reason, p_content_reviewed=true) 한 번",
      calls.slice(c1), [["fn_approve_cost_recovery", { p_id: "p1", p_reason: "WING 반품 목록에서 번호·수량 확인", p_content_reviewed: true }]]);
await R.voidRec("a1");
check("승인 취소 → 사유·확인 뒤 fn_void_cost_recovery", calls.at(-1), ["fn_void_cost_recovery", { p_id: "a1", p_reason: "WING 재확인" }]);
const before = calls.length;
R.set({ ...st, isApprover: true }, deps({ reason: "x" })); await R.voidRec("a1");
R.set({ ...st, isApprover: true }, deps({ confirm: false })); await R.voidRec("a1");
R.set({ ...st, isApprover: false }, deps()); await R.voidRec("a1"); await R.approve("p1"); await R.reviewDownload("p1");
const okDl = await R.downloadEvidence(SHA);
check("사유 1자 · 확인창 취소 · 직원(승인·내려받기 시도) → 호출 없음", [calls.length - before, okDl], [0, false]);
R.set({ ...st, isApprover: true }, deps({ clientSha: "ef".repeat(32) }));
const nSaved = saved.length, okBad = await R.downloadEvidence(SHA);
check("받은 파일 해시가 기록과 다르면 저장하지 않고 false", [okBad, saved.length - nSaved, toasts.at(-1).includes("기록과 달라요")], [false, 0, true]);
R.set({ ...st, isApprover: true }, deps({ error: "CEF_INTEGRITY_FAILED: 보관 파일이 업로드 때 해시와 달라요" }));
check("서버 무결성 실패 → 저장 없음 · 안내에는 오류 코드만", [await R.downloadEvidence(SHA), toasts.at(-1)], [false, "근거 파일을 내려받지 못했어요: CEF_INTEGRITY_FAILED"]);

console.log("[4] 제안 - 보관 먼저, 해시가 같을 때만 제안");
const cA = calls.length;
const stW = { ...st, records: [st.records[2]] };      // 무효 기록만 있는 행 = 확인 대기(기록 가능)
R.set({ ...stW, isApprover: false }, deps()); await R.submitPropose(0);
check("[핵심] 제안 = 근거 파일 보관(fn_upload_cm_evidence_file) → 제안(fn_propose_cost_recovery) · 사용자 ID 칸 없음",
      [calls.slice(cA).map(c => c[0]), Object.keys(calls.at(-1)[1].p).filter(k => /_by$|uid|user/.test(k))], [["fn_upload_cm_evidence_file", "fn_propose_cost_recovery"], []]);
const cB = calls.length;
R.set({ ...stW, isApprover: false }, deps({ serverSha: SHA2 })); await R.submitPropose(0);
check("[핵심] DB 가 계산한 해시가 브라우저 해시와 다르면 제안 안 함", [calls.slice(cB).map(c => c[0]), toasts.at(-1).includes("SHA-256 이 이 파일과 달라요")], [["fn_upload_cm_evidence_file"], true]);
R.set({ ...stW, isApprover: false }, deps({ error: "CEF_SIZE: 근거 파일은 1바이트 ~ 5MB 여야 해요" })); await R.submitPropose(0);
check("보관 실패(크기) → 제안 없음 · 안내에는 오류 코드만", toasts.at(-1), "근거 파일을 보관하지 못했어요: CEF_SIZE");
R.set({ ...st, records: [rec("a", "APPROVED", 3)] }, deps()); const c2 = calls.length; await R.submitPropose(0);
check("[핵심] 남은 수량 0인데 제안 → 호출 없이 안내", [calls.length === c2, toasts.at(-1).includes("남은 수량")], [true, true]);
console.log("[5] 회수·손실 확인(v2.7 · cm4) - 0개 · 일부 · 전부 · 출고 전 취소 · 미확인");
check("[핵심] 실제 회수 0개(반품 · 재입고 0) → 입력 통과(0개도 확인 결과)", R.validateProposal({ ...good, qty: "0", wing_restock_qty: "0" }, cand, []), []);
check("회수 수량 빈칸 → 막음(0 과 빈칸은 다름)", R.validateProposal({ ...good, qty: "" }, cand, []).some(x => x.includes("실제 회수 수량")), true);
check("[핵심] 출고 전 취소는 환불 수량 전량만(2/3 막음 · 3/3 통과)",
      [R.validateProposal({ ...good, evidence_type: "WING_CANCEL", qty: "2" }, cand, []).some(x => x.includes("환불 수량 전량")),
       R.validateProposal({ ...good, evidence_type: "WING_CANCEL", qty: "3" }, cand, []).length], [true, 0]);
check("이미 승인·승인 대기 기록이 있는 행은 다시 기록 막음(고치려면 승인 취소 뒤)",
      R.validateProposal({ ...good, qty: "0", wing_restock_qty: "0" }, cand, [rec("z", "APPROVED", 0)]).some(x => x.includes("이미 회수 확인 기록")), true);
const rs = recs => R.rowState(cand, recs);
check("[핵심] 상태: 기록 없음 = 확인 대기 · 승인된 회수 0개 = 확인 완료(손실 3) · 서로 다른 상태",
      [rs([]).kind, rs([rec("z", "APPROVED", 0)]), JSON.stringify(rs([])) === JSON.stringify(rs([rec("z", "APPROVED", 0)]))],
      ["WAIT", { kind: "DONE", preship: false, recovered: 0, loss: 3 }, false]);
check("상태: 일부 2 → 손실 1 · 전부 3 → 손실 0 · 출고 전 취소 → 처리 완료 손실 0 · 승인 대기 → PENDING",
      [rs([rec("p", "APPROVED", 2)]).loss, rs([rec("f", "APPROVED", 3)]).loss, rs([rec("c", "APPROVED", 3, { evidence_type: "WING_CANCEL" })]), rs([rec("q", "PENDING_APPROVAL", 1)]).kind],
      [1, 0, { kind: "DONE", preship: true, recovered: 3, loss: 0 }, "PENDING"]);
const hw = R.panelHtml({ ...st, records: [] }), hz = R.panelHtml({ ...st, records: [rec("z", "APPROVED", 0)] });
check("[핵심] 표: 기록 없음 = '회수·손실 확인 대기 · 손실 우선 0원 · 잠정' + '회수 확인 기록' 버튼 / 회수 0개 승인 = 확인 완료 · 손실 3개 ₩25,500",
      [hw.includes("회수·손실 확인 대기"), hw.includes("손실 우선 0원 · 잠정"), hw.includes("회수 확인 기록</button>"), hz.includes("회수 0개 · 손실 3개 ₩25,500"),
       hz.includes("0 / 3"), hz.includes("₩25,500")], [true, true, true, true, true, true]);
const am = R.approveModalHtml(rec("z", "PENDING_APPROVAL", 0), meta[SHA], userName);
check("승인 검토 창: 실제 회수 수량 / 환불 수량 · 반품 손실 = 3개 × ₩8,500 = ₩25,500", [am.includes("회수·손실 확인 승인 검토"), am.includes("0 / 3 · 손실 3개 × ₩8,500 = ₩25,500")], [true, true]);
check("옛 문구 없음('원가환입 제안'·'승인한 수량만 공헌이익')", [R.panelHtml(st).includes("원가환입 제안"), R.panelHtml(st).includes("승인한 수량만")], [false, false]);
const src = fs.readFileSync(new URL("./js/cm_recovery.js", import.meta.url), "utf8");
check("[보안] 표 직접 쓰기 없음 · 근거 파일 표 직접 읽기 없음 · rpc 이름은 6개 목록에서만",
      [/\.(insert|update|upsert|delete)\(/.test(src), /from\(["']cm_evidence_files/.test(src), [...src.matchAll(/rpc\(([^,)]+)/g)].every(m => m[1].trim().startsWith("RPC.")), Object.values(R.RPC)],
      [false, false, true, ["fn_upload_cm_evidence_file", "fn_cm_evidence_meta", "fn_download_cm_evidence_file", "fn_propose_cost_recovery", "fn_approve_cost_recovery", "fn_void_cost_recovery"]]);
console.log(`\n${n - fail}/${n} 통과`);
process.exit(fail ? 1 : 0);
