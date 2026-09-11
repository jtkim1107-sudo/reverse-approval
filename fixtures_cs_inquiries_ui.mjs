// fixtures_cs_inquiries_ui.mjs
// 2026-09-11 고객문의 화면·알림(js/cs_inquiries.js) 격리 검증 - 익명화 fixture, 네트워크 없음.
import fs from "node:fs";
import vm from "node:vm";

let failures = 0;
function check(ok, label, extra) {
  if (!ok) failures += 1;
  console.log(`${ok ? "OK" : "FAIL"} ${label}`);
  if (!ok && extra !== undefined) console.log("   ", typeof extra === "string" ? extra.slice(0, 400) : JSON.stringify(extra));
}

const src = fs.readFileSync(new URL("./js/cs_inquiries.js", import.meta.url), "utf8");
const appSrc = fs.readFileSync(new URL("./js/app.js", import.meta.url), "utf8");
const indexSrc = fs.readFileSync(new URL("./index.html", import.meta.url), "utf8");
const ctx = { window: {}, Intl, Date, navigator: {} };
vm.createContext(ctx);
vm.runInContext(src, ctx);
const C = ctx.window.CsInquiries;

const NOW = Date.parse("2026-09-11T12:00:00+09:00");
const cs = [
  { source: "product_qna", inquiry_id: "900001", vendor_item_id: "111", product_name: null, content: "받은 휴지통 뚜껑이 파손돼 있어요", status: "unanswered", inquiry_at: "2026-09-11 09:00:00" },
  { source: "callcenter", inquiry_id: "700001", vendor_item_id: "222", product_name: "제습제 500ml", content: "배송이 아직 안 와요 <script>x</script>", status: "unanswered", inquiry_at: "2026-09-10 22:00:00" },
  { source: "product_qna", inquiry_id: "900002", vendor_item_id: "222", product_name: null, content: "가로 30cm 인가요?", status: "unanswered", inquiry_at: "2026-09-10 20:00:00" },
  { source: "product_qna", inquiry_id: "900003", vendor_item_id: "111", product_name: null, content: "재입고 언제", status: "answered", inquiry_at: "2026-09-09 10:00:00" },
];
const ins = [
  { source: "product_qna", inquiry_id: "900001", inquiry_type: "DEFECT", urgency: "HIGH", sentiment: "NEGATIVE", summary: "뚜껑 파손 수령",
    draft_answer: "불편을 드려 죄송합니다. 교환 또는 반품으로 도와드리겠습니다. 처리 방법은 [[확인 후 기재]] 안내드리겠습니다.", draft_source: "ai",
    ai_model: "claude-haiku-4-5", facts_used: { 상품명: "원터치 휴지통 7L", 규격: "7L" }, needs_check: ["파손 사진 확인"], review_status: "NEW" },
  { source: "callcenter", inquiry_id: "700001", inquiry_type: "DELIVERY", urgency: "HIGH", sentiment: "NEGATIVE", summary: "배송 지연",
    draft_answer: "기다리게 해 드려 죄송합니다. 배송 상황은 [[확인 후 기재]] 안내드리겠습니다.", draft_source: "rules",
    facts_used: { 상품명: "제습제 500ml" }, needs_check: [], analysis_note: "AI 미설정 - 규칙 기반 초안", review_status: "NEW" },
  { source: "product_qna", inquiry_id: "900002", inquiry_type: "SPEC", urgency: "LOW", sentiment: "NEUTRAL", summary: "크기",
    draft_answer: "규격은 [[확인 후 기재]]입니다.", draft_source: "rules", review_status: "ACKNOWLEDGED" },
  { source: "product_qna", inquiry_id: "900003", draft_source: "none", review_status: "ANSWERED", answered_source: "coupang" },
];
const okStatus = { job_name: "cs_inquiry_collect", last_success_at: "2026-09-11T02:40:10Z", last_attempt_at: "2026-09-11T02:40:10Z",
  detail: { found: 4, unanswered: 3, range: ["2026-08-29", "2026-09-11"], ai_backend: "rules" } };

const rows = C.merge(cs, ins);

// ── 1. 요약·미처리 ─────────────────────────────────────────────────────────
const s = C.summary(rows, NOW);
check(s.pending === 2 && s.unanswered === 3 && s.urgent === 2, "새 문의(미확인) 2 · 미답변 3 · 긴급 2", s);
check(C.summary(C.merge(cs, []), NOW).pending === 3, "분석 전 미답변도 새 문의로 셈(알림에서 빠지지 않음)");
check(Math.round(C.hoursSince("2026-09-11 09:00:00", NOW)) === 3, "쿠팡 문의 시각(KST 문자열) 경과 시간");

// ── 2. 탭 화면 ─────────────────────────────────────────────────────────────
const html = C.tabHtml({ rows, statusRow: okStatus, now: NOW });
check(html.includes("고객문의 자동수집 정상") && html.includes("문의 4건 확인 · 미답변 3건") && html.includes("2026-08-29~2026-09-11"), "수집 상태 배너: 정상·건수·조회 범위");
check(html.includes("AI 답변 초안") && html.includes("claude-haiku-4-5") && html.includes("[[확인 후 기재]]"), "AI 초안·모델·확인 자리 표시");
check(html.includes("규칙 기반 답변 초안") && html.includes("AI 미설정"), "규칙 초안은 규칙 기반이라고 구분");
check(html.includes("불량·파손") && html.includes("긴급") && html.includes("부정") && html.includes("요약: 뚜껑 파손 수령"), "유형·긴급도·감정·요약 표시");
check(html.includes("확인 필요: 파손 사진 확인") && html.includes("근거 사실: 상품명 원터치 휴지통 7L"), "확인 필요 항목·근거 사실");
check(html.includes("초안 복사") && html.includes("https://wing.coupang.com/tenants/cs/product/inquiries")
  && html.includes("https://wing.coupang.com/tenants/cs/csinquiry") && html.includes('rel="noopener noreferrer"'), "초안 복사 + WING 상품문의·콜센터 문의 바로가기");
check(html.includes("확인 완료") && html.includes("WING 에서 답변함"), "처리 상태 버튼(확인 완료 / WING 에서 답변함)");
check(!/전송<\/button>|등록<\/button>|쿠팡에 등록|submitAnswer|\/replies/.test(html) && html.includes("쿠팡으로 자동 전송하지 않아요"), "쿠팡 전송·등록 버튼 없음 + 자동 전송 안 함 안내");
check(html.includes("약 10시간 안에 답하지 않으면 쿠팡이 자동 답변"), "콜센터 문의 24시간 자동 답변까지 남은 시간");
check(!html.includes("<script>x</script>") && html.includes("&lt;script&gt;"), "문의 본문 이스케이프(HTML 주입 차단)");
const firstOpen = html.indexOf("미답변 문의 3건");
check(firstOpen > 0 && html.indexOf("900001") < html.indexOf("900002"), "새 문의·긴급이 확인 완료보다 먼저");
check((html.match(/확인 완료<\/button>/g) || []).length === 2, "이미 확인 완료한 문의에는 '확인 완료' 버튼 없음");

// ── 3. 새 문의 없음 vs 수집 실패 ─────────────────────────────────────────────
const none = C.tabHtml({ rows: [], statusRow: { ...okStatus, detail: { found: 0, unanswered: 0, range: ["2025-09-12", "2026-09-11"] } }, now: NOW });
check(none.includes("고객문의 자동수집 정상") && none.includes("쿠팡에 문의가 없습니다(조회 성공 · 0건)") && none.includes("새 문의가 없습니다."), "새 문의 0건 = 조회 성공 · 0건");
const failed = C.tabHtml({ rows, statusRow: { ...okStatus, last_attempt_at: "2026-09-11T03:40:00Z", last_error: "HTTPError: 401 Unauthorized" }, now: NOW });
check(failed.includes("고객문의 수집 실패") && failed.includes("401") && failed.includes("지우지 않았어요") && failed.includes("900001"), "수집 실패: 사유 + 기존 문의·초안 그대로 표시");
const failedEmpty = C.tabHtml({ rows: [], statusRow: { ...okStatus, last_attempt_at: "2026-09-11T03:40:00Z", last_error: "timeout" }, now: NOW });
check(failedEmpty.includes("확인하지 못했다") && !failedEmpty.includes("새 문의가 없습니다."), "실패 중 0건은 '문의 없음'이라고 하지 않음");
check(C.tabHtml({ rows: [], statusRow: null, now: NOW }).includes("자동수집 기록이 아직 없습니다"), "수집 기록 없음");
check(C.tabHtml({ rows: [], statusRow: undefined, now: NOW }).includes("확인할 수 없습니다"), "상태 표를 못 읽음");
const stale = C.statusInfo({ ...okStatus, last_success_at: "2026-09-10T20:00:00Z", last_attempt_at: "2026-09-10T20:00:00Z" }, NOW);
check(stale.state === "STALE" && stale.text.includes("3시간 넘게"), "3시간 넘게 확인 없으면 확인 필요");

// ── 4. 알림: 대시보드 · 브리핑 ───────────────────────────────────────────────
const data = { rows, statusRow: okStatus };
const alert = C.dashboardAlertHtml(data);
check(alert.includes("새 문의 2건") && alert.includes("미답변 3건") && alert.includes("긴급 2건") && alert.includes("#/voc/inquiries"), "대시보드 알림(새 문의·미답변·긴급, 고객문의로 이동)");
check(C.dashboardAlertHtml({ rows: C.merge([cs[3]], [ins[3]]), statusRow: okStatus }) === "", "처리할 문의가 없으면 대시보드 알림 없음");
const brief = C.briefingLineHtml(data);
check(brief.includes("새 문의 2건 · 미답변 3건") && brief.includes("가장 오래된 미답변"), "브리핑: 새 문의·미답변 안내");
check(C.briefingLineHtml({ rows: [], statusRow: { ...okStatus, detail: { found: 0 } } }).includes("새 문의·미답변 없음"), "브리핑: 없으면 없음");
check(C.briefingLineHtml({ error: new Error("x") }).includes("불러오지 못했어요"), "브리핑: 못 읽으면 0 이 아니라 확인 안내");

// ── 5. 상태 변경 · 복사 ─────────────────────────────────────────────────────
const updates = [];
ctx.window.sb = { from: (t) => ({ update: (body) => ({ eq: (k1, v1) => ({ eq: async (k2, v2) => { updates.push({ t, body, [k1]: v1, [k2]: v2 }); return { error: null }; } }) }) }) };
ctx.window.route = async () => {}; ctx.window.updateBadge = () => {}; const toasts = []; ctx.window.toast = (m) => toasts.push(m);
C.setUser("장팀장");
C.tabHtml({ rows, statusRow: okStatus, now: NOW });
await C.setStatus("product_qna|900001", "ACKNOWLEDGED");
check(JSON.stringify(updates[0]) === JSON.stringify({ t: "cs_inquiry_insights", body: { review_status: "ACKNOWLEDGED", reviewed_by: "장팀장" }, source: "product_qna", inquiry_id: "900001" }),
  "확인 완료: 처리 상태·처리자만 저장(초안 안 건드림)", updates[0]);
await C.setStatus("product_qna|900001", "NEW");
check(updates.length === 1, "NEW 로 되돌리는 요청은 보내지 않음");
let copied = null;
ctx.navigator.clipboard = { writeText: async (t) => { copied = t; } };
vm.runInContext("navigator = this.navigator", ctx);
await C.copyDraft("product_qna|900001");
check(copied && copied.startsWith("불편을 드려 죄송합니다"), "초안 복사 = 초안 전문", copied);

// ── 6. 앱 연결 ───────────────────────────────────────────────────────────
check(indexSrc.includes('id="badge-voc"') && indexSrc.indexOf("cs_inquiries.js") < indexSrc.indexOf("js/app.js"), "사이드바 배지 + 스크립트 순서");
check(/badge-voc[\s\S]{0,400}CsInquiries\.summary\(data\.rows\)\.pending/.test(appSrc), "사이드바 배지 = 새 문의(미확인) 수");
check(appSrc.includes("CsInquiries.dashboardAlertHtml(csData)") && appSrc.includes("csLine: CsInquiries.briefingLineHtml(csData)"), "대시보드 알림·브리핑 카드 연결");
check(/tab === "reviews" \? renderVocStatusBanner\(\) : Promise\.resolve\(""\)/.test(appSrc), "리뷰 수집 배너는 리뷰 탭에만(고객문의 탭은 자체 수집 상태)");
check(!/답변 <b>등록<\/b> 기능은 아직 연결 전/.test(appSrc), "옛 '답변 등록 기능 연결 전' 안내 제거(대신 초안·WING 바로가기)");
check(!/service_role|sb_secret_|ANTHROPIC|KEYCLOAK/i.test(src), "브라우저 파일에 키 없음");

console.log(failures ? `\n실패 ${failures}건` : "\n전부 통과");
process.exit(failures ? 1 : 0);
