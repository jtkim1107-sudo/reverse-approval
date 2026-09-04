/* ============================================================
   주식회사 리버스 전자결재 시스템 — Supabase 연동 버전
   - 정적 웹앱 (GitHub Pages) + Supabase (DB/인증)
   - 모든 직원이 같은 데이터를 실시간 공유
   ============================================================ */

"use strict";

/* ---------- Supabase 연결 ---------- */
const SUPA_URL = "https://lqdgoqlkfckifqyjhnon.supabase.co";
const SUPA_KEY = "sb_publishable_MV6Ph9WOrv0nzVIvseXlLw_O5WhfQPv"; // publishable key (공개 가능)
const sb = window.supabase.createClient(SUPA_URL, SUPA_KEY);

// 쿠팡 WING 실제 제출 backend (taltal-server, GCP Compute Engine). 이 프론트는
// 여기로 "제출 요청"만 보내고(내 Supabase 로그인 세션 JWT를 그대로 실어서),
// 실제 WING 세션/쿠키/제출 로직은 전부 저 서버 안에서만 처리돼요 - 이 파일에는
// WING 관련 비밀정보가 전혀 없어요.
const WING_SUBMIT_API_BASE = "https://34-30-248-218.sslip.io";

const VAPID_PUBLIC_KEY = "BDGjrHCi-tBEuRwLkJ5HGtuB32VcQNwF69x1T0XJZy4QyUsO7D9RlWEfbVaXL-qQXI9S9JgRGJikX4DkdBFqbf4";

const ACCOUNTS = ["상품매입비", "운반비", "복리후생비", "여비교통비", "접대비", "소모품비", "지급수수료", "광고선전비", "통신비", "차량유지비", "교육훈련비", "기타"];
const PAY_METHODS = ["법인카드", "개인카드(환급)", "계좌이체", "현금"];

/* ---------- 전역 상태 ---------- */
let me = null;      // 내 프로필 {id, name, dept, role, approver}
let USERS = [];     // 전체 프로필
let loginTarget = null;

/* ---------- 유틸 ---------- */
const fmt = n => (Number(n) || 0).toLocaleString("ko-KR");
// 금액 입력칸은 쉼표가 섞여 들어오므로, 읽을 때는 반드시 이걸로 (Number("1,000")은 NaN)
const numOf = v => Number(String(v ?? "").replace(/,/g, "")) || 0;
// 입력칸 초기값용: 값이 있으면 쉼표를 붙이고, 없으면 빈칸
const cfv = v => (v == null || v === "" ? "" : fmt(v));
// class="comma" 입력칸: 숫자를 치는 즉시 1,000,000 식으로 쉼표를 붙인다 (커서 위치 유지)
document.addEventListener("input", e => {
  const el = e.target;
  if (!(el instanceof HTMLInputElement) || !el.classList.contains("comma")) return;
  const before = el.value;
  const caret = el.selectionStart ?? before.length;
  const digitsLeft = before.slice(0, caret).replace(/\D/g, "").length; // 커서 왼쪽의 숫자 개수
  const neg = before.trim().startsWith("-");
  const digits = before.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
  const formatted = digits ? (neg ? "-" : "") + Number(digits).toLocaleString("ko-KR") : (neg ? "-" : "");
  if (formatted === before) return;
  el.value = formatted;
  let pos = 0, seen = 0;
  while (pos < formatted.length && seen < digitsLeft) { if (/\d/.test(formatted[pos])) seen++; pos++; }
  try { el.setSelectionRange(pos, pos); } catch (_) { /* 일부 브라우저 미지원 무시 */ }
});
const pad2 = n => String(n).padStart(2, "0");
// 항상 한국(KST) 기준. 기기 시간대에 의존하면 해외에서 접속했을 때 하루 어긋난 채로 저장됨
const KST = { timeZone: "Asia/Seoul" };
const today = () =>
  new Intl.DateTimeFormat("en-CA", { ...KST, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date());
const nowStr = () => {
  const t = new Intl.DateTimeFormat("en-GB", { ...KST, hour: "2-digit", minute: "2-digit", hour12: false })
    .format(new Date());
  return `${today()} ${t}`;
};
const localDT = ts => {
  const d = new Date(ts);
  if (isNaN(d)) return "";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------- 부가세 ----------
   이익은 반드시 '공급가액(부가세 뺀 금액)' 기준으로 계산해야 합니다.
   판매가에는 부가세가 들어있고 원가에는 안 들어있으면, 그 차액만큼 이익이 부풀려 보입니다. */
let vatCfg = { enabled: true, salePriceIncludesVat: true, purchaseCostIncludesVat: false, expenseIncludesVat: true };
const VAT_RATE = 0.1;
// 부가세가 포함된 금액에서 공급가액만 떼어냄
const netAmt = (amount, included) => {
  const a = Number(amount) || 0;
  return (vatCfg.enabled && included) ? Math.round(a / (1 + VAT_RATE)) : a;
};
// 그 거래에 딸린 부가세.
// 부가세가 포함된 금액이면 빼내고, 별도로 적은 금액이면 그 10%를 따로 주고받은 것
const vatAmt = (amount, included) => {
  if (!vatCfg.enabled) return 0;
  const a = Number(amount) || 0;
  return included ? a - netAmt(a, true) : Math.round(a * VAT_RATE);
};
// 제품 정보를 못 찾으면(삭제된 제품 등) 과세로 간주 — 대부분이 과세라 안전한 기본값
const isTaxable = p => (p?.tax_type || "과세") === "과세";
// 매출: 면세 상품은 부가세가 없으므로 판매가 전체가 공급가액
const saleNet = (amount, p) => (isTaxable(p) ? netAmt(amount, vatCfg.salePriceIncludesVat) : Number(amount) || 0);
const saleVat = (amount, p) => (isTaxable(p) ? vatAmt(amount, vatCfg.salePriceIncludesVat) : 0);
const buyNet = (amount, p) => (isTaxable(p) ? netAmt(amount, vatCfg.purchaseCostIncludesVat) : Number(amount) || 0);
const buyVat = (amount, p) => (isTaxable(p) ? vatAmt(amount, vatCfg.purchaseCostIncludesVat) : 0);
const expNet = amount => netAmt(amount, vatCfg.expenseIncludesVat);
const expVat = amount => vatAmt(amount, vatCfg.expenseIncludesVat);

/* 입력칸 옆에 '부가세 포함/별도'를 항상 붙여 준다 — 이걸 헷갈리면 이익이 10% 틀어짐 */
function vatTag(kind) {
  if (!vatCfg.enabled) return "";
  const inc = { sale: vatCfg.salePriceIncludesVat, buy: vatCfg.purchaseCostIncludesVat, exp: vatCfg.expenseIncludesVat }[kind];
  const label = inc ? "부가세 포함" : "부가세 별도";
  const color = inc ? "#2b8a3e" : "#d9480f";
  const bg = inc ? "#ebfbee" : "#fff4e6";
  const tip = inc
    ? "부가세가 들어 있는 금액으로 입력하세요 (고객에게 받는 금액 / 청구된 금액 그대로)"
    : "부가세를 뺀 금액(공급가액)으로 입력하세요 (세금계산서의 '공급가액')";
  return `<span title="${tip}" style="background:${bg};color:${color};border-radius:5px;padding:1px 6px;font-size:11px;font-weight:700;margin-left:4px">${label}</span>`;
}
// 실제로 오간 현금은 언제나 부가세까지 포함된 금액
const vatTagCash = () => vatCfg.enabled
  ? `<span title="통장에 실제로 오간 금액 그대로 입력하세요" style="background:#ebfbee;color:#2b8a3e;border-radius:5px;padding:1px 6px;font-size:11px;font-weight:700;margin-left:4px">부가세 포함</span>`
  : "";

/* 발주서에 찍히는 우리 회사 정보 */
let companyCfg = { name: "주식회사 리버스", biz_no: "", ceo: "", addr: "", phone: "", email: "" };
async function loadCompanyCfg() {
  const { data } = await sb.from("settings").select("value").eq("key", "company").maybeSingle();
  if (data?.value) companyCfg = { ...companyCfg, ...data.value };
  return companyCfg;
}

let vatCfgLoaded = false;
async function loadVatCfg() {
  const { data, error } = await sb.from("settings").select("value").eq("key", "vat").maybeSingle();
  if (error) { vatCfgLoaded = false; return vatCfg; }  // 실패하면 기본값 — 화면에 경고를 띄운다
  if (data?.value) vatCfg = { ...vatCfg, ...data.value };
  vatCfgLoaded = true;
  return vatCfg;
}
// 설정을 못 불러왔으면 숫자를 믿으면 안 되므로 경고
const vatCfgWarning = () => vatCfgLoaded ? "" : `
  <div style="background:#fff4e6;border:1px solid #ffa94d;border-radius:9px;padding:10px;margin-bottom:12px;font-size:13px">
    ⚠️ 부가세 설정을 불러오지 못해 <b>기본값</b>으로 계산했습니다. 화면을 새로고침해 주세요.</div>`;
const userName = id => (USERS.find(u => u.id === id) || {}).name || "?";
const userRole = id => (USERS.find(u => u.id === id) || {}).role || "";

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add("hidden"), 2400);
}

function docStatusChip(doc) {
  if (doc.status === "approved") return `<span class="chip approved">승인 완료</span>`;
  if (doc.status === "rejected") return `<span class="chip rejected">반려</span>`;
  const cur = doc.approval_line[doc.current_step];
  return `<span class="chip progress">결재 중 (${userName(cur?.userId)})</span>`;
}

/* ---------- 로그인 ---------- */
async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (session) {
    const ok = await enterApp(session.user.id);
    if (ok) return;
  }
  await showLogin();
}

async function showLogin(attempt = 0) {
  document.getElementById("app").classList.add("hidden");
  document.getElementById("login-screen").classList.remove("hidden");
  const { data: profiles, error } = await sb.from("profiles").select("*").order("name");
  const box = document.getElementById("login-users");
  if (error || !profiles?.length) {
    // 서버가 잠시 안 깨어 있을 수 있으므로(무료 플랜 휴면 등) 2·4·8초 간격으로 자동 재시도
    if (attempt < 3) {
      box.innerHTML = `<p style="color:var(--text-sub);font-size:13px">서버에 연결하는 중입니다… (${attempt + 1}/4)</p>`;
      setTimeout(() => showLogin(attempt + 1), 2000 * 2 ** attempt);
    } else {
      box.innerHTML = `
        <p style="color:var(--red);font-size:13px;margin-bottom:10px">서버 연결에 실패했습니다.</p>
        <button class="btn" style="width:100%" onclick="showLogin()">다시 연결</button>`;
    }
  } else {
    USERS = profiles;
    box.innerHTML = profiles.map(u => `
      <button class="login-user-btn" onclick="pickUser('${u.id}')">
        <span class="avatar">${esc(u.name[0])}</span>
        <span><b>${esc(u.name)}</b><small>${esc(u.dept)} · ${esc(u.role)}</small></span>
      </button>`).join("");
  }
}

function pickUser(id) {
  loginTarget = USERS.find(u => u.id === id);
  if (!loginTarget) return;
  document.getElementById("login-users").classList.add("hidden");
  document.getElementById("login-selected").innerHTML =
    `<span class="avatar">${esc(loginTarget.name[0])}</span> ${esc(loginTarget.name)} (${esc(loginTarget.role)})`;
  document.getElementById("login-form").classList.remove("hidden");
  document.getElementById("login-error").textContent = "";
  document.getElementById("login-pw").focus();
}

function resetLoginForm() {
  loginTarget = null;
  document.getElementById("login-form").classList.add("hidden");
  document.getElementById("login-users").classList.remove("hidden");
  document.getElementById("login-pw").value = "";
  document.getElementById("login-error").textContent = "";
}

async function doLogin(ev) {
  ev.preventDefault();
  if (!loginTarget) return false;
  const pw = document.getElementById("login-pw").value;
  const errEl = document.getElementById("login-error");
  errEl.textContent = "";
  const { error } = await sb.auth.signInWithPassword({ email: loginTarget.email, password: pw });
  if (error) {
    errEl.textContent = "비밀번호가 올바르지 않습니다.";
    errEl.className = "login-note error";
    return false;
  }
  await enterApp(loginTarget.id);
  return false;
}

async function enterApp(userId) {
  const { data: profiles, error } = await sb.from("profiles").select("*").order("name");
  if (error || !profiles?.length) return false;
  USERS = profiles;
  me = USERS.find(u => u.id === userId);
  if (!me) { await sb.auth.signOut(); return false; }

  await Promise.all([loadVatCfg(), loadCompanyCfg()]); // 이익 계산 기준이므로 화면을 그리기 전에
  document.getElementById("login-screen").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  document.getElementById("login-pw").value = "";
  renderUserBox();
  if (!location.hash || location.hash === "#/") location.hash = "#/dashboard";
  await route();
  // 이미 알림 권한이 있으면 이 기기 구독을 현재 사용자로 갱신
  if (typeof Notification !== "undefined" && Notification.permission === "granted") {
    ensurePushSubscribed(false);
  }
  return true;
}

/* ---------- 푸시 알림 ---------- */
function urlB64ToUint8Array(s) {
  const pad = "=".repeat((4 - s.length % 4) % 4);
  const raw = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

async function ensurePushSubscribed(interactive) {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || typeof Notification === "undefined") {
    if (interactive) toast("이 브라우저는 알림을 지원하지 않습니다. (아이폰은 홈 화면에 추가 후 앱에서 켜주세요)");
    return false;
  }
  try {
    const reg = await navigator.serviceWorker.ready;
    let perm = Notification.permission;
    if (perm === "default" && interactive) perm = await Notification.requestPermission();
    if (perm !== "granted") {
      if (interactive) toast("알림 권한이 허용되지 않았습니다");
      return false;
    }
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }
    const json = sub.toJSON();
    const { error } = await sb.from("push_subscriptions").upsert(
      { user_id: me.id, endpoint: sub.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth },
      { onConflict: "endpoint" });
    if (error) throw error;
    if (interactive) toast("이 기기에서 알림이 켜졌습니다");
    return true;
  } catch (err) {
    console.error(err);
    if (interactive) toast("알림 설정에 실패했습니다");
    return false;
  }
}

async function logout() {
  await sb.auth.signOut();
  me = null;
  resetLoginForm();
  await showLogin();
}

async function changePassword() {
  const pw = document.getElementById("pw-new").value;
  const pw2 = document.getElementById("pw-new2").value;
  if (pw.length < 6) return toast("비밀번호는 6자 이상이어야 합니다");
  if (pw !== pw2) return toast("두 비밀번호가 일치하지 않습니다");
  const btn = document.getElementById("btn-pw");
  btn.disabled = true;
  const { error } = await sb.auth.updateUser({ password: pw });
  if (error) {
    btn.disabled = false;
    return toast(error.message.includes("different") ? "기존과 다른 비밀번호를 입력하세요" : "변경에 실패했습니다");
  }
  toast("비밀번호가 변경되었습니다");
  document.getElementById("pw-new").value = "";
  document.getElementById("pw-new2").value = "";
  btn.disabled = false;
}

function renderUserBox() {
  document.getElementById("user-avatar").textContent = me.name[0];
  document.getElementById("user-name").textContent = me.name;
  document.getElementById("user-role").textContent = `${me.dept} · ${me.role}`;
  document.getElementById("topbar-user").textContent = `${me.name} (${me.role})`;
}

/* ---------- 데이터 조회 ---------- */
async function fetchDocs(filter) {
  let q = sb.from("documents").select("*").order("created_at", { ascending: false });
  if (filter?.drafter) q = q.eq("drafter_id", filter.drafter);
  if (filter?.status) q = q.eq("status", filter.status);
  const { data, error } = await q;
  if (error) { toast("문서를 불러오지 못했습니다"); return []; }
  return data || [];
}

function inboxOf(docs) {
  return docs.filter(d => d.status === "progress" && d.approval_line[d.current_step]?.userId === me.id);
}

async function updateBadge() {
  const docs = await fetchDocs({ status: "progress" });
  const n = inboxOf(docs).length;
  const b = document.getElementById("badge-inbox");
  b.textContent = n;
  b.classList.toggle("hidden", n === 0);
  // 내가 받은 미완료 업무 지시 수
  const { count } = await sb.from("tasks").select("id", { count: "exact", head: true })
    .eq("assignee_id", me.id).eq("status", "open");
  const tb = document.getElementById("badge-tasks");
  if (tb) {
    tb.textContent = count || 0;
    tb.classList.toggle("hidden", !count);
  }
  // 발주서: 내 결재 차례 + 입고 대기
  const pb = document.getElementById("badge-po");
  if (pb) {
    const { data: pos } = await sb.from("purchase_orders").select("status,approval_line,current_step");
    const n2 = (pos || []).filter(p =>
      (p.status === "progress" && p.approval_line?.[p.current_step]?.userId === me.id) ||
      ["ordered", "partial"].includes(p.status)).length;
    pb.textContent = n2;
    pb.classList.toggle("hidden", !n2);
  }
  // 쿠팡 입고관리: 처리 대기(rgCanDecide()와 동일 조건 - PRE-FLIGHT 통과 +
  // 승인대기 + 미제출) 건수
  const rb = document.getElementById("badge-rginbound");
  if (rb) {
    const { count: rgCount } = await sb.from("inbound_plans").select("id", { count: "exact", head: true })
      .eq("preflight_status", "PASSED").eq("approval_status", "PENDING_APPROVAL").eq("submit_status", "NOT_SUBMITTED");
    rb.textContent = rgCount || 0;
    rb.classList.toggle("hidden", !rgCount);
  }
}

/* ---------- 라우터 ---------- */
const routes = {
  dashboard: { title: "대시보드", render: viewDashboard },
  new: { title: "지출결의서 작성", render: viewNewDoc, after: () => addItemRow() },
  inbox: { title: "결재 대기함", render: viewInbox },
  drafts: { title: "내 기안함", render: viewDrafts },
  docs: { title: "전체 문서함", render: viewAllDocs },
  products: { title: "제품 마스터", render: viewProducts },
  channels: { title: "판매채널·SCM 계정", render: viewChannels },
  suppliers: { title: "매입 거래처", render: viewSuppliers },
  sales: { title: "매출 입력", render: viewSales, after: () => addSaleRow() },
  po: { title: "발주서", render: viewPurchaseOrders },
  podoc: { title: "발주서", render: viewPODoc },
  rginbound: { title: "쿠팡 입고관리", render: viewRgInbound },
  purchases: { title: "매입 입력", render: viewPurchases, after: () => addBuyRow() },
  inventory: { title: "재고 현황", render: viewInventory },
  purchasereco: { title: "발주 추천", render: viewPurchaseReco },
  profit: { title: "공헌이익", render: viewProfit },
  vat: { title: "부가세", render: viewVat },
  report: { title: "월별 리포트", render: viewReport },
  cash: { title: "자금일보", render: viewCash },
  tasks: { title: "업무 지시", render: viewTasks },
  calendar: { title: "공용 일정", render: viewCalendar },
  aireport: { title: "AI 아침 리포트", render: viewAiReport },
  team: { title: "우리 팀 목표", render: viewTeam },
  settings: { title: "설정 · 알림", render: viewSettings },
  doc: { title: "문서 상세", render: viewDocDetail },
  shipmentplans: { title: "입고 물류 최적화", render: viewShipmentPlans },
  stockflow: { title: "재고 · 발주 · 입고", render: viewStockFlow },
};

// 날짜가 바뀌면 화면 기본 날짜도 따라 옮김 (PWA는 며칠씩 안 닫고 쓰기 때문)
let lastKnownDay = today();
function syncTodayState() {
  const now = today();
  if (now === lastKnownDay) return;
  if (cashDate === lastKnownDay) cashDate = now;
  if (erpMonth === lastKnownDay.slice(0, 7)) erpMonth = now.slice(0, 7);
  lastKnownDay = now;
}

let routeSeq = 0;
async function route() {
  if (!me) return;
  const seq = ++routeSeq;
  const hash = location.hash.replace(/^#\//, "") || "dashboard";
  const [name, param] = hash.split("/");
  const r = routes[name] || routes.dashboard;
  syncTodayState(); // 앱을 켜둔 채 자정을 넘겨도 '오늘'이 어제로 굳지 않도록
  document.getElementById("page-title").textContent = r.title;
  document.querySelectorAll(".nav-item").forEach(el =>
    el.classList.toggle("active", el.dataset.route === name));
  const content = document.getElementById("content");
  content.innerHTML = `<div class="card" style="color:var(--text-sub)">불러오는 중…</div>`;
  let html;
  try {
    html = await r.render(param);
  } catch (e) {
    // 화면 그리다 오류가 나면 '불러오는 중…'에서 멈춰 버리므로, 무엇이 잘못됐는지 보여준다
    console.error("화면 오류:", e);
    if (seq !== routeSeq) return;
    content.innerHTML = `
      <div class="card" style="border:2px solid var(--red)">
        <h2 style="color:var(--red)">화면을 여는 중 문제가 생겼습니다</h2>
        <p style="font-size:13.5px;color:var(--text-sub);margin:8px 0 14px">
          데이터를 불러오지 못했거나 일시적인 오류입니다. 아래 버튼으로 다시 시도해 주세요.<br>
          계속 같은 문제가 생기면 이 내용을 알려 주세요: <code style="font-size:12px">${esc(String(e && e.message || e))}</code></p>
        <button class="btn" onclick="route()">다시 시도</button>
        <button class="btn secondary" onclick="location.hash='#/dashboard'">대시보드로</button>
      </div>`;
    closeSidebar();
    return;
  }
  if (seq !== routeSeq) return; // 다른 페이지로 이동한 경우 무시
  content.innerHTML = html;
  if (r.after) r.after(param);
  updateBadge();
  closeSidebar();
  window.scrollTo(0, 0);
}

/* ==================== 우리 팀 목표 (협력형) ====================
   개인 실적을 비교하지 않는다. 주어는 항상 '우리'.
   축은 월 누적 공헌이익 하나, 눈금은 손익분기(자동)와 우리 목표(선택) 둘. */

// 한 달치 팀 상태를 모은다. sumCM/cmOfSale이 전역(erpProducts·erpChannelList)에 의존하므로 loadErpBase가 먼저.
async function loadTeamMonth(month) {
  const { buys, sales } = await loadErpBase();
  const [adRes, fixRes, goalRes, cashRes] = await Promise.all([
    sb.from("ad_costs").select("*"),
    sb.from("fixed_costs").select("*"),
    sb.from("team_goals").select("*").eq("month", month).maybeSingle(),
    sb.from("cash_txns").select("date"),
  ]);
  const ads = adRes.data || [];
  const fixed = (fixRes.data || []).filter(f => f.active !== false);
  const m = computeCmOfMonth(month, sales, ads, fixed);

  const td = today();
  const lastDay = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
  const isThisMonth = month === td.slice(0, 7);
  const elapsed = isThisMonth ? Number(td.slice(8, 10)) : lastDay;
  const remainDays = isThisMonth ? lastDay - elapsed : 0;

  const target = Number(goalRes.data?.cm_target) || 0;
  const dailyTarget = Number(goalRes.data?.daily_sales_target) || 0;

  // 일간 매출 목표가 쌓여 월 매출이 되고, 그 매출이 공헌이익으로 남는다
  const byDay = Object.fromEntries(m.dayRows.map(x => [x.d, x]));
  const recorded = new Set([
    ...sales.map(r => r.date), ...buys.map(r => r.date), ...(cashRes.data || []).map(r => String(r.date)),
  ].filter(d => (d || "").slice(0, 7) === month));
  const days = [];
  for (let i = 1; i <= (isThisMonth ? elapsed : lastDay); i++) {
    const ds = `${month}-${pad2(i)}`;
    const dow = new Date(`${ds}T00:00:00`).getDay();
    const gross = byDay[ds]?.gross || 0;
    days.push({ date: ds, gross, hit: dailyTarget > 0 && gross >= dailyTarget,
                on: recorded.has(ds), weekend: dow === 0 || dow === 6, today: ds === td });
  }
  const covOn = days.filter(d => d.on).length;
  const hitDays = days.filter(d => d.hit).length;

  const monthGross = m.rows.reduce((s, r) => s + cmOfSale(r, m.shipCharged).gross, 0);
  const todayGross = byDay[td]?.gross || 0;
  const todayCm = byDay[td]?.cm || 0;

  // 경험치 = 지금까지 쌓아온 공헌이익 전체 (달이 바뀌어도 유지)
  const allSales = sales.filter(r => (r.date || "") <= td);
  const lifetimeCm = sumCM(allSales).cm - expNet(ads.filter(a => String(a.date) <= td)
    .reduce((s, a) => s + Number(a.amount), 0));
  const level = levelOf(Math.max(0, lifetimeCm));
  const paceTarget = dailyTarget * elapsed;           // 오늘까지 쌓였어야 할 매출
  const monthTarget = dailyTarget * lastDay;          // 이 달 전체 목표

  return { month, isThisMonth, lastDay, elapsed, remainDays, target, dailyTarget,
           goalNote: goalRes.data?.note || "",
           monthGross, todayGross, todayCm, paceTarget, monthTarget, hitDays, lifetimeCm, level,
           cov: { days, on: covOn, elapsed: days.length, rate: days.length ? covOn / days.length : 0 },
           sales, buys, ads, fixed, ...m };
}

// 게이지 축과 눈금 위치 계산
function computeTeamGauge(st) {
  const { cmNet, fixTotal, target } = st;
  let axis = Math.max(fixTotal, target, 1);
  if (cmNet > axis) axis = cmNet;                       // 목표를 넘기면 축을 늘려 100%로 채운다
  const pct = v => Math.max(0, Math.min(100, (v / axis) * 100));
  const hitBep = fixTotal > 0 && cmNet >= fixTotal;
  const hitTarget = target > 0 && cmNet >= target;
  // 다음으로 닿을 지점
  const next = (!hitBep && fixTotal > 0) ? { label: "손익분기", amt: fixTotal }
             : (!hitTarget && target > 0) ? { label: "우리 목표", amt: target }
             : null;
  return {
    axis, hitBep, hitTarget,
    fillPct: cmNet > 0 ? pct(cmNet) : 0,
    fillTone: cmNet < 0 ? "red" : hitTarget || (hitBep && !target) ? "green" : "",
    bepPct: fixTotal > 0 ? pct(fixTotal) : null,
    targetPct: target > 0 ? pct(target) : null,
    nextLabel: next ? next.label : "목표 달성",
    remainAmt: next ? Math.max(0, next.amt - cmNet) : 0,
    needPerDay: next && st.remainDays > 0 ? Math.ceil(Math.max(0, next.amt - cmNet) / st.remainDays) : 0,
  };
}

// 지금 가장 도움 되는 한 문장만. 미달을 비난하지 않고 항상 '다음 한 걸음'으로 끝낸다.
function teamHeadline(st, g, hy) {
  const link = (href, text) => `<a onclick="location.hash='${href}'" style="color:var(--brand);cursor:pointer;font-weight:600">${text} →</a>`;
  if (hy.count) return `지금 이익 숫자에 <b>${hy.count}가지 확인할 점</b>이 있습니다 — ${esc(hy.top.text)} ${link(hy.top.href, "고치러 가기")}`;
  if (st.overdueTasks) return `기한이 지난 우리 일이 <b>${st.overdueTasks}건</b> 남아 있습니다. ${link("#/tasks", "보러 가기")}`;
  // 오늘 목표가 남았으면 오늘 할 일을 먼저 보여준다 (일간 목표가 쌓여 이익이 된다)
  if (st.dailyTarget > 0 && st.isThisMonth) {
    const leftToday = st.dailyTarget - st.todayGross;
    if (leftToday > 0 && st.todayGross > 0)
      return `오늘 <b>₩${fmt(st.todayGross)}</b> — 하루 목표까지 <b>₩${fmt(leftToday)}</b> 남았습니다.`;
    if (leftToday <= 0)
      return `오늘 목표 <b>₩${fmt(st.dailyTarget)}</b>를 채웠습니다. 🔥 ${st.hitDays}일째 달성입니다.`;
  }
  if (g.hitTarget) return `우리 목표 ₩${fmt(st.target)}를 넘었습니다. 남은 ${st.remainDays}일은 그대로 이익입니다. 🏔️`;
  if (g.hitBep) return `손익분기를 넘겼습니다. 지금부터 버는 ₩1은 그대로 우리 이익입니다. 🎉`;
  if (st.cmNet < 0) return `아직 광고비가 먼저 나가는 구간입니다. 매출이 쌓이면 곧 올라옵니다.`;
  if (!st.rows.length && st.dailyTarget > 0)
    return `오늘 목표는 <b>₩${fmt(st.dailyTarget)}</b>입니다. 첫 매출이 기록되면 여기에 쌓이기 시작합니다.`;
  if (!st.rows.length) return `이번 달이 시작됐습니다. 첫 매출이 기록되면 여기에 진척이 나타납니다.`;
  if (g.remainAmt > 0 && st.remainDays > 0) {
    // 이번 달에 못 닿을 것 같으면 절망 대신 다음 지점을 알려준다
    const perDay = st.elapsed > 0 ? st.cmNet / st.elapsed : 0;
    if (perDay > 0 && g.needPerDay > perDay * 2) {
      const daysNeeded = Math.ceil(g.remainAmt / perDay);
      return `${g.nextLabel}까지 <b>₩${fmt(g.remainAmt)}</b> — 이번 달 안에는 빠듯하지만,
        지금 속도면 <b>약 ${daysNeeded}일 뒤</b>에 닿습니다.`;
    }
    return `${g.nextLabel}까지 <b>₩${fmt(g.remainAmt)}</b> —
      남은 ${st.remainDays}일 동안 하루 <b>₩${fmt(g.needPerDay)}</b>씩이면 닿습니다.`;
  }
  return `${st.month} 진행 중입니다. 기록을 채워 주시면 진척이 여기에 쌓입니다.`;
}

/* ---------- 레벨 ----------
   경험치 = 지금까지 쌓은 공헌이익(진짜 남은 돈). 달이 바뀌어도 초기화되지 않고 계속 쌓인다. */
/* 뒤로 갈수록 배율이 커진다(×2.5→×3.3) — 레벨업이 점점 어려워야 오래 재미있다는 대표 주문 */
const LEVELS = [
  { need: 0,             mascot: "🌱", title: "씨앗 상인" },
  { need: 500000,        mascot: "🌿", title: "새싹 상인" },
  { need: 1500000,       mascot: "🪴", title: "자라는 가게" },
  { need: 4000000,       mascot: "🌳", title: "든든한 가게" },
  { need: 10000000,      mascot: "🌲", title: "동네 강자" },
  { need: 25000000,      mascot: "🍎", title: "열매 맺는 가게" },
  { need: 60000000,      mascot: "🏞️", title: "지역 강자" },
  { need: 150000000,     mascot: "⭐", title: "커머스 고수" },
  { need: 400000000,     mascot: "👑", title: "커머스 마스터" },
  { need: 1000000000,    mascot: "🚀", title: "전설의 셀러" },
  { need: 3000000000,    mascot: "💎", title: "다이아 셀러" },
  { need: 10000000000,   mascot: "🐉", title: "커머스 드래곤" },
  { need: 30000000000,   mascot: "🏰", title: "유통 제국" },
  { need: 100000000000,  mascot: "🌌", title: "신화가 된 셀러" },
];

function levelOf(xp) {
  let i = 0;
  for (let k = 0; k < LEVELS.length; k++) if (xp >= LEVELS[k].need) i = k;
  const cur = LEVELS[i], nxt = LEVELS[i + 1] || null;
  const base = cur.need;
  const span = nxt ? nxt.need - base : 1;
  const gained = Math.max(0, xp - base);
  return {
    lv: i + 1, mascot: cur.mascot, title: cur.title,
    xp, gained, span, isMax: !nxt,
    toNext: nxt ? Math.max(0, nxt.need - xp) : 0,
    pct: nxt ? Math.max(0, Math.min(100, (gained / span) * 100)) : 100,
    nextTitle: nxt ? nxt.title : "", nextMascot: nxt ? nxt.mascot : "",
  };
}

/* 일간 매출 목표 → 월 누적 → 공헌이익으로 이어지는 흐름을 한 블록에 보여준다 */
function salesChainHtml(st) {
  if (!st.dailyTarget) return "";
  const todayPct = Math.min(100, Math.round((st.todayGross / st.dailyTarget) * 100));
  const pacePct = st.paceTarget ? Math.min(100, Math.round((st.monthGross / st.paceTarget) * 100)) : 0;
  const monthPct = st.monthTarget ? Math.min(100, Math.round((st.monthGross / st.monthTarget) * 100)) : 0;
  const ahead = st.monthGross - st.paceTarget;          // 목표 페이스 대비 앞섬/뒤처짐
  const convRate = st.monthGross ? (st.cmNet / st.monthGross) * 100 : 0;
  return `
    <div style="margin-bottom:16px">
      <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:6px">
        <span><b>이번 달 누적</b> 매출 <span style="color:var(--text-sub)">(${st.elapsed}일째)</span></span>
        <b>₩${fmt(st.monthGross)} / ₩${fmt(st.monthTarget)}</b></div>
      <div class="bar-wrap" style="padding-bottom:24px">
        <div class="bar bar-lg"><div class="bar-fill ${monthPct >= 100 ? "green" : ahead >= 0 ? "" : "amber"}" style="width:${monthPct}%"></div></div>
        ${st.paceTarget && st.monthTarget ? `<div class="bar-mark" style="left:${Math.min(100, (st.paceTarget / st.monthTarget) * 100)}%">
          <span>오늘까지 목표 ₩${fmt(st.paceTarget)}</span></div>` : ""}
        ${st.paceTarget && st.monthTarget ? `<div class="bar-legend">
          <span><i>│</i> 오늘까지 목표 ₩${fmt(st.paceTarget)}</span></div>` : ""}
      </div>
      <p style="font-size:13px;color:var(--text-sub);margin-top:2px">
        ${(() => {
          if (ahead >= 0) return `목표 속도보다 <b style="color:var(--green)">₩${fmt(ahead)} 앞서</b> 있습니다.`;
          const need = Math.ceil((st.monthTarget - st.monthGross) / Math.max(1, st.remainDays));
          // 따라잡으려면 하루 목표의 2배가 넘게 필요하면, 무리한 숫자 대신 지금 속도로 도달할 지점을 보여준다
          if (st.remainDays > 0 && need <= st.dailyTarget * 2)
            return `목표 속도까지 <b style="color:var(--amber)">₩${fmt(-ahead)}</b> — 남은 ${st.remainDays}일에 하루 ₩${fmt(need)}씩이면 월 목표에 닿습니다.`;
          const avg = st.elapsed > 0 ? Math.round(st.monthGross / st.elapsed) : 0;
          const projected = avg * st.lastDay;
          return `지금 속도(하루 평균 <b>₩${fmt(avg)}</b>)면 이 달은 <b>₩${fmt(projected)}</b> 정도가 됩니다.
            내일 하루 목표부터 다시 채워 가면 됩니다.`;
        })()}
        · 목표 채운 날 <b>${st.hitDays}일</b>
      </p>
    </div>

    <div style="background:var(--brand-light);border-radius:9px;padding:12px 14px;font-size:13.5px;line-height:1.7;margin-bottom:16px">
      매출 <b>₩${fmt(st.monthGross)}</b> → 원가·수수료·배송비·광고비를 빼고
      <b style="color:${st.cmNet >= 0 ? "var(--green)" : "var(--red)"}">₩${fmt(st.cmNet)}</b>가 남았습니다
      ${st.monthGross ? `<span style="color:var(--text-sub)">(매출의 ${convRate.toFixed(1)}%)</span>` : ""}<br>
      <span style="color:var(--text-sub)">이 남은 돈이 아래 게이지를 채웁니다.</span>
    </div>`;
}

// 흩어져 있던 데이터 위생 경고를 한곳에 모은다 (급한 순서)
function collectHygiene(st) {
  const items = [];
  const add = (n, text, href) => { if (n > 0) items.push({ n, text, href }); };
  add(st.t.noCostRows, `원가가 비어 있는 매출 ${st.t.noCostRows}줄`, "#/products");
  add(st.t.unknownChannels.size,
      `채널 목록에 없는 이름 ${st.t.unknownChannels.size}개 (${[...st.t.unknownChannels].join(", ")})`, "#/channels");
  // 이동 기록 없이 팔린 쿠팡 재고 — 지금까지 계산만 되고 어디에도 표시되지 않던 신호
  const untracked = Object.entries(erpStock).filter(([, s]) => (s.coupangUntracked || 0) > 0);
  if (untracked.length) items.push({
    n: untracked.length,
    text: `이동 기록 없이 팔린 쿠팡 재고 ${fmt(untracked.reduce((s, [, x]) => s + x.coupangUntracked, 0))}개`,
    href: "#/inventory",
  });
  // 위탁 상품(공급처 재고)과 연동 세트(낱개에서 파생)는 재고를 갖지 않으므로 마이너스 점검에서 제외
  const negStock = erpProducts.filter(p => tradeTypeOf(p) === "사입" && !isSetProd(p)
    && ((erpStock[p.id]?.stock ?? 0) < 0 || (erpStock[p.id]?.inHouse ?? 0) < 0)).length;
  add(negStock, `마이너스가 된 재고 ${negStock}종`, "#/inventory");
  add(erpChannelList.filter(c => !Number(c.fee_rate)).length,
      `수수료율이 비어 있는 채널 ${erpChannelList.filter(c => !Number(c.fee_rate)).length}개`, "#/channels");
  // 연동 세트상품은 낱개 원가에서 자동 계산되므로 제외 (낱개에 원가가 없으면 낱개 쪽이 잡힌다)
  add(erpProducts.filter(p => tradeTypeOf(p) === "사입" && !isSetProd(p) && !p.cost_price).length,
      `원가가 없는 사입 상품 ${erpProducts.filter(p => tradeTypeOf(p) === "사입" && !isSetProd(p) && !p.cost_price).length}종`, "#/products");
  // 광고비율(광고비 ÷ 매출)이 기준치를 넘으면 경보 — 기준은 회사 설정, 기본 15%
  const adLimit = Number(companyCfg.ad_ratio_limit) || 15;
  if (st.monthGross > 0 && st.adGross > 0) {
    const adRatio = (st.adGross / st.monthGross) * 100;
    if (adRatio >= adLimit) items.push({
      n: 1, text: `광고비율 ${adRatio.toFixed(1)}% — 기준 ${adLimit}% 초과 (광고비 ₩${fmt(st.adGross)} / 매출 ₩${fmt(st.monthGross)})`,
      href: "#/profit",
    });
  }
  return { count: items.length, items, top: items[0] || null };
}

const TEAM_BADGES = [
  { kind: "first_sale", ico: "🌱", label: "첫 매출", tip: "이번 달 첫 매출이 기록되면" },
  { kind: "bep", ico: "🎉", label: "손익분기", tip: "공헌이익이 월 고정비를 넘으면" },
  { kind: "cm_target", ico: "🏔️", label: "목표 달성", tip: "우리가 정한 목표에 닿으면" },
  { kind: "clean_data", ico: "🔍", label: "숫자 정확", tip: "확인할 점이 하나도 없으면" },
  { kind: "coverage", ico: "🔥", label: "꾸준한 달성", tip: "하루 매출 목표를 절반 이상의 날에 달성하면" },
];

function teamBadgeStates(st, g, hy) {
  const on = {
    first_sale: st.rows.length > 0,
    bep: g.hitBep,
    cm_target: g.hitTarget,
    clean_data: hy.count === 0 && st.rows.length > 0,
    // 하루 목표를 절반 이상의 날에 달성 (기록 충실보다 실제 성과에 가까운 지표)
    coverage: st.dailyTarget > 0 && st.elapsed >= 7 && st.hitDays >= Math.ceil(st.elapsed / 2),
  };
  return TEAM_BADGES.map(b => ({ ...b, on: !!on[b.kind] }));
}

/* 축하 — 같은 마일스톤이 두 번 뜨지 않게 3중으로 막는다.
   ① DB unique(kind,period)  ② ignoreDuplicates로 '새로 딴 것'만 회수  ③ seen_by로 사람별 1회 */
async function claimMilestones(st, g, hy) {
  const on = teamBadgeStates(st, g, hy).filter(b => b.on);
  const rows = on.map(b => ({ kind: b.kind, period: st.month, value: st.cmNet }));
  // 레벨업은 평생 1회 — period를 'all'로 두면 unique(kind,period)가 중복을 막는다
  if (st.level.lv > 1) rows.push({ kind: `level_${st.level.lv}`, period: "all", value: st.level.xp });
  if (!rows.length) return [];
  const { data, error } = await sb.from("team_milestones")
    .upsert(rows, { onConflict: "kind,period", ignoreDuplicates: true })
    .select("*");
  if (error) { console.error("마일스톤:", error); return []; }   // 축하 실패가 업무를 막으면 안 됨
  return data || [];
}

const MILESTONE_TEXT = {
  first_sale: { ico: "🌱", head: "이번 달 첫 매출이 기록되었습니다",
    body: m => `${String(m.period)}의 시작입니다. 여기서부터 쌓아 올리면 됩니다.` },
  bep: { ico: "🎉", head: "우리 팀이 손익분기를 넘었습니다",
    body: m => `공헌이익이 이번 달 고정비를 넘어섰습니다. 지금부터 버는 ₩1은 그대로 우리 이익입니다.` },
  cm_target: { ico: "🏔️", head: "우리가 정한 목표에 닿았습니다",
    body: m => `₩${fmt(m.value)}까지 왔습니다. 남은 날은 덤입니다.` },
  clean_data: { ico: "🔍", head: "지금 숫자는 그대로 믿어도 됩니다",
    body: () => `원가·채널·재고 어디에도 어긋난 곳이 없습니다. 이익 숫자를 그대로 판단에 쓰셔도 됩니다.` },
  coverage: { ico: "🔥", head: "하루 목표를 절반 넘게 채우고 있습니다",
    body: () => `매일의 목표가 쌓여 이번 달 이익이 됩니다. 지금 속도가 가장 큰 자산입니다.` },
};

async function fetchCelebrations(month) {
  // 최근 7일 이내에 달성했고, 내가 아직 확인하지 않은 것 (밤에 상대가 달성해도 다음 날 내가 본다)
  const { data } = await sb.from("team_milestones").select("*").in("period", [month, "all"]);
  const week = Date.now() - 7 * 86400000;
  return (data || []).filter(m =>
    !(m.seen_by || []).includes(me.id) && new Date(m.achieved_at).getTime() > week);
}

function celebrationHtml(list) {
  return list.map(m => {
    // 레벨업 축하는 전용 카드로 크게
    if (String(m.kind).startsWith("level_")) {
      const lv = Number(String(m.kind).slice(6));
      const info = LEVELS[lv - 1] || LEVELS[0];
      const prev = LEVELS[lv - 2] || LEVELS[0];
      return `
        <div class="gcard done" style="text-align:center">
          <div style="font-size:13px;font-weight:800;opacity:.9;letter-spacing:1px">LEVEL UP!</div>
          <div style="font-size:52px;margin:10px 0;line-height:1">
            <span style="opacity:.5">${prev.mascot}</span>
            <span style="font-size:26px;opacity:.7"> → </span>
            <span class="gmascot" style="display:inline-block;font-size:56px">${info.mascot}</span>
          </div>
          <div style="font-size:24px;font-weight:900">LV.${lv} ${esc(info.title)}</div>
          <p style="font-size:14px;opacity:.95;margin:10px 0 16px;line-height:1.7">
            쌓아온 공헌이익이 <b>₩${fmt(m.value)}</b>을 넘었습니다.<br>두 분이 함께 만든 결과입니다. 🎊</p>
          <button class="btn" style="background:#fff;color:var(--green)" onclick="dismissCelebration('${m.id}')">좋아요!</button>
        </div>`;
    }
    const t = MILESTONE_TEXT[m.kind];
    if (!t) return "";
    return `
      <div class="card celebrate">
        <h2>${t.ico} ${esc(t.head)}</h2>
        <p style="font-size:14px;line-height:1.75;margin:6px 0 14px">${esc(t.body(m))}</p>
        <div class="modal-actions" style="margin-top:0">
          <button class="btn secondary" onclick="location.hash='#/profit'">숫자 보기</button>
          <button class="btn green" onclick="dismissCelebration('${m.id}')">확인</button>
        </div>
      </div>`;
  }).join("");
}

async function dismissCelebration(id) {
  const { data } = await sb.from("team_milestones").select("seen_by").eq("id", id).maybeSingle();
  const seen = [...new Set([...(data?.seen_by || []), me.id])];
  const { error } = await sb.from("team_milestones").update({ seen_by: seen }).eq("id", id).select("id");
  if (error) return toast("처리에 실패했습니다");
  route();
}

/* 레벨 히어로 카드 — 경험치가 차오르고 레벨이 오르는 게임 화면 */
function levelHeroHtml(st, g, compact) {
  const L = st.level;
  const dayPct = st.dailyTarget ? Math.min(100, Math.round((st.todayGross / st.dailyTarget) * 100)) : 0;
  return `
    <div class="gcard ${L.isMax || g.hitTarget ? "done" : ""}">
      <div class="gcard-head">
        <span class="gmascot">${L.mascot}</span>
        <div style="flex:1;min-width:0">
          <div class="glevel">LV.${L.lv} · 주식회사 리버스</div>
          <div class="gtitle">${esc(L.title)}</div>
        </div>
        <div class="team-avatars">${USERS.map(u =>
          `<span class="avatar" title="${esc(u.name)}">${esc(u.name[0])}</span>`).join("")}</div>
        ${compact ? `<button class="btn sm" style="background:rgba(255,255,255,.22);color:#fff"
          onclick="location.hash='#/team'">자세히</button>` : ""}
      </div>

      <div class="gbar-row">
        <div class="gbar-label">
          <span>경험치 (쌓은 공헌이익)</span>
          <span>${L.isMax ? "MAX" : `다음 레벨까지 ₩${fmt(L.toNext)}`}</span>
        </div>
        <div class="gbar">
          <div class="gbar-fill ${L.isMax ? "full" : ""}" style="width:${L.pct}%"></div>
          <span class="gbar-pct">₩${fmt(L.xp)}</span>
        </div>
        <div class="gsub">
          ${L.isMax
            ? `최고 레벨에 도달했습니다. 🎊`
            : `${L.nextMascot} <b>LV.${L.lv + 1} ${esc(L.nextTitle)}</b>까지 <b>${Math.round(L.pct)}%</b> 왔습니다.`}
          ${st.todayCm > 0 ? ` · 오늘 <b>+₩${fmt(st.todayCm)}</b> 획득` : ""}
        </div>
      </div>

      ${st.dailyTarget ? `
      <div class="gbar-row">
        <div class="gbar-label">
          <span>오늘의 매출 목표</span>
          <span>₩${fmt(st.todayGross)} / ₩${fmt(st.dailyTarget)}</span>
        </div>
        <div class="gbar">
          <div class="gbar-fill ${dayPct >= 100 ? "full" : ""}" style="width:${dayPct}%"></div>
          <span class="gbar-runner" style="left:${Math.max(4, Math.min(96, dayPct))}%">${dayPct >= 100 ? "🎉" : "🏃"}</span>
        </div>
        <div class="gsub">${dayPct >= 100
          ? `오늘 목표 달성! 🔥 이번 달 <b>${st.hitDays}일째</b> 채웠습니다.`
          : `목표까지 <b>₩${fmt(st.dailyTarget - st.todayGross)}</b> 남았습니다.`}</div>
      </div>` : ""}
    </div>`;
}

// 오늘 할 일을 퀘스트 카드로 (전부 실제 업무와 연결된 것만)
function questsHtml(st, g, hy) {
  const q = [];
  if (st.dailyTarget) q.push({ done: st.todayGross >= st.dailyTarget, ico: "💰",
    title: `오늘 매출 ₩${fmt(st.dailyTarget)} 채우기`,
    desc: st.todayGross >= st.dailyTarget ? `달성! ₩${fmt(st.todayGross)}` : `지금 ₩${fmt(st.todayGross)} · ₩${fmt(st.dailyTarget - st.todayGross)} 남음`,
    href: "#/sales" });
  q.push({ done: hy.count === 0, ico: "🔍",
    title: "숫자 정확하게 만들기",
    desc: hy.count === 0 ? "확인할 점이 없습니다" : `${hy.count}가지 남음 — ${hy.top.text}`,
    href: hy.count ? hy.top.href : "#/team" });
  q.push({ done: !st.overdueTasks, ico: "✅",
    title: "기한 지난 업무 없애기",
    desc: st.overdueTasks ? `${st.overdueTasks}건 밀려 있습니다` : "밀린 업무가 없습니다",
    href: "#/tasks" });
  if (st.fixTotal) q.push({ done: g.hitBep, ico: "🎉",
    title: "이번 달 손익분기 넘기기",
    desc: g.hitBep ? "넘겼습니다! 이제 버는 만큼 이익입니다" : `₩${fmt(Math.max(0, st.fixTotal - st.cmNet))} 남음`,
    href: "#/profit" });
  const doneCnt = q.filter(x => x.done).length;
  return `
    <div class="card">
      <div class="card-head"><h2>📋 오늘의 퀘스트</h2>
        <span class="chip ${doneCnt === q.length ? "approved" : "progress"}">${doneCnt} / ${q.length} 완료</span></div>
      <div class="quests">${q.map(x => `
        <div class="quest ${x.done ? "done" : ""}" onclick="location.hash='${x.href}'">
          <span class="quest-ico">${x.ico}</span>
          <div class="quest-body">
            <div class="quest-title">${esc(x.title)}</div>
            <div class="quest-desc">${esc(x.desc)}</div>
          </div>
          <span class="quest-check">✓</span>
        </div>`).join("")}</div>
    </div>`;
}

function teamCardHtml(st, g, hy, compact) {
  const badges = teamBadgeStates(st, g, hy);
  return `
    ${levelHeroHtml(st, g, compact)}
    <div class="card team-card ${g.hitTarget || (g.hitBep && !st.target) ? "done" : ""}">
      <div class="card-head">
        <h2>🎯 ${st.month} 우리 팀</h2>
      </div>
      ${vatCfgWarning()}
      <p style="font-size:15px;line-height:1.75;margin-bottom:16px">${teamHeadline(st, g, hy)}</p>

      ${salesChainHtml(st)}

      ${st.fixTotal || st.target ? `
      <div style="font-size:13px;margin-bottom:2px"><b>쌓인 공헌이익</b></div>
      <div class="bar-wrap">
        <div class="bar bar-lg"><div class="bar-fill ${g.fillTone}" style="width:${g.fillPct}%"></div></div>
        ${g.bepPct != null ? `<div class="bar-mark" style="left:${g.bepPct}%"><span>손익분기 ₩${fmt(st.fixTotal)}</span></div>` : ""}
        ${g.targetPct != null ? `<div class="bar-mark" style="left:${g.targetPct}%"><span>우리 목표 ₩${fmt(st.target)}</span></div>` : ""}
        <div class="bar-legend">
          ${g.bepPct != null ? `<span><i>│</i> 손익분기 ₩${fmt(st.fixTotal)}</span>` : ""}
          ${g.targetPct != null ? `<span><i>│</i> 우리 목표 ₩${fmt(st.target)}</span>` : ""}
        </div>
      </div>` : ""}

      <div class="grid-stats" style="margin-bottom:0">
        ${st.dailyTarget ? `<div class="stat" onclick="location.hash='#/sales'">
          <div class="stat-label">오늘 남은 매출</div>
          <div class="stat-value ${st.todayGross >= st.dailyTarget ? "green" : "amber"}">
            ${st.todayGross >= st.dailyTarget ? "달성 🔥" : "₩" + fmt(st.dailyTarget - st.todayGross)}</div></div>` : ""}
        <div class="stat" onclick="location.hash='#/profit'">
          <div class="stat-label">지금까지 우리가 남긴 돈</div>
          <div class="stat-value ${st.cmNet >= 0 ? "blue" : "red"}">₩${fmt(st.cmNet)}</div></div>
        ${st.fixTotal || st.target ? `<div class="stat" onclick="location.hash='#/team'">
          <div class="stat-label">${esc(g.nextLabel)}까지</div>
          <div class="stat-value ${g.remainAmt <= 0 ? "green" : "amber"}">
            ${g.remainAmt <= 0 ? "넘었습니다" : "₩" + fmt(g.remainAmt)}</div></div>` : ""}
        <div class="stat" onclick="location.hash='#/team'">
          <div class="stat-label">이번 달 남은 날</div>
          <div class="stat-value">${st.remainDays}일</div></div>
      </div>

      <div class="coins" style="margin-top:16px">${badges.map(b =>
        `<div class="coin ${b.on ? "on" : ""}" title="${esc(b.tip)}">
          <div class="coin-disc">${b.ico}</div><div class="coin-label">${b.label}</div></div>`).join("")}</div>

      ${!st.fixTotal && !st.target ? `<p style="font-size:12.5px;color:var(--text-sub);margin-top:12px">
        ℹ️ 월 고정비를 등록하면 손익분기선이 생기고, 목표를 정하면 두 번째 눈금이 생깁니다.
        <a onclick="location.hash='#/team'" style="color:var(--brand);cursor:pointer;font-weight:600">시작하기 →</a></p>` : ""}
    </div>`;
}

async function viewTeam() {
  const month = today().slice(0, 7);
  const st = await loadTeamMonth(month);
  const { data: taskRows } = await sb.from("tasks").select("status,due_date");
  st.overdueTasks = (taskRows || []).filter(t => t.status === "open" && t.due_date && t.due_date < today()).length;
  const g = computeTeamGauge(st);
  const hy = collectHygiene(st);
  const badges = teamBadgeStates(st, g, hy);
  await claimMilestones(st, g, hy);
  const cel = await fetchCelebrations(month);

  // 최근 6개월 되돌아보기 (viewReport와 같은 방식)
  const months = [];
  const now = new Date();
  for (let i = 0; i < 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}`);
  }
  const history = months.map(mm => {
    const c = computeCmOfMonth(mm, st.sales, st.ads, st.fixed);
    return { month: mm, cm: c.cmNet, bepHit: c.fixTotal > 0 && c.cmNet >= c.fixTotal, hasFix: c.fixTotal > 0 };
  });

  const suggested = st.fixTotal ? Math.round(st.fixTotal * 1.5 / 100000) * 100000 : 1000000;
  const dayNum = Number(today().slice(8, 10));

  return `
    ${celebrationHtml(cel)}
    ${teamCardHtml(st, g, hy, false)}
    ${questsHtml(st, g, hy)}

    ${!st.dailyTarget ? `
    <div class="card" style="border-left:4px solid var(--amber)">
      <p style="font-size:14px;margin-bottom:10px">${st.month} 하루 매출 목표를 정할까요?
        매일의 목표가 쌓여 이번 달 이익이 됩니다.</p>
      <button class="btn" onclick="openTeamGoalModal('${st.month}', ${st.target || 0}, ${st.fixTotal}, 1000000)">목표 정하기</button>
    </div>` : ""}

    <div class="card">
      <div class="card-head"><h2>🎯 목표 설정</h2>
        <button class="btn sm secondary" onclick="openTeamGoalModal('${st.month}', ${st.target || suggested}, ${st.fixTotal}, ${st.dailyTarget || 1000000})">
          목표 바꾸기</button></div>
      <div class="table-wrap"><table>
        <tbody>
          <tr><td><b>하루 매출 목표</b> ${vatTagCash()}<br>
            <small style="color:var(--text-sub)">매일 이만큼씩 쌓는 것이 출발점입니다</small></td>
            <td class="num" style="font-size:18px;font-weight:800">${st.dailyTarget ? "₩" + fmt(st.dailyTarget) : "—"}</td></tr>
          <tr><td>↳ 이 달 전체로는 (${st.lastDay}일)</td>
            <td class="num">₩${fmt(st.monthTarget)}</td></tr>
          <tr><td><b>월 공헌이익 목표</b>
            <span style="background:#fff4e6;color:#d9480f;border-radius:5px;padding:1px 6px;font-size:11px;font-weight:700;margin-left:4px">부가세 제외</span><br>
            <small style="color:var(--text-sub)">매출에서 원가·수수료·배송비·광고비를 뺀 뒤 남는 돈</small></td>
            <td class="num" style="font-size:18px;font-weight:800">${st.target ? "₩" + fmt(st.target) : "미설정"}</td></tr>
          <tr><td>↳ 손익분기 (월 고정비)</td>
            <td class="num">${st.fixTotal ? "₩" + fmt(st.fixTotal) : '<span style="color:var(--text-sub)">미등록</span>'}</td></tr>
        </tbody>
      </table></div>
      ${st.goalNote ? `<p style="font-size:13px;color:var(--text-sub);margin-top:10px">📝 ${esc(st.goalNote)}</p>` : ""}
      ${!st.fixTotal ? `<p style="font-size:13px;color:var(--text-sub);margin-top:10px">
        고정비를 등록하면 손익분기선이 표시됩니다.
        <a onclick="location.hash='#/profit'" style="color:var(--brand);cursor:pointer;font-weight:600">등록하기 →</a></p>` : ""}
    </div>

    <div class="card">
      <div class="card-head"><h2>🔥 하루 목표 달성한 날</h2>
        <span class="chip ${st.hitDays >= st.elapsed * 0.5 ? "approved" : "waiting"}">${st.hitDays} / ${st.elapsed}일</span></div>
      <p style="font-size:13px;color:var(--text-sub)">
        진한 초록 = 목표(₩${fmt(st.dailyTarget)}) 달성 · 연한 초록 = 매출 있음 · 회색 = 없음</p>
      <div class="daydots">${st.cov.days.map(d =>
        `<span class="daydot ${d.hit ? "on" : d.gross > 0 ? "half" : ""} ${d.weekend ? "weekend" : ""} ${d.today ? "today" : ""}"
          title="${d.date} · ₩${fmt(d.gross)}${d.hit ? " · 목표 달성" : ""}"></span>`).join("")}</div>
      <p style="font-size:12.5px;color:var(--text-sub);margin-top:12px">
        기록 자체가 있던 날은 <b>${st.cov.on}/${st.cov.elapsed}일</b>입니다.
        회색이 이어지면 <b>실제로 거래가 없던 날인지</b> 확인해 주세요 — 매출 누락은 이렇게 잡힙니다.</p>
    </div>

    <div class="card">
      <div class="card-head"><h2>🔍 숫자를 믿을 수 있는 상태인가</h2>
        ${hy.count === 0
          ? '<span class="chip approved">✔ 지금 숫자는 그대로 믿어도 됩니다</span>'
          : `<span class="chip progress">확인할 점 ${hy.count}가지</span>`}</div>
      ${hy.count === 0 ? `
        <p style="font-size:13.5px;color:var(--text-sub)">
          원가·채널·재고 어디에도 어긋난 곳이 없습니다. 이 상태라면 이익 숫자를 그대로 판단에 쓰셔도 됩니다.</p>` : `
        <p style="font-size:13.5px;color:var(--text-sub);margin-bottom:12px">
          하나씩 고칠 때마다 이익 숫자가 정확해집니다. 급한 순서입니다.</p>
        <div class="table-wrap"><table><tbody>${hy.items.map(it => `
          <tr class="clickable" onclick="location.hash='${it.href}'">
            <td>${esc(it.text)}</td>
            <td class="num" style="width:110px"><span class="chip progress">확인 →</span></td>
          </tr>`).join("")}</tbody></table></div>`}
    </div>

    <div class="card">
      <h2>🏅 이번 달 배지</h2>
      <div class="coins" style="margin-top:12px">${badges.map(b =>
        `<div class="coin ${b.on ? "on" : ""}" title="${esc(b.tip)}">
          <div class="coin-disc">${b.ico}</div><div class="coin-label">${b.label}</div></div>`).join("")}</div>
      <p style="font-size:12.5px;color:var(--text-sub);margin-top:14px">
        회색은 아직 못 딴 배지입니다. 달이 바뀌면 모두 초기화되고 다시 도전합니다.</p>
    </div>

    <div class="card">
      <h2>🎮 레벨</h2>
      <p style="font-size:13.5px;color:var(--text-sub);margin-bottom:14px">
        레벨은 <b>지금까지 쌓아온 공헌이익</b>으로 오릅니다. 달이 바뀌어도 초기화되지 않고 계속 쌓입니다.<br>
        현재 <b>LV.${st.level.lv} ${esc(st.level.title)}</b> · 누적 <b>₩${fmt(st.level.xp)}</b></p>
      <div class="table-wrap"><table>
        <thead><tr><th style="width:60px">레벨</th><th>칭호</th><th class="num">필요 누적 공헌이익</th></tr></thead>
        <tbody>${LEVELS.map((l, i) => {
          const lv = i + 1, cur = lv === st.level.lv, got = st.level.xp >= l.need;
          return `<tr ${cur ? 'style="background:var(--brand-light)"' : ""}>
            <td><b>${l.mascot} LV.${lv}</b></td>
            <td>${esc(l.title)}${cur ? ' <span class="chip mine">지금</span>' : ""}</td>
            <td class="num" style="${got ? "color:var(--green);font-weight:700" : "color:var(--text-sub)"}">
              ${l.need ? "₩" + fmt(l.need) : "시작"}${got && !cur ? " ✔" : ""}</td>
          </tr>`; }).join("")}
        </tbody>
      </table></div>
    </div>

    <div class="card">
      <h2>📈 지난 6개월</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>월</th><th class="num">공헌이익</th><th>손익분기</th></tr></thead>
        <tbody>${history.map(h => `
          <tr ${h.month === st.month ? 'style="background:var(--brand-light)"' : ""}>
            <td><b>${h.month}</b>${h.month === st.month ? ' <span class="chip mine">이번 달</span>' : ""}</td>
            <td class="num" style="color:${h.cm >= 0 ? "var(--green)" : "var(--red)"}">₩${fmt(h.cm)}</td>
            <td>${!h.hasFix ? '<span style="color:var(--text-sub)">—</span>'
              : h.bepHit ? '<span class="chip approved">넘김</span>' : '<span class="chip waiting">아직</span>'}</td>
          </tr>`).join("")}
        </tbody>
      </table></div>
      <p style="font-size:12px;color:var(--text-sub);margin-top:10px">
        ※ 손익분기는 <b>현재 등록된 고정비</b> 기준으로 계산합니다. 과거에 고정비가 달랐다면 실제와 차이가 날 수 있습니다.</p>
    </div>`;
}

function openTeamGoalModal(month, cmTarget, fixTotal, dailyTarget) {
  const lastDay = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
  document.getElementById("modal-root").innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal">
        <h3>🎯 ${month} 우리 목표</h3>
        <div class="form-grid">
          <div class="field full"><label>하루 매출 목표(원) *${vatTagCash()}</label>
            <input id="tg-daily" type="text" inputmode="numeric" class="comma" value="${fmt(dailyTarget || 1000000)}"
              oninput="document.getElementById('tg-monthly').textContent='₩'+fmt(numOf(this.value)*${lastDay})">
            <p style="font-size:12px;color:var(--text-sub);margin-top:4px">
              고객이 실제로 결제한 금액 기준입니다. 이 달(${lastDay}일)이면 모두 <b id="tg-monthly">₩${fmt((dailyTarget || 1000000) * lastDay)}</b>가 됩니다.</p></div>
          <div class="field full"><label>월 공헌이익 목표(원)
            <span style="background:#fff4e6;color:#d9480f;border-radius:5px;padding:1px 6px;font-size:11px;font-weight:700;margin-left:4px">부가세 제외</span></label>
            <input id="tg-amt" type="text" inputmode="numeric" class="comma" value="${cmTarget ? fmt(cmTarget) : ""}" placeholder="아직 정하지 않아도 됩니다">
            <p style="font-size:12px;color:var(--text-sub);margin-top:4px">
              매출에서 원가·수수료·배송비·광고비를 뺀 뒤 남는 돈입니다.
              ${fixTotal ? `월 고정비 ₩${fmt(fixTotal)}를 넘긴 다음의 목표로 잡으시면 됩니다 (제안 ₩${fmt(Math.round(fixTotal * 1.5 / 100000) * 100000)}).`
                         : "몇 달 지켜보면서 정하셔도 됩니다. 비워두면 손익분기만 표시됩니다."}</p></div>
          <div class="field full"><label>메모 (선택)</label>
            <input id="tg-note" maxlength="60" placeholder="예) 쿠팡 광고 늘리는 달"></div>
        </div>
        <div class="modal-actions">
          <button class="btn secondary" onclick="closeModal()">취소</button>
          <button class="btn" id="btn-tg-save" onclick="saveTeamGoal('${month}')">저장</button>
        </div>
      </div>
    </div>`;
  document.getElementById("tg-daily").focus();
}

async function saveTeamGoal(month) {
  const daily = numOf(document.getElementById("tg-daily").value) || 0;
  const amt = numOf(document.getElementById("tg-amt").value) || 0;
  if (daily <= 0) return toast("하루 매출 목표를 입력해 주세요");
  const btn = document.getElementById("btn-tg-save");
  if (btn) btn.disabled = true;
  const { data, error } = await sb.from("team_goals").upsert(
    { month, daily_sales_target: daily, cm_target: amt,
      note: document.getElementById("tg-note").value.trim(),
      updated_by: me.name, updated_at: new Date().toISOString() },
    { onConflict: "month" }).select("month");
  if (error || !data?.length) { if (btn) btn.disabled = false; return toast("저장에 실패했습니다"); }
  toast("우리 목표가 저장되었습니다");
  closeModal();
  route();
}

/* ---------- 화면: 대시보드 ---------- */
async function viewDashboard() {
  const [docs, prodRes, saleRes, buyRes, taskRes, costRes] = await Promise.all([
    fetchDocs(),
    sb.from("products").select("*").order("updated_at", { ascending: false }).limit(5),
    sb.from("sales").select("amount,date"),
    sb.from("purchases").select("amount,date"),
    sb.from("tasks").select("assignee_id,status,due_date"),
    sb.from("purchase_costs").select("amount,date"),
  ]);
  const myTasks = (taskRes.data || []).filter(t => t.assignee_id === me.id && t.status === "open").length;
  const products = prodRes.data || [];
  const nowMonth = today().slice(0, 7);   // erpMonth(전역)를 건드리면 사용자가 보던 달이 몰래 바뀜

  // 팀 카드 — 실패해도 대시보드 나머지는 보여야 하므로 따로 감싼다
  let teamHtml = "";
  try {
    const st = await loadTeamMonth(nowMonth);
    st.overdueTasks = (taskRes.data || []).filter(t => t.status === "open" && t.due_date && t.due_date < today()).length;
    const g = computeTeamGauge(st);
    const hy = collectHygiene(st);
    await claimMilestones(st, g, hy);                 // 새로 달성한 게 있으면 기록
    const cel = await fetchCelebrations(nowMonth);    // 내가 아직 못 본 축하
    if (cel.length) {
      const c0 = cel[0];
      const msg = String(c0.kind).startsWith("level_")
        ? `🎊 LEVEL UP! LV.${String(c0.kind).slice(6)} 달성`
        : `${MILESTONE_TEXT[c0.kind]?.ico || "🎉"} ${MILESTONE_TEXT[c0.kind]?.head || "축하합니다"}`;
      setTimeout(() => toast(msg), 400);
    }
    teamHtml = celebrationHtml(cel) + teamCardHtml(st, g, hy, true) + questsHtml(st, g, hy);
  } catch (e) { console.error("팀 카드:", e); }
  const monthSales = (saleRes.data || []).filter(r => (r.date || "").startsWith(nowMonth))
    .reduce((s, r) => s + Number(r.amount), 0);
  const monthBuys = (buyRes.data || []).filter(r => (r.date || "").startsWith(nowMonth))
    .reduce((s, r) => s + Number(r.amount), 0)
    + (costRes.data || []).filter(r => (r.date || "").startsWith(nowMonth))
    .reduce((s, r) => s + Number(r.amount), 0);
  const inbox = inboxOf(docs).length;
  const mine = docs.filter(d => d.drafter_id === me.id);
  const progress = mine.filter(d => d.status === "progress").length;
  const approved = mine.filter(d => d.status === "approved").length;
  const thisMonth = today().slice(0, 7);
  const monthTotal = docs
    .filter(d => d.status === "approved" && (d.date || "").startsWith(thisMonth))
    .reduce((s, d) => s + Number(d.total), 0);

  return `
    ${teamHtml}
    <div class="grid-stats">
      <div class="stat" onclick="location.hash='#/inbox'">
        <div class="stat-label">내 결재 대기</div>
        <div class="stat-value red">${inbox}건</div>
      </div>
      <div class="stat" onclick="location.hash='#/tasks'">
        <div class="stat-label">내가 받은 업무</div>
        <div class="stat-value ${myTasks ? "red" : "green"}">${myTasks}건</div>
      </div>
      <div class="stat" onclick="location.hash='#/drafts'">
        <div class="stat-label">내 기안 진행 중</div>
        <div class="stat-value amber">${progress}건</div>
      </div>
      <div class="stat" onclick="location.hash='#/drafts'">
        <div class="stat-label">내 기안 승인 완료</div>
        <div class="stat-value green">${approved}건</div>
      </div>
      <div class="stat" onclick="location.hash='#/docs'">
        <div class="stat-label">이번 달 승인 지출액</div>
        <div class="stat-value blue">₩${fmt(monthTotal)}</div>
      </div>
      <div class="stat" onclick="location.hash='#/sales'">
        <div class="stat-label">이번 달 매출</div>
        <div class="stat-value blue">₩${fmt(monthSales)}</div>
      </div>
      <div class="stat" onclick="location.hash='#/purchases'">
        <div class="stat-label">이번 달 매입</div>
        <div class="stat-value amber">₩${fmt(monthBuys)}</div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>최근 문서</h2>
        <button class="btn sm" onclick="location.hash='#/new'">＋ 지출결의서 작성</button>
      </div>
      ${docTable(docs.slice(0, 6))}
    </div>

    <div class="card">
      <div class="card-head">
        <h2>제품 마스터 최근 업데이트</h2>
        <button class="btn sm secondary" onclick="location.hash='#/products'">전체 보기</button>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>제품코드</th><th>제품명</th><th>규격</th><th class="num">단가</th><th>수정일</th></tr></thead>
        <tbody>
        ${products.map(p => `<tr><td>${esc(p.code)}</td><td><b>${esc(p.name)}</b></td><td>${esc(p.spec)}</td><td class="num">₩${fmt(p.price)}</td><td>${esc(p.updated_at)}</td></tr>`).join("")
          || `<tr><td colspan="5" class="empty">등록된 제품이 없습니다</td></tr>`}
        </tbody>
      </table></div>
    </div>`;
}

/* ---------- 문서 목록 테이블 ---------- */
function docTable(list) {
  if (!list.length) return `<div class="table-wrap"><table><tbody><tr><td class="empty">문서가 없습니다</td></tr></tbody></table></div>`;
  return `<div class="table-wrap"><table>
    <thead><tr><th>문서번호</th><th>제목</th><th>기안자</th><th>기안일</th><th class="num">금액</th><th>상태</th></tr></thead>
    <tbody>${list.map(d => `
      <tr class="clickable" onclick="location.hash='#/doc/${d.id}'">
        <td>${esc(d.doc_no)}</td>
        <td><b>${esc(d.title)}</b></td>
        <td>${userName(d.drafter_id)}</td>
        <td>${esc(d.date)}</td>
        <td class="num">₩${fmt(d.total)}</td>
        <td>${docStatusChip(d)}</td>
      </tr>`).join("")}
    </tbody></table></div>`;
}

/* ---------- 화면: 지출결의서 작성 ---------- */
async function viewNewDoc() {
  // 조직도상 나보다 윗사람만 결재 가능
  const approvers = USERS.filter(u => u.id !== me.id && u.approver && (u.rank || 0) > (me.rank || 0))
    .sort((a, b) => (a.rank || 0) - (b.rank || 0));
  if (!approvers.length) {
    // 최상위 결재권자(대표)가 직접 기안하는 경우 → 전결(자동 승인)
    return viewNewDocForm([], true);
  }
  return viewNewDocForm(approvers, false);
}

function viewNewDocForm(approvers, isTopRank) {
  return `
    <div class="card">
      <h2>지출결의서 작성</h2>
      <div class="form-grid">
        <div class="field full">
          <label>제목 *</label>
          <input id="f-title" placeholder="예) 8월 사무용품 구입 건" maxlength="80">
        </div>
        <div class="field">
          <label>지출(예정)일 *</label>
          <input id="f-date" type="date" value="${today()}">
        </div>
        <div class="field">
          <label>지불 방법</label>
          <select id="f-pay">${PAY_METHODS.map(m => `<option>${m}</option>`).join("")}</select>
        </div>
        <div class="field full">
          <label>비고 / 증빙 메모</label>
          <textarea id="f-note" placeholder="영수증 첨부 여부, 특이사항 등"></textarea>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>지출 항목</h2>
        <button class="btn sm secondary" onclick="addItemRow()">＋ 항목 추가</button>
      </div>
      <div class="table-wrap">
        <table class="items-table">
          <thead><tr><th style="width:150px">계정과목</th><th>내용</th><th style="width:140px" class="num">금액(원)</th><th style="width:40px"></th></tr></thead>
          <tbody id="item-rows"></tbody>
        </table>
      </div>
      <div class="total-line">합계 <b id="f-total">₩0</b></div>
    </div>

    <div class="card">
      <h2>결재선</h2>
      ${isTopRank ? `
      <p style="color:var(--text-sub);font-size:13px;margin-bottom:10px">
        상위 결재자가 없어 <b>즉시 전결</b> 처리됩니다.
      </p>` : `
      <p style="color:var(--text-sub);font-size:13px;margin-bottom:10px">순서대로 결재가 진행됩니다.</p>
      <div class="form-grid">
        <div class="field">
          <label>1차 결재자 *</label>
          <select id="f-appr1">
            ${approvers.map((u, i) => `<option value="${u.id}" ${i === 0 ? "selected" : ""}>${esc(u.name)} (${esc(u.role)})</option>`).join("")}
          </select>
        </div>
        <div class="field">
          <label>최종 결재자</label>
          <select id="f-appr2">
            <option value="">(없음 — 1차에서 종결)</option>
            ${approvers.map(u => `<option value="${u.id}" ${u.role === "대표이사" ? "selected" : ""}>${esc(u.name)} (${esc(u.role)})</option>`).join("")}
          </select>
        </div>
      </div>`}
      <div class="modal-actions">
        <button class="btn secondary" onclick="location.hash='#/dashboard'">취소</button>
        <button class="btn" id="btn-submit-doc" onclick="submitDoc()">${isTopRank ? "상신 (전결 처리)" : "상신 (결재 요청)"}</button>
      </div>
    </div>`;
}

function addItemRow() {
  const tbody = document.getElementById("item-rows");
  if (!tbody) return;
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td><select class="i-acct">${ACCOUNTS.map(a => `<option>${a}</option>`).join("")}</select></td>
    <td><input class="i-desc" placeholder="지출 내용" maxlength="100"></td>
    <td><input class="i-amt amount comma" type="text" inputmode="numeric" placeholder="0" oninput="calcTotal()"></td>
    <td><button class="btn-row-del" title="삭제" onclick="this.closest('tr').remove();calcTotal()">✕</button></td>`;
  tbody.appendChild(tr);
}
function calcTotal() {
  const total = [...document.querySelectorAll(".i-amt")].reduce((s, el) => s + numOf(el.value), 0);
  document.getElementById("f-total").textContent = "₩" + fmt(total);
  return total;
}

async function submitDoc() {
  const title = document.getElementById("f-title").value.trim();
  const date = document.getElementById("f-date").value;
  if (!title) return toast("제목을 입력해 주세요");
  if (!date) return toast("지출일을 선택해 주세요");

  const items = [...document.querySelectorAll("#item-rows tr")].map(tr => ({
    account: tr.querySelector(".i-acct").value,
    desc: tr.querySelector(".i-desc").value.trim(),
    amount: numOf(tr.querySelector(".i-amt").value) || 0,
  })).filter(it => it.desc || it.amount > 0);
  if (!items.length) return toast("지출 항목을 1개 이상 입력해 주세요");
  if (items.some(it => !it.desc)) return toast("항목 내용을 입력해 주세요");
  if (items.some(it => it.amount <= 0)) return toast("금액은 0보다 커야 합니다");

  // 결재선: 조직도상 윗사람. 최상위 직급이 기안하면 전결(자동 승인)
  const hasApprovalUI = !!document.getElementById("f-appr1");
  let line = [];
  if (hasApprovalUI) {
    const appr1 = document.getElementById("f-appr1").value;
    const appr2 = document.getElementById("f-appr2").value;
    line = [appr1, appr2].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i)
      .map(uid => ({ userId: uid, status: "waiting", comment: "", date: "" }));
    if (!line.length) return toast("결재자를 선택해 주세요");
  }
  const isJeongyeol = !hasApprovalUI;

  const btn = document.getElementById("btn-submit-doc");
  btn.disabled = true;
  try {
    const { data: docNo, error: e1 } = await sb.rpc("next_doc_no");
    if (e1) throw e1;
    const { data, error: e2 } = await sb.from("documents").insert({
      doc_no: docNo,
      title, date,
      pay: document.getElementById("f-pay").value,
      note: document.getElementById("f-note").value.trim(),
      drafter_id: me.id,
      items,
      total: items.reduce((s, it) => s + it.amount, 0),
      approval_line: line,
      current_step: 0,
      status: isJeongyeol ? "approved" : "progress",
    }).select().single();
    if (e2) throw e2;
    toast(isJeongyeol ? "전결 처리되었습니다" : "상신되었습니다");
    location.hash = "#/doc/" + data.id;
  } catch (err) {
    console.error(err);
    toast("상신에 실패했습니다. 다시 시도해 주세요.");
    btn.disabled = false;
  }
}

/* ---------- 화면: 결재 대기함 ---------- */
async function viewInbox() {
  const docs = await fetchDocs({ status: "progress" });
  const list = inboxOf(docs);
  return `
    <div class="card">
      <div class="card-head"><h2>내가 결재할 문서 (${list.length}건)</h2></div>
      ${docTable(list)}
    </div>`;
}

/* ---------- 화면: 내 기안함 ---------- */
async function viewDrafts() {
  const list = await fetchDocs({ drafter: me.id });
  return `
    <div class="card">
      <div class="card-head">
        <h2>내가 기안한 문서 (${list.length}건)</h2>
        <button class="btn sm" onclick="location.hash='#/new'">＋ 지출결의서 작성</button>
      </div>
      ${docTable(list)}
    </div>`;
}

/* ---------- 화면: 전체 문서함 ---------- */
let docsFilter = { q: "", status: "" };
let docsCache = [];
async function viewAllDocs() {
  docsCache = await fetchDocs();
  return `
    <div class="card">
      <div class="card-head"><h2 id="docs-count">전체 문서 (${filteredDocs().length}건)</h2></div>
      <div class="searchbar" style="margin-bottom:14px">
        <input placeholder="제목, 문서번호, 기안자 검색" value="${esc(docsFilter.q)}"
          oninput="docsFilter.q=this.value;refreshDocsTable()">
        <select onchange="docsFilter.status=this.value;refreshDocsTable()">
          <option value="">전체 상태</option>
          <option value="progress" ${docsFilter.status === "progress" ? "selected" : ""}>결재 중</option>
          <option value="approved" ${docsFilter.status === "approved" ? "selected" : ""}>승인 완료</option>
          <option value="rejected" ${docsFilter.status === "rejected" ? "selected" : ""}>반려</option>
        </select>
      </div>
      <div id="docs-table">${docTable(filteredDocs())}</div>
    </div>`;
}
function filteredDocs() {
  let list = docsCache;
  if (docsFilter.status) list = list.filter(d => d.status === docsFilter.status);
  if (docsFilter.q) {
    const q = docsFilter.q.toLowerCase();
    list = list.filter(d =>
      d.title.toLowerCase().includes(q) || d.doc_no.toLowerCase().includes(q) ||
      userName(d.drafter_id).includes(q));
  }
  return list;
}
function refreshDocsTable() {
  const list = filteredDocs();
  document.getElementById("docs-table").innerHTML = docTable(list);
  document.getElementById("docs-count").textContent = `전체 문서 (${list.length}건)`;
}

/* ---------- 화면: 문서 상세 ---------- */
async function viewDocDetail(id) {
  const { data: d, error } = await sb.from("documents").select("*").eq("id", id).single();
  if (error || !d) return `<div class="card"><p class="empty">문서를 찾을 수 없습니다.</p></div>`;

  const isMyTurn = d.status === "progress" && d.approval_line[d.current_step]?.userId === me.id;

  const steps = `
    <div class="appr-line">
      <div class="appr-step approved">
        <div class="step-role">기안</div>
        <div class="step-name">${userName(d.drafter_id)}</div>
        <div class="step-date">${esc(localDT(d.created_at))}</div>
      </div>
      ${d.approval_line.map((s, i) => {
        let cls = "", label = "대기";
        if (s.status === "approved") { cls = "approved"; label = "✔ 승인"; }
        else if (s.status === "rejected") { cls = "rejected"; label = "✖ 반려"; }
        else if (d.status === "progress" && i === d.current_step) { cls = "current"; label = "결재 차례"; }
        return `<div class="appr-step ${cls}">
          <div class="step-role">${i + 1}차 결재 · ${userRole(s.userId)}</div>
          <div class="step-name">${userName(s.userId)}</div>
          <div class="step-status">${label}</div>
          ${s.date ? `<div class="step-date">${esc(s.date)}</div>` : ""}
        </div>`;
      }).join("")}
    </div>
    ${d.approval_line.filter(s => s.comment).map(s =>
      `<div class="doc-comment"><b>${userName(s.userId)}</b> — ${esc(s.comment)}</div>`).join("")}`;

  return `
    <div class="card">
      <div class="card-head">
        <h2>${esc(d.title)}</h2>
        ${docStatusChip(d)}
      </div>
      <div class="doc-meta">
        <div><span>문서번호</span><b>${esc(d.doc_no)}</b></div>
        <div><span>기안자</span>${userName(d.drafter_id)} (${userRole(d.drafter_id)})</div>
        <div><span>지출일</span>${esc(d.date)}</div>
        <div><span>지불방법</span>${esc(d.pay)}</div>
      </div>
      ${d.note ? `<div class="doc-comment">📎 ${esc(d.note)}</div>` : ""}
    </div>

    <div class="card">
      <h2>지출 내역</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>계정과목</th><th>내용</th><th class="num">금액</th></tr></thead>
        <tbody>
          ${d.items.map(it => `<tr><td>${esc(it.account)}</td><td>${esc(it.desc)}</td><td class="num">₩${fmt(it.amount)}</td></tr>`).join("")}
        </tbody>
      </table></div>
      <div class="total-line">합계 <b>₩${fmt(d.total)}</b></div>
    </div>

    <div class="card">
      <h2>결재선</h2>
      ${steps}
      ${isMyTurn ? `
        <div class="approve-box">
          <textarea id="appr-comment" placeholder="결재 의견 (선택)"></textarea>
          <button class="btn green" onclick="decide('${d.id}', true)">승인</button>
          <button class="btn danger" onclick="decide('${d.id}', false)">반려</button>
        </div>` : ""}
      <div class="modal-actions">
        <button class="btn secondary" onclick="history.back()">← 뒤로</button>
        ${d.drafter_id === me.id && d.status === "rejected" ? `<button class="btn" onclick="location.hash='#/new'">다시 작성</button>` : ""}
      </div>
    </div>`;
}

async function decide(docId, approve) {
  // 최신 상태를 다시 읽어 동시 결재 충돌 방지
  const { data: d, error } = await sb.from("documents").select("*").eq("id", docId).single();
  if (error || !d || d.status !== "progress") { toast("이미 처리된 문서입니다"); route(); return; }
  const step = d.approval_line[d.current_step];
  if (step.userId !== me.id) { toast("결재 권한이 없습니다"); route(); return; }

  step.comment = document.getElementById("appr-comment")?.value.trim() || "";
  step.date = nowStr();
  let patch;
  if (approve) {
    step.status = "approved";
    patch = d.current_step < d.approval_line.length - 1
      ? { approval_line: d.approval_line, current_step: d.current_step + 1 }
      : { approval_line: d.approval_line, status: "approved" };
  } else {
    step.status = "rejected";
    patch = { approval_line: d.approval_line, status: "rejected" };
  }
  const { error: e2 } = await sb.from("documents").update(patch).eq("id", docId);
  if (e2) { toast("처리에 실패했습니다"); return; }
  toast(approve ? "승인 처리되었습니다" : "반려 처리되었습니다");
  route();
}

/* ---------- 화면: 제품 마스터 ---------- */
let prodFilter = "";
let prodTypeFilter = "";
let prodCache = [];
async function viewProducts() {
  const { data, error } = await sb.from("products").select("*").order("code");
  prodCache = error ? [] : (data || []);
  return `
    <div class="card">
      <div class="card-head">
        <h2 id="prod-count">제품 마스터 (${prodCache.length}종)</h2>
        <div style="display:flex;gap:8px">
          <button class="btn sm secondary" onclick="exportProductsCSV()">CSV 내보내기</button>
          <button class="btn sm" onclick="openProductModal()">＋ 제품 등록</button>
        </div>
      </div>
      ${vatCfg.enabled ? `<p style="font-size:12.5px;color:var(--text-sub);margin:-4px 0 12px">
        🧾 원가는 <b>${vatCfg.purchaseCostIncludesVat ? "부가세 포함" : "부가세 별도(공급가액)"}</b>,
        판매가·MSRP는 <b>${vatCfg.salePriceIncludesVat ? "부가세 포함" : "부가세 별도"}</b>로 입력합니다.
        마진은 양쪽 모두 부가세를 뺀 금액으로 계산합니다.
        (<a onclick="location.hash='#/settings'" style="color:var(--brand);cursor:pointer">기준 변경</a>)</p>` : ""}
      <div class="searchbar" style="margin-bottom:14px">
        <input placeholder="제품명, 코드, 분류 검색" value="${esc(prodFilter)}"
          oninput="prodFilter=this.value;refreshProductTable()">
        <select onchange="prodTypeFilter=this.value;refreshProductTable()">
          <option value="">전체 (사입+위탁)</option>
          <option value="사입" ${prodTypeFilter === "사입" ? "selected" : ""}>사입만</option>
          <option value="위탁" ${prodTypeFilter === "위탁" ? "selected" : ""}>위탁만</option>
        </select>
      </div>
      <div id="product-table">${productTable()}</div>
    </div>`;
}
function productTable() {
  let list = prodCache;
  if (prodTypeFilter) list = list.filter(p => (p.trade_type || "사입") === prodTypeFilter);
  if (prodFilter) {
    const q = prodFilter.toLowerCase();
    list = list.filter(p =>
      p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q) ||
      (p.category || "").toLowerCase().includes(q));
  }
  if (!list.length) return `<div class="table-wrap"><table><tbody><tr><td class="empty">제품이 없습니다</td></tr></tbody></table></div>`;
  return `<div class="table-wrap"><table>
    <thead><tr><th>제품코드</th><th>제품명</th><th>구분</th><th>부가세</th><th>분류</th>
      <th class="num">원가</th><th class="num">판매가</th><th class="num">마진<br><small>부가세 제외</small></th><th class="num">마진율</th>
      <th class="num">MSRP</th><th class="num">박스입수</th><th>메모</th><th>최종수정</th><th></th></tr></thead>
    <tbody>${list.map(p => {
      // 연동 세트상품 원가는 '낱개 원가 × 구성 수량' 자동 계산
      const cost = effCost(p, prodCache) || 0, price = Number(p.price) || 0;
      const base = setBaseOf(p, prodCache);
      const taxable = isTaxable(p);
      const nPrice = taxable ? netAmt(price, vatCfg.salePriceIncludesVat) : price;
      const nCost = taxable ? netAmt(cost, vatCfg.purchaseCostIncludesVat) : cost;
      const margin = cost && price ? nPrice - nCost : null;
      const rate = margin !== null && nPrice ? Math.round((margin / nPrice) * 100) : null;
      return `
      <tr>
        <td>${esc(p.code)}</td>
        <td><b>${esc(p.name)}</b>${isSetProd(p) ? `<br><small style="color:var(--text-sub)">구성: ${esc(base?.name || "?")} × ${fmt(p.set_qty)}개</small>` : ""}</td>
        <td>${(p.trade_type || "사입") === "위탁"
          ? '<span class="chip waiting">위탁</span>'
          : '<span class="chip mine">사입</span>'}${isSetProd(p)
          ? ` <span class="chip progress">세트×${fmt(p.set_qty)}</span>`
          : p.is_set ? ' <span class="chip progress">세트</span>' : ""}</td>
        <td>${taxable ? '<span style="color:var(--text-sub)">과세</span>' : '<span class="chip waiting">면세</span>'}</td>
        <td>${esc(p.category)}</td>
        <td class="num">${cost ? "₩" + fmt(cost) + (isSetProd(p) ? ' <small style="color:var(--text-sub)">자동</small>' : "") : '<span style="color:var(--text-sub)">—</span>'}</td>
        <td class="num">₩${fmt(price)}</td>
        <td class="num">${margin !== null ? "₩" + fmt(margin) : '<span style="color:var(--text-sub)">—</span>'}</td>
        <td class="num">${rate !== null
          ? `<b style="color:${rate < 20 ? "#d9480f" : "var(--brand)"}">${rate}%</b>`
          : '<span style="color:var(--text-sub)">—</span>'}</td>
        <td class="num">${p.msrp ? "₩" + fmt(p.msrp) : '<span style="color:var(--text-sub)">—</span>'}</td>
        <td class="num">${p.box_qty ? fmt(p.box_qty) : '<span style="color:var(--text-sub)">—</span>'}</td>
        <td style="max-width:140px;overflow:hidden;text-overflow:ellipsis">${esc(p.memo)}</td>
        <td>${esc(p.updated_at)}<br><small style="color:var(--text-sub)">${esc(p.updated_by || "")}</small></td>
        <td style="white-space:nowrap">
          ${isSetProd(p) ? "" : `<button class="btn sm secondary" title="이 제품의 묶음 리스팅 만들기"
            onclick="openSetCreateModal('${p.id}')">＋세트</button>`}
          <button class="btn sm secondary" onclick="openProductModal('${p.id}')">수정</button>
          <button class="btn sm danger" onclick="deleteProduct('${p.id}')">삭제</button>
        </td>
      </tr>`; }).join("")}
    </tbody></table></div>`;
}
function refreshProductTable() {
  document.getElementById("product-table").innerHTML = productTable();
}

function openProductModal(id) {
  const p = id ? prodCache.find(x => x.id === id) : null;
  const root = document.getElementById("modal-root");
  root.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal">
        <h3>${p ? "제품 수정" : "제품 등록"}</h3>
        <div class="form-grid">
          <div class="field"><label>제품코드 *</label><input id="p-code" value="${esc(p?.code || "")}" placeholder="RV-000" maxlength="20"></div>
          <div class="field"><label>구분 *</label>
            <select id="p-type" ${isSetProd(p) ? "disabled" : ""}>
              <option value="사입" ${(p?.trade_type || "사입") === "사입" ? "selected" : ""}>사입 (직접 재고 보유)</option>
              <option value="위탁" ${p?.trade_type === "위탁" ? "selected" : ""}>위탁 (공급처 직배송)</option>
            </select></div>
          ${isSetProd(p) ? `
          <div class="field full" style="background:var(--brand-light);border-radius:9px;padding:10px 12px">
            <label style="margin-bottom:4px">📦 세트상품 — 기본 제품의 배수</label>
            <div style="font-size:13.5px;line-height:1.7">
              기본 제품: <b>${esc(setBaseOf(p, prodCache)?.name || "?")}</b><br>
              <span style="color:var(--text-sub)">재고는 기본 제품에서 차감되고, 원가는 기본 원가 × 배수로 자동 계산됩니다.</span>
            </div>
            <label style="margin-top:8px">배수 (세트 1개 = 기본 제품 몇 개?)</label>
            <input id="p-set-qty" type="number" min="1" value="${p.set_qty}" data-self="${id}" oninput="calcMarginHint()">
            <input type="hidden" id="p-set-on" value="1">
          </div>` : `
          <div class="field"><label>세트 표기 <small style="color:var(--text-sub);font-weight:400">— 표시용, 계산 무관</small></label>
            <select id="p-set-on" onchange="toggleSetFields()">
              <option value="">일반 상품</option>
              <option value="tag" ${p?.is_set ? "selected" : ""}>세트 표기만 (묶음 리스팅)</option>
            </select></div>`}
          <div class="field full"><label>제품명 *</label><input id="p-name" value="${esc(p?.name || "")}" maxlength="60"></div>
          <div class="field"><label>분류</label><input id="p-cat" value="${esc(p?.category || "")}" placeholder="예) 건강식품" maxlength="30"></div>
          <div class="field"><label>부가세</label>
            <select id="p-tax" ${isSetProd(p) ? "disabled" : ""}>
              <option value="과세" ${(p?.tax_type || "과세") === "과세" ? "selected" : ""}>과세 (대부분의 공산품)</option>
              <option value="면세" ${p?.tax_type === "면세" ? "selected" : ""}>면세 (미가공 식품·도서 등)</option>
            </select></div>
          <div class="field"><label>규격</label><input id="p-spec" value="${esc(p?.spec || "")}" placeholder="예) 30g x 10입" maxlength="40"></div>
          <div class="field"><label>단위</label><input id="p-unit" value="${esc(p?.unit || "")}" placeholder="BOX / EA / 병" maxlength="10"></div>
          <div class="field" id="fld-cost" ${isSetProd(p) ? 'style="display:none"' : ""}><label>원가(원) — 매입 단가${vatTag("buy")}</label>
            <input id="p-cost" type="text" inputmode="numeric" class="comma" value="${cfv(p?.cost_price)}" oninput="calcMarginHint()"></div>
          <div class="field"><label>판매가(원) — 실제 판매${vatTag("sale")}</label>
            <input id="p-price" type="text" inputmode="numeric" class="comma" value="${cfv(p?.price)}" oninput="calcMarginHint()"></div>
          <div class="field"><label>MSRP(원) — 권장소비자가${vatTag("sale")}</label>
            <input id="p-msrp" type="text" inputmode="numeric" class="comma" value="${cfv(p?.msrp)}"></div>
          <div class="field"><label>박스입수(개)</label>
            <input id="p-box" type="number" min="0" value="${p?.box_qty ?? ""}" placeholder="예) 40"></div>
          <div class="field full" style="background:var(--brand-light);border-radius:9px;padding:10px 12px">
            <label style="margin-bottom:6px">채널 비용 <small style="color:var(--text-sub);font-weight:400">— 상품별로 다르면 입력, 비우면 채널 기본값 사용</small></label>
            <div class="form-grid" style="gap:8px 12px">
              <div class="field"><label>수수료율(%)</label>
                <input id="p-fee" type="number" step="0.01" min="0" max="100" value="${p?.fee_rate ?? ""}" placeholder="예) 10.8"></div>
              <div class="field"><label>개당 물류비(원) <small style="color:var(--text-sub);font-weight:400">로켓그로스</small></label>
                <input id="p-unitfee" type="text" inputmode="numeric" class="comma" value="${cfv(p?.unit_fee)}" placeholder="입출고비"></div>
              <div class="field"><label>주문당 배송비(원) <small style="color:var(--text-sub);font-weight:400">직접배송</small></label>
                <input id="p-shipfee" type="text" inputmode="numeric" class="comma" value="${cfv(p?.ship_fee)}" placeholder="택배비"></div>
            </div>
          </div>
          <div class="field full" id="margin-hint" style="font-size:13px;color:var(--text-sub)"></div>
          <div class="field full"><label>메모 (그 외 참고사항)</label><textarea id="p-memo" placeholder="원가·판매가·박스입수는 위 칸에 입력하세요">${esc(p?.memo || "")}</textarea></div>
        </div>
        <div class="modal-actions">
          <button class="btn secondary" onclick="closeModal()">취소</button>
          <button class="btn" onclick="saveProduct('${id || ""}')">저장</button>
        </div>
      </div>
    </div>`;
  toggleSetFields();
}

// 세트 표기 선택 시 화면 갱신 (연동 세트는 [＋세트] 버튼으로만 만들어지므로 여기선 표기만 처리)
function toggleSetFields() {
  calcMarginHint();
}

/* 기본 제품에서 배수만 골라 세트상품을 만든다 — A+B 번들은 없으므로 구성 상품 선택 자체가 불필요 */
function openSetCreateModal(baseId) {
  const b = prodCache.find(x => x.id === baseId);
  if (!b) return;
  if (isSetProd(b)) return toast("세트상품으로는 다시 세트를 만들 수 없습니다");
  document.getElementById("modal-root").innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal">
        <h3>📦 세트상품 만들기</h3>
        <p style="font-size:13.5px;color:var(--text-sub);margin:4px 0 12px;line-height:1.7">
          <b>${esc(b.name)}</b>를 여러 개 묶어 파는 리스팅을 만듭니다.<br>
          재고는 기본 제품에서 차감되고, 원가는 <b>기본 원가 × 배수</b>로 자동 계산됩니다.</p>
        <div class="form-grid">
          <div class="field full"><label>몇 개 묶음인가요? *</label>
            <div id="set-mult-btns" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">
              ${[2, 3, 4, 5, 6, 10].map(n =>
                `<button type="button" class="btn sm secondary" onclick="pickSetMult(${n})">${n}개</button>`).join("")}
            </div>
            <input id="sc-qty" type="number" min="2" value="3" oninput="setCreatePreview('${baseId}')"></div>
          <div class="field full"><label>세트 판매가(원) *${vatTag("sale")}</label>
            <input id="sc-price" type="text" inputmode="numeric" class="comma" placeholder="쿠팡 리스팅 가격"
              oninput="setCreatePreview('${baseId}')"></div>
          <div class="field full" id="sc-preview" style="font-size:13px;color:var(--text-sub);line-height:1.8"></div>
        </div>
        <div class="modal-actions">
          <button class="btn secondary" onclick="closeModal()">취소</button>
          <button class="btn" id="btn-sc-save" onclick="saveNewSet('${baseId}')">세트 만들기</button>
        </div>
      </div>
    </div>`;
  setCreatePreview(baseId);
}
function pickSetMult(n) {
  const el = document.getElementById("sc-qty");
  if (el) { el.value = n; el.dispatchEvent(new Event("input", { bubbles: true })); }
}
function setCreatePreview(baseId) {
  const b = prodCache.find(x => x.id === baseId);
  const el = document.getElementById("sc-preview");
  if (!b || !el) return;
  const n = Number(document.getElementById("sc-qty")?.value) || 0;
  const price = numOf(document.getElementById("sc-price")?.value);
  if (n < 2) { el.innerHTML = "배수는 2 이상이어야 합니다."; return; }
  const cost = (Number(b.cost_price) || 0) * n;
  const taxable = isTaxable(b);
  const nPrice = taxable ? netAmt(price, vatCfg.salePriceIncludesVat) : price;
  const nCost = taxable ? netAmt(cost, vatCfg.purchaseCostIncludesVat) : cost;
  const margin = cost && price ? nPrice - nCost : null;
  const rate = margin !== null && nPrice ? Math.round((margin / nPrice) * 100) : null;
  el.innerHTML = `
    이렇게 만들어집니다 —<br>
    · 제품명 <b>${esc(b.name)} ${n}개 세트</b><br>
    · 제품코드 <b>${esc(setCodeFor(b, n))}</b><br>
    · 원가 <b>₩${fmt(cost)}</b> <span style="color:var(--text-sub)">(₩${fmt(b.cost_price || 0)} × ${n})</span>
    ${!b.cost_price ? ' <span style="color:#d9480f">⚠️ 기본 제품에 원가가 없습니다</span>' : ""}
    ${margin !== null ? `<br>· 마진 <b>₩${fmt(margin)}</b> · 마진율 <b style="color:${rate < 20 ? "#d9480f" : "var(--brand)"}">${rate}%</b>` : ""}`;
}
// 세트 제품코드: 기본코드-S{배수}. 이미 있으면 뒤에 번호를 붙여 충돌을 피한다
function setCodeFor(b, n) {
  let code = `${b.code}-S${n}`;
  let i = 2;
  while (prodCache.some(x => x.code === code)) code = `${b.code}-S${n}-${i++}`;
  return code;
}
async function saveNewSet(baseId) {
  const b = prodCache.find(x => x.id === baseId);
  if (!b) return;
  const n = Number(document.getElementById("sc-qty").value) || 0;
  const price = numOf(document.getElementById("sc-price").value);
  if (n < 2) return toast("배수는 2 이상으로 입력해 주세요");
  if (price <= 0) return toast("세트 판매가를 입력해 주세요");
  const btn = document.getElementById("btn-sc-save");
  if (btn) btn.disabled = true;
  const { error } = await sb.from("products").insert({
    code: setCodeFor(b, n),
    name: `${b.name} ${n}개 세트`,
    trade_type: b.trade_type || "사입",
    tax_type: b.tax_type || "과세",
    category: b.category,
    spec: b.spec, unit: b.unit,
    price,
    cost_price: null,              // 기본 원가 × 배수로 항상 자동 계산
    set_parent_id: b.id, set_qty: n, is_set: true,
    memo: `${b.name} ${n}개 묶음 — 재고·원가는 기본 제품과 자동 연동`,
    updated_at: today(), updated_by: me.name,
  });
  if (error) { if (btn) btn.disabled = false; return toast(error.code === "23505" ? "같은 제품코드가 이미 있습니다" : "저장에 실패했습니다"); }
  toast(`${b.name} ${n}개 세트가 만들어졌습니다`);
  closeModal();
  route();
}

function calcMarginHint() {
  const el = document.getElementById("margin-hint");
  if (!el) return;
  // 세트상품 수정 중이면 원가는 '기본 제품 원가 × 배수'
  const linked = document.getElementById("p-set-on")?.value === "1";
  let cost;
  if (linked) {
    const self = prodCache.find(x => x.id === (document.getElementById("p-set-qty")?.dataset.self || ""));
    const parent = setBaseOf(self, prodCache);
    const n = Number(document.getElementById("p-set-qty")?.value) || 0;
    cost = (Number(parent?.cost_price) || 0) * n;
    if (parent && n && !parent.cost_price) { el.innerHTML = `⚠️ 기본 제품 '${esc(parent.name)}'의 원가가 등록되어 있지 않습니다 — 먼저 기본 제품에 원가를 넣어 주세요.`; return; }
  } else {
    cost = numOf(document.getElementById("p-cost")?.value) || 0;
  }
  const price = numOf(document.getElementById("p-price")?.value) || 0;
  if (!cost || !price) { el.textContent = linked ? "배수와 판매가를 넣으면 마진이 자동 계산됩니다." : "원가와 판매가를 넣으면 마진이 자동 계산됩니다."; return; }
  const taxable = (document.getElementById("p-tax")?.value || "과세") === "과세";
  // 부가세를 뺀 금액끼리 비교해야 실제 마진
  const netPrice = taxable ? netAmt(price, vatCfg.salePriceIncludesVat) : price;
  const netCost = taxable ? netAmt(cost, vatCfg.purchaseCostIncludesVat) : cost;
  const m = netPrice - netCost, rate = netPrice ? Math.round((m / netPrice) * 100) : 0;
  el.innerHTML = `개당 마진 <b>₩${fmt(m)}</b> · 마진율 <b style="color:${rate < 20 ? "#d9480f" : "var(--brand)"}">${rate}%</b>`
    + (vatCfg.enabled && taxable ? ` <span style="color:var(--text-sub)">(부가세 제외: 판매 ₩${fmt(netPrice)} − 원가 ₩${fmt(netCost)})</span>` : "")
    + (rate < 20 ? " ⚠️ 마진율이 낮습니다" : "");
}

function closeModal() { document.getElementById("modal-root").innerHTML = ""; }

async function saveProduct(id) {
  const code = document.getElementById("p-code").value.trim();
  const name = document.getElementById("p-name").value.trim();
  if (!code || !name) return toast("제품코드와 제품명은 필수입니다");

  // 형태: "" 일반 / "tag" 세트 표기만 / "1" 연동 세트(수정 중일 때만 — 생성은 [＋세트] 버튼으로)
  const setMode = document.getElementById("p-set-on").value;
  const linked = setMode === "1";
  const self = id ? prodCache.find(x => x.id === id) : null;
  const setQty = linked ? (Number(document.getElementById("p-set-qty").value) || 0) : null;
  if (linked && setQty < 2) return toast("배수는 2 이상으로 입력해 주세요");

  const data = {
    code, name,
    set_parent_id: linked ? (self?.set_parent_id || null) : null,
    set_qty: linked ? setQty : null,
    is_set: setMode !== "",     // 연동이든 표기만이든 '세트' 표시는 남긴다
    trade_type: linked ? (self?.trade_type || "사입") : document.getElementById("p-type").value,
    tax_type: linked ? (self?.tax_type || "과세") : document.getElementById("p-tax").value,
    category: document.getElementById("p-cat").value.trim(),
    spec: document.getElementById("p-spec").value.trim(),
    unit: document.getElementById("p-unit").value.trim(),
    price: numOf(document.getElementById("p-price").value) || 0,
    // 연동 세트 원가는 저장하지 않는다 — '낱개 원가 × 수량'으로 항상 자동 계산
    cost_price: linked ? null : (numOf(document.getElementById("p-cost").value) || null),
    msrp: numOf(document.getElementById("p-msrp").value) || null,
    box_qty: numOf(document.getElementById("p-box").value) || null,
    fee_rate: document.getElementById("p-fee").value === "" ? null : Number(document.getElementById("p-fee").value),
    unit_fee: document.getElementById("p-unitfee").value === "" ? null : numOf(document.getElementById("p-unitfee").value),
    ship_fee: document.getElementById("p-shipfee").value === "" ? null : numOf(document.getElementById("p-shipfee").value),
    memo: document.getElementById("p-memo").value.trim(),
    updated_at: today(),
    updated_by: me.name,
  };
  let res = id
    ? await sb.from("products").update(data).eq("id", id)
    : await sb.from("products").insert(data);
  // DB에 상품별 채널비용 컬럼이 아직 없으면(마이그레이션 전) 그 값만 빼고 재시도
  for (const col of ["fee_rate", "unit_fee", "ship_fee"]) {
    if (res.error && String(res.error.message || "").includes(col)) {
      delete data[col];
      res = id
        ? await sb.from("products").update(data).eq("id", id)
        : await sb.from("products").insert(data);
    }
  }
  if (res.error) {
    toast(res.error.code === "23505" ? "이미 사용 중인 제품코드입니다" : "저장에 실패했습니다");
    return;
  }
  toast(id ? "제품이 수정되었습니다" : "제품이 등록되었습니다");
  closeModal();
  const { data: fresh } = await sb.from("products").select("*").order("code");
  prodCache = fresh || [];
  refreshProductTable();
  const cnt = document.getElementById("prod-count");
  if (cnt) cnt.textContent = `제품 마스터 (${prodCache.length}종)`;
}

async function deleteProduct(id) {
  const p = prodCache.find(x => x.id === id);
  if (!p) return;
  // 세트상품이 이 상품을 구성으로 쓰고 있으면 삭제 불가 (세트의 재고·원가 계산이 끊어짐)
  const kids = prodCache.filter(x => x.set_parent_id === id);
  if (kids.length) {
    return alert(
      `'${p.name}'은(는) 삭제할 수 없습니다.\n\n`
      + `이 상품을 구성으로 쓰는 세트상품이 있습니다: ${kids.map(k => k.name).join(", ")}\n`
      + `세트상품을 먼저 삭제하거나 구성 상품을 바꿔 주세요.`);
  }
  // 거래 기록이 있으면 DB가 삭제를 막는다 — 이유를 알려줘야 사용자가 헤매지 않음
  const [s, b] = await Promise.all([
    sb.from("sales").select("id", { count: "exact", head: true }).eq("product_id", id),
    sb.from("purchases").select("id", { count: "exact", head: true }).eq("product_id", id),
  ]);
  const used = (s.count || 0) + (b.count || 0);
  if (used) {
    return alert(
      `'${p.name}'은(는) 삭제할 수 없습니다.\n\n`
      + `매출 ${s.count || 0}건, 매입 ${b.count || 0}건에 이미 사용되고 있습니다.\n`
      + `지우면 과거 매출·매입 기록의 품목명이 사라지기 때문에 시스템이 막고 있습니다.\n\n`
      + `더 이상 취급하지 않는 상품이라면, 제품명 뒤에 '(단종)'을 붙여 두세요.`);
  }
  if (!confirm(`'${p.name}' 제품을 삭제할까요?`)) return;
  const { error } = await sb.from("products").delete().eq("id", id);
  if (error) return toast("삭제에 실패했습니다");
  prodCache = prodCache.filter(x => x.id !== id);
  refreshProductTable();
  toast("삭제되었습니다");
}

function exportProductsCSV() {
  const head = ["제품코드", "제품명", "구분", "세트", "부가세", "분류", "규격", "단위", "원가", "판매가",
    "마진(부가세제외)", "마진율(%)", "MSRP", "박스입수", "메모", "최종수정일", "수정자"];
  const rows = prodCache.map(p => {
    const cost = effCost(p, prodCache) || 0, price = Number(p.price) || 0;
    const taxable = isTaxable(p);
    const nPrice = taxable ? netAmt(price, vatCfg.salePriceIncludesVat) : price;
    const nCost = taxable ? netAmt(cost, vatCfg.purchaseCostIncludesVat) : cost;
    const margin = cost && price ? nPrice - nCost : "";
    const rate = margin !== "" && nPrice ? Math.round((margin / nPrice) * 100) : "";
    return [p.code, p.name, p.trade_type || "사입",
      isSetProd(p) ? `${setBaseOf(p, prodCache)?.name || "?"} x ${p.set_qty}` : (p.is_set ? "세트" : ""),
      p.tax_type || "과세", p.category, p.spec, p.unit,
      cost || "", price, margin, rate, p.msrp ?? "", p.box_qty ?? "",
      p.memo, p.updated_at, p.updated_by || ""];
  });
  const csv = "﻿" + [head, ...rows]
    .map(r => r.map(c => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
  downloadFile(csv, `리버스_제품마스터_${today()}.csv`, "text/csv");
}

/* ==================== ERP: 매출 / 매입 / 재고 / 리포트 ==================== */
let erpChannelList = [];  // sales_channels 테이블
let erpTransfers = [];    // stock_transfers (쿠팡 사외재고 이동)
let erpMonth = today().slice(0, 7);
let erpProducts = [];
let erpStock = {};      // product_id → {stock, lastCost}
let erpRowsCache = [];  // 현재 목록 캐시 (수정 모달용)
let erpCostsCache = []; // 부대비용(택배·운송) 캐시
let erpSuppliers = [];      // 과거 매입에 쓰인 거래처명
let erpSupplierList = [];   // suppliers 테이블 (등록된 거래처)
let erpChannels = [];

const prodName = id => (erpProducts.find(p => p.id === id) || {}).name || "?";

// 등록된 거래처 + 과거 매입에 쓰인 이름을 합쳐 선택지로. 하나도 없으면 등록을 안내
function supplierOptionsHtml(sel) {
  const active = erpSupplierList.filter(s => s.active !== false).map(s => s.name);
  const names = [...new Set([...active, ...erpSuppliers])].filter(Boolean);
  if (!names.length) {
    return `<div style="border:1.5px dashed var(--line);border-radius:9px;padding:10px;font-size:13px;color:var(--text-sub)">
      등록된 거래처가 없습니다 —
      <a onclick="location.hash='#/suppliers'" style="color:var(--brand);cursor:pointer;font-weight:600">거래처를 먼저 등록해 주세요 →</a>
      <input type="hidden" id="b-supplier" value="">
    </div>`;
  }
  return `<select id="b-supplier">
    <option value="">거래처를 선택하세요</option>
    ${names.map(n => `<option value="${esc(n)}" ${n === sel ? "selected" : ""}>${esc(n)}</option>`).join("")}
  </select>`;
}
const monthOf = r => (r.date || "").slice(0, 7);

/* 제품·재고·거래처·채널 공통 로드 */
async function loadErpBase() {
  const [prodRes, buyRes, saleRes, costRes, chRes, trRes, spRes] = await Promise.all([
    sb.from("products").select("*").order("name"),
    sb.from("purchases").select("*").order("date", { ascending: false }).order("created_at", { ascending: false }),
    sb.from("sales").select("*").order("date", { ascending: false }).order("created_at", { ascending: false }),
    sb.from("purchase_costs").select("*").order("date", { ascending: false }).order("created_at", { ascending: false }),
    sb.from("sales_channels").select("*").order("created_at"),
    sb.from("stock_transfers").select("*").order("date", { ascending: false }).order("created_at", { ascending: false }),
    sb.from("suppliers").select("*").order("name"),
  ]);
  erpSupplierList = spRes.data || [];
  erpProducts = prodRes.data || [];
  const buys = buyRes.data || [];
  const sales = saleRes.data || [];
  const costs = costRes.data || [];
  erpChannelList = chRes.data || [];
  erpTransfers = trRes.data || [];
  erpStock = {};
  // 재고는 '오늘까지 실제로 일어난' 입출고만 반영 (내일 입고 예정을 미리 입력해도 지금 재고는 그대로)
  const td = today();
  const upTo = arr => arr.filter(x => (x.date || "") <= td);
  // 1차: 낱개 상품 — 연동 세트상품 판매는 '낱개 수량'으로 환산해 여기서 함께 차감한다
  erpProducts.forEach(p => {
    if (isSetProd(p)) return;  // 연동 세트는 아래 2차에서 낱개 기준으로 파생
    const children = erpProducts.filter(x => x.set_parent_id === p.id && Number(x.set_qty) > 0);
    const unitQty = s => {
      const c = children.find(x => x.id === s.product_id);
      return c ? Number(s.qty) * Number(c.set_qty) : Number(s.qty);
    };
    const myBuys = upTo(buys.filter(b => b.product_id === p.id));
    // 매입이 어디로 들어왔는지로 나눈다 — 리파코→로켓그로스 직송처럼 자사창고를 안 거치는 경우가 있음
    const boughtCoupang = myBuys.filter(b => b.warehouse === "쿠팡").reduce((s, b) => s + Number(b.qty), 0);
    const boughtHouse = myBuys.filter(b => b.warehouse !== "쿠팡").reduce((s, b) => s + Number(b.qty), 0);
    const bought = boughtHouse + boughtCoupang;
    const mySales = upTo(sales.filter(x => x.product_id === p.id || children.some(c => c.id === x.product_id)));
    const sold = mySales.reduce((s, x) => s + unitQty(x), 0);
    // 창고에서 쿠팡으로 보낸(입고) − 회수
    const moved = upTo(erpTransfers.filter(t => t.product_id === p.id))
      .reduce((s, t) => s + (t.kind === "쿠팡입고" ? 1 : -1) * Number(t.qty), 0);
    // 쿠팡 사외재고에서 차감되는 판매 = '풀필먼트' 채널(로켓그로스 등) 매출.
    // 쿠팡 판매자배송(윙)은 우리 창고에서 택배로 나가므로 자사창고에서 차감해야 한다 — 이름이 아니라 배송 방식으로 판단.
    // 채널 목록에 없는 이름은 배송 방식을 알 수 없으므로, 이름에 '쿠팡'이 들어가면 기존 규칙대로 쿠팡 재고로 본다.
    const coupangSold = mySales.filter(x => {
      const ch = x.channel || "";
      const reg = erpChannelList.find(c => c.name === ch);
      return reg ? reg.ship_type === "풀필먼트" : ch.includes("쿠팡");
    }).reduce((s, x) => s + unitQty(x), 0);
    const houseSold = sold - coupangSold;
    // 쿠팡 재고 = 직송 입고 + 창고에서 보낸 것 − 쿠팡 판매
    const atCoupangRaw = boughtCoupang + moved - coupangSold;
    const atCoupang = Math.max(0, atCoupangRaw);
    // 자사창고 = 창고 입고 − 쿠팡으로 보낸 것 − 창고 출고 판매
    const inHouse = boughtHouse - moved - houseSold;
    const stock = bought - sold;
    erpStock[p.id] = {
      stock, atCoupang, inHouse, bought, sold,
      boughtHouse, boughtCoupang,
      coupangUntracked: atCoupangRaw < 0 ? -atCoupangRaw : 0, // 입고/이동 기록 누락 의심 수량
      // 최근 매입단가 우선, 없으면 제품 마스터의 등록 원가
      lastCost: (myBuys.length && Number(myBuys[0].unit_cost)) || Number(p.cost_price) || 0,
    };
  });
  // 2차: 연동 세트상품 — 자체 재고는 없고, '낱개 재고로 몇 세트를 팔 수 있는가'를 보여준다
  erpProducts.filter(isSetProd).forEach(p => {
    const b = erpStock[p.set_parent_id] || { stock: 0, atCoupang: 0, inHouse: 0 };
    const n = Number(p.set_qty) || 1;
    erpStock[p.id] = {
      stock: Math.floor(Math.max(0, b.stock) / n),
      atCoupang: Math.floor(Math.max(0, b.atCoupang) / n),
      inHouse: Math.floor(Math.max(0, b.inHouse) / n),
      bought: 0, sold: 0, boughtHouse: 0, boughtCoupang: 0, coupangUntracked: 0,
      lastCost: effCost(p), isSet: true,
    };
  });
  erpSuppliers = [...new Set([...buys.map(b => b.supplier), ...costs.map(c => c.supplier)].filter(Boolean))];
  // 채널 목록: 등록된 채널 + 과거 매출에 쓰인 채널
  erpChannels = [...new Set([...erpChannelList.map(c => c.name), ...sales.map(s => s.channel).filter(Boolean)])];
  return { buys, sales, costs };
}

const tradeTypeOf = p => (p?.trade_type || "사입");
const tradeTypeOfId = id => tradeTypeOf(erpProducts.find(p => p.id === id));

/* ---------- 세트상품 (재고·원가 연동) ----------
   세트상품 = 같은 낱개 상품 N개 묶음 (판매가만 다른 리스팅).
   구성 상품을 지정하면: 세트 판매 → 낱개 재고에서 N개 차감, 원가 = 낱개 원가 × N 자동.
   구성 지정 없이 is_set만 켠 것은 '표기만' — 계산에 영향 없음. */
const isSetProd = p => !!(p?.set_parent_id && Number(p.set_qty) > 0);
const setBaseOf = (p, list) => (p?.set_parent_id ? (list || erpProducts).find(x => x.id === p.set_parent_id) : null);
// 유효 원가: 연동 세트는 '낱개 원가 × 구성 수량'으로 항상 자동 계산 (낱개 원가가 바뀌면 따라 바뀜)
function effCost(p, list) {
  if (!p) return 0;
  const b = setBaseOf(p, list);
  return b ? (Number(b.cost_price) || 0) * (Number(p.set_qty) || 0) : (Number(p.cost_price) || 0);
}
const effCostOf = pid => effCost(erpProducts.find(p => p.id === pid));

/* ---------- 검색형 품목 선택 ----------
   상품이 늘어나면 드롭다운 스크롤은 감당이 안 된다. 이름 몇 글자나 상품코드를 치면 후보가 좁혀지게.
   선택된 상품 id는 input.dataset.pid에 담고, 읽을 때는 pidOf()를 쓴다. */
function productPickList(mode) {
  return (mode === "buy"
    ? erpProducts.filter(p => tradeTypeOf(p) === "사입" && !isSetProd(p))
    : erpProducts);
}
// 후보 목록에 표시할 한 줄 (코드까지 넣어 코드로도 검색되게)
function productPickLabel(p, mode) {
  const tag = mode === "buy"
    ? (p.cost_price ? `원가 ₩${fmt(p.cost_price)}` : "원가 미등록")
    : isSetProd(p)
      ? `세트×${p.set_qty}${tradeTypeOf(p) === "사입" ? ` · ${fmt(erpStock[p.id]?.stock || 0)}세트 가능` : ""}`
      : (tradeTypeOf(p) === "위탁" ? "위탁" : `재고 ${fmt(erpStock[p.id]?.stock || 0)}`) + (p.is_set ? " · 세트" : "");
  return `${p.code ? p.code + " · " : ""}${p.name} (${tag})`;
}
let __pickSeq = 0;
function productPicker(cls, sel, mode, onPick) {
  const id = `pk${++__pickSeq}`;
  const p = sel ? erpProducts.find(x => x.id === sel) : null;
  return `<input class="${cls} prod-pick" list="${id}" data-pid="${p ? p.id : ""}" data-mode="${mode || ""}"
      data-onpick="${onPick || ""}" value="${p ? esc(productPickLabel(p, mode)) : ""}"
      placeholder="상품명·코드 입력" autocomplete="off" oninput="onProductPick(this)">
    <datalist id="${id}">${productPickList(mode).map(x =>
      `<option value="${esc(productPickLabel(x, mode))}"></option>`).join("")}</datalist>`;
}
// 입력값 → 상품 id 해석. 완전히 일치하면 확정, 아니면 후보가 딱 하나일 때만 확정
function onProductPick(el) {
  const mode = el.dataset.mode || "";
  const list = productPickList(mode);
  const v = String(el.value || "").trim().toLowerCase();
  const norm = s => String(s || "").toLowerCase().replace(/\s+/g, "");
  let hit = list.find(x => productPickLabel(x, mode).toLowerCase() === v);
  if (!hit && v) {
    const cand = list.filter(x =>
      norm(productPickLabel(x, mode)).includes(norm(v)) || norm(x.code).includes(norm(v)));
    if (cand.length === 1) hit = cand[0];
  }
  el.dataset.pid = hit ? hit.id : "";
  el.style.borderColor = v && !hit ? "#d9480f" : "";
  if (hit && el.dataset.onpick && typeof window[el.dataset.onpick] === "function") window[el.dataset.onpick](el);
}
const pidOf = el => (el ? (el.dataset ? el.dataset.pid || "" : el.value || "") : "");

function productOptions(sel, mode) {
  // 매입은 사입 상품만 대상 (위탁은 우리가 사입하지 않음). 연동 세트는 매입 대상이 아님 — 낱개로 사서 묶는 것
  const list = mode === "buy"
    ? erpProducts.filter(p => tradeTypeOf(p) === "사입" && !isSetProd(p))
    : erpProducts;
  return `<option value="">품목 선택</option>` + list.map(p => {
    const tag = mode === "buy"
      ? (p.cost_price ? `원가 ₩${fmt(p.cost_price)}` : "원가 미등록") + (p.is_set ? " · 세트" : "")
      : isSetProd(p)
        ? `세트×${p.set_qty}${tradeTypeOf(p) === "사입" ? ` · ${fmt(erpStock[p.id]?.stock || 0)}세트 가능` : ""}`
        : (tradeTypeOf(p) === "위탁" ? "위탁" : `재고 ${fmt(erpStock[p.id]?.stock || 0)}`) + (p.is_set ? " · 세트" : "");
    return `<option value="${p.id}" ${p.id === sel ? "selected" : ""}>${esc(p.name)} (${tag})</option>`;
  }).join("");
}

function erpSummaryCards(rows, label) {
  const total = rows.reduce((s, r) => s + Number(r.amount), 0);
  return `
    <div class="grid-stats">
      <div class="stat"><div class="stat-label">${erpMonth} ${label} 합계</div>
        <div class="stat-value blue">₩${fmt(total)}</div></div>
      <div class="stat"><div class="stat-label">${erpMonth} ${label} 건수</div>
        <div class="stat-value">${rows.length}건</div></div>
    </div>`;
}

function monthPicker() {
  return `<input type="month" value="${erpMonth}" style="border:1.5px solid var(--line);border-radius:9px;padding:8px 12px"
    onchange="if(this.value){erpMonth=this.value;route()}else{this.value=erpMonth}">`;
}

/* ---------- 매출 (전표식 다품목 입력) ---------- */
async function viewSales() {
  const { sales } = await loadErpBase();
  const rows = sales.filter(r => monthOf(r) === erpMonth);
  erpRowsCache = rows;
  const byChannel = {};
  rows.forEach(r => { byChannel[r.channel || "기타"] = (byChannel[r.channel || "기타"] || 0) + Number(r.amount); });

  return `
    <div class="card">
      <div class="card-head"><h2>매출 입력</h2>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn sm secondary" onclick="downloadXlsTemplate('sales')" title="엑셀 업로드용 표준 양식 내려받기">양식↓</button>
          <button class="btn sm secondary" onclick="openExcelImport('sales')">📎 엑셀 업로드</button>
          <button class="btn sm secondary" onclick="addSaleRow()">＋ 품목 추가</button>
        </div></div>
      <div class="form-grid" style="margin-bottom:10px">
        <div class="field"><label>판매일 *</label><input id="s-date" type="date" value="${today()}"></div>
        <div class="field"><label>판매 채널
          <a onclick="location.hash='#/channels'" style="color:var(--brand);font-size:12px;cursor:pointer;font-weight:400">＋채널 관리</a></label>
          <select id="s-channel">
            <option value="">채널을 선택하세요</option>
            ${erpChannels.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join("")}
            <option value="기타">기타</option>
          </select></div>
      </div>
      <div class="table-wrap"><table class="items-table">
        <thead><tr><th style="min-width:190px">품목 (현재 재고)</th><th style="width:85px" class="num">수량</th>
          <th style="width:150px" class="num">판매 단가${vatTag("sale")}</th>
          <th style="width:110px" class="num">금액</th><th>적요 (주문번호)</th><th style="width:40px"></th></tr></thead>
        <tbody id="sale-rows"></tbody>
      </table></div>
      <p style="font-size:12px;color:var(--text-sub);margin:6px 0 0">
        ※ 단가는 <b>${vatCfg.salePriceIncludesVat ? "고객이 실제로 낸 금액(부가세 포함)" : "부가세를 뺀 공급가액"}</b>으로 입력하세요.
        ${vatCfg.salePriceIncludesVat ? "예) 쿠팡 판매가 11,900원 → 11900" : "예) 공급가액 10,818원 → 10818"}<br>
        ※ 같은 주문의 여러 품목은 <b>적요에 같은 주문번호</b>를 적어 주세요 — 배송비가 주문당 1회만 계산됩니다.</p>
      <div class="total-line">합계${vatTag("sale")} <b id="s-total">₩0</b></div>
      <div class="modal-actions"><button class="btn" id="btn-save-sales" onclick="saveSales()">매출 저장</button></div>
    </div>

    <div class="card">
      <div class="card-head"><h2>매출 내역</h2>
        <div style="display:flex;gap:8px;align-items:center">
          ${monthPicker()}
          <button class="btn sm secondary" onclick="exportErpCSV('sales')">CSV</button>
        </div></div>
      ${erpSummaryCards(rows, "매출")}
      ${Object.keys(byChannel).length ? `<p style="color:var(--text-sub);font-size:13px;margin-bottom:10px">채널별: ${
        Object.entries(byChannel).map(([c, v]) => `${esc(c)} ₩${fmt(v)}`).join(" · ")}</p>` : ""}
      <div class="table-wrap"><table>
        <thead><tr><th>판매일</th><th>품목</th><th>채널</th><th class="num">수량</th><th class="num">단가</th><th class="num">금액</th><th>적요</th><th>입력자</th><th></th></tr></thead>
        <tbody>${rows.length ? rows.map(r => `
          <tr>
            <td>${esc(r.date)}</td>
            <td><b>${esc(prodName(r.product_id))}</b></td>
            <td>${esc(r.channel)}</td>
            <td class="num">${fmt(r.qty)}</td>
            <td class="num">₩${fmt(r.unit_price)}</td>
            <td class="num"><b>₩${fmt(r.amount)}</b></td>
            <td style="max-width:140px;overflow:hidden;text-overflow:ellipsis">${esc(r.memo)}</td>
            <td>${esc(r.created_by)}</td>
            <td style="white-space:nowrap">
              <button class="btn sm secondary" onclick="openErpEditModal('sales','${r.id}')">수정</button>
              <button class="btn sm danger" onclick="deleteErpRow('sales','${r.id}')">삭제</button></td>
          </tr>`).join("") : `<tr><td colspan="9" class="empty">${erpMonth}월 매출이 없습니다</td></tr>`}
        </tbody>
      </table></div>
    </div>`;
}

function addSaleRow() {
  const tbody = document.getElementById("sale-rows");
  if (!tbody) return;
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td>${productPicker("sr-prod", "", "", "onSaleRowProduct")}</td>
    <td><input class="sr-qty" type="number" min="1" value="1" oninput="calcSalesTotal()"></td>
    <td><input class="sr-price comma" type="text" inputmode="numeric" placeholder="0" oninput="calcSalesTotal()"></td>
    <td class="num sr-amt" style="font-weight:700">₩0</td>
    <td><input class="sr-memo" placeholder="주문번호 등" maxlength="100"></td>
    <td><button class="btn-row-del" title="삭제" onclick="this.closest('tr').remove();calcSalesTotal()">✕</button></td>`;
  tbody.appendChild(tr);
}
function onSaleRowProduct(sel) {
  const p = erpProducts.find(x => x.id === pidOf(sel));
  if (p) sel.closest("tr").querySelector(".sr-price").value = p.price ? fmt(p.price) : "";
  calcSalesTotal();
}
function calcSalesTotal() {
  let total = 0;
  document.querySelectorAll("#sale-rows tr").forEach(tr => {
    const amt = (numOf(tr.querySelector(".sr-qty").value) || 0) * (numOf(tr.querySelector(".sr-price").value) || 0);
    tr.querySelector(".sr-amt").textContent = "₩" + fmt(amt);
    total += amt;
  });
  const el = document.getElementById("s-total");
  if (el) el.textContent = "₩" + fmt(total);
}

async function saveSales() {
  const date = document.getElementById("s-date").value;
  const channel = document.getElementById("s-channel").value.trim();
  if (!date) return toast("판매일을 선택해 주세요");
  // 채널이 틀리면 수수료·쿠팡 재고까지 어긋나므로 기본 선택으로 두지 않음
  if (!channel) return toast("판매 채널을 선택해 주세요");
  const recs = [];
  const qtyByPid = {};
  const priceWarns = [];
  for (const tr of document.querySelectorAll("#sale-rows tr")) {
    const pid = pidOf(tr.querySelector(".sr-prod"));
    const qty = numOf(tr.querySelector(".sr-qty").value) || 0;
    const price = numOf(tr.querySelector(".sr-price").value) || 0;
    if (!pid && !price) continue; // 빈 줄은 건너뜀
    if (!pid) return toast("품목을 선택해 주세요");
    if (qty <= 0) return toast("수량은 1 이상이어야 합니다");
    if (!Number.isInteger(qty)) return toast("수량은 정수로 입력해 주세요");
    if (price <= 0) return toast(`'${prodName(pid)}'의 단가를 입력해 주세요`);
    // 등록 판매가와 크게 다르면 0을 더 붙였을 가능성이 큼
    const listed = Number(erpProducts.find(p => p.id === pid)?.price) || 0;
    if (listed && (price >= listed * 5 || price * 5 <= listed)) {
      priceWarns.push(`'${prodName(pid)}' 단가 ₩${fmt(price)} (등록 판매가 ₩${fmt(listed)})`);
    }
    qtyByPid[pid] = (qtyByPid[pid] || 0) + qty;
    recs.push({ date, channel, product_id: pid, qty, unit_price: price, amount: qty * price,
      // 판매 시점 원가를 남겨야 나중에 원가가 바뀌어도 과거 이익이 흔들리지 않음 (세트는 낱개 원가 × 구성 수량)
      unit_cost: effCostOf(pid) || null,
      memo: tr.querySelector(".sr-memo").value.trim(), created_by: me.name });
  }
  if (!recs.length) return toast("품목을 1개 이상 입력해 주세요");
  if (priceWarns.length && !confirm(
    `단가가 평소와 많이 다릅니다. 자릿수를 확인해 주세요.\n\n${priceWarns.join("\n")}\n\n이대로 저장할까요?`)) return;
  // 같은 품목이 여러 줄이면 합산해서 비교해야 함 (줄마다 따로 보면 초과를 놓침)
  const stockWarns = Object.entries(qtyByPid)
    .filter(([pid, q]) => tradeTypeOfId(pid) === "사입" && q > (erpStock[pid]?.stock ?? 0))
    .map(([pid, q]) => `'${prodName(pid)}' 재고 ${fmt(erpStock[pid]?.stock ?? 0)} < 판매 ${fmt(q)}`);
  if (stockWarns.length && !confirm(
    `재고보다 많은 수량입니다.\n\n${stockWarns.join("\n")}\n\n그래도 저장할까요?`)) return;
  const btn = document.getElementById("btn-save-sales");
  btn.disabled = true;
  const { error } = await sb.from("sales").insert(recs);
  if (error) { btn.disabled = false; return toast("저장에 실패했습니다"); }
  toast(`매출 ${recs.length}건 저장되었습니다`);
  erpMonth = date.slice(0, 7);
  route();
}

/* ---------- 매입 (전표식 다품목 입력) ---------- */
async function viewPurchases() {
  const { buys, costs } = await loadErpBase();
  const rows = buys.filter(r => monthOf(r) === erpMonth);
  const costRows = costs.filter(r => monthOf(r) === erpMonth);
  erpRowsCache = rows;
  erpCostsCache = costRows;
  const goodsTotal = rows.reduce((s, r) => s + Number(r.amount), 0);
  const shipTotal = costRows.filter(c => c.kind === "택배비").reduce((s, c) => s + Number(c.amount), 0);
  const freightTotal = costRows.filter(c => c.kind === "운송비").reduce((s, c) => s + Number(c.amount), 0);

  return `
    <div class="card">
      <div class="card-head"><h2>매입 입력 (사입)</h2>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn sm secondary" onclick="downloadXlsTemplate('purchases')" title="엑셀 업로드용 표준 양식 내려받기">양식↓</button>
          <button class="btn sm secondary" onclick="openExcelImport('purchases')">📎 엑셀 업로드</button>
          <button class="btn sm secondary" onclick="addBuyRow()">＋ 품목 추가</button>
        </div></div>
      <div class="form-grid" style="margin-bottom:10px">
        <div class="field"><label>매입일 *</label><input id="b-date" type="date" value="${today()}"></div>
        <div class="field"><label>거래처 *
          <a onclick="location.hash='#/suppliers'" style="color:var(--brand);font-size:12px;cursor:pointer;font-weight:400">＋거래처 관리</a></label>
          ${supplierOptionsHtml()}</div>
        <div class="field"><label>입고처 *</label>
          <select id="b-warehouse">
            <option value="자사창고">자사창고 — 우리 창고로 들어옴</option>
            <option value="쿠팡">쿠팡 (로켓그로스) — 공급처에서 바로 입고</option>
          </select></div>
        <div class="field"><label>택배비(원) — 상품값과 별도${vatTag("exp")}</label><input id="b-ship" type="text" inputmode="numeric" class="comma" placeholder="0"></div>
        <div class="field"><label>운송비(원) — 상품값과 별도${vatTag("exp")}</label><input id="b-freight" type="text" inputmode="numeric" class="comma" placeholder="0"></div>
      </div>
      <div class="table-wrap"><table class="items-table">
        <thead><tr><th style="min-width:190px">품목 (등록 원가)</th><th style="width:85px" class="num">수량</th>
          <th style="width:150px" class="num">매입 단가${vatTag("buy")}</th>
          <th style="width:110px" class="num">금액</th><th>적요 (발주번호)</th><th style="width:40px"></th></tr></thead>
        <tbody id="buy-rows"></tbody>
      </table></div>
      <p style="font-size:12px;color:var(--text-sub);margin:6px 0 0">
        ※ 단가는 <b>${vatCfg.purchaseCostIncludesVat ? "부가세까지 낸 금액" : "세금계산서의 공급가액(부가세 뺀 금액)"}</b>으로 입력하세요.
        ${vatCfg.purchaseCostIncludesVat ? "예) 총 6,050원 지급 → 6050" : "예) 공급가액 5,500 + 부가세 550 = 6,050원 지급이면 → 5500"}</p>
      <div class="total-line">상품 합계${vatTag("buy")} <b id="b-total">₩0</b></div>
      <div class="modal-actions"><button class="btn" id="btn-save-buys" onclick="savePurchases()">매입 저장</button></div>
    </div>

    <div class="card">
      <div class="card-head"><h2>매입 내역</h2>
        <div style="display:flex;gap:8px;align-items:center">
          ${monthPicker()}
          <button class="btn sm secondary" onclick="exportErpCSV('purchases')">CSV</button>
        </div></div>
      <div class="grid-stats">
        <div class="stat"><div class="stat-label">${erpMonth} 상품 매입</div>
          <div class="stat-value blue">₩${fmt(goodsTotal)}</div></div>
        <div class="stat"><div class="stat-label">택배비</div>
          <div class="stat-value amber">₩${fmt(shipTotal)}</div></div>
        <div class="stat"><div class="stat-label">운송비</div>
          <div class="stat-value amber">₩${fmt(freightTotal)}</div></div>
        <div class="stat"><div class="stat-label">총 매입 (상품+부대비용)</div>
          <div class="stat-value">₩${fmt(goodsTotal + shipTotal + freightTotal)}</div></div>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>매입일</th><th>품목</th><th>거래처</th><th>입고처</th><th class="num">수량</th><th class="num">단가</th><th class="num">금액</th><th>적요</th><th>입력자</th><th></th></tr></thead>
        <tbody>${rows.length ? rows.map(r => `
          <tr>
            <td>${esc(r.date)}</td>
            <td><b>${esc(prodName(r.product_id))}</b></td>
            <td>${esc(r.supplier)}</td>
            <td>${r.warehouse === "쿠팡" ? '<span class="chip mine">쿠팡 직송</span>' : '<span style="color:var(--text-sub)">자사창고</span>'}</td>
            <td class="num">${fmt(r.qty)}</td>
            <td class="num">₩${fmt(r.unit_cost)}</td>
            <td class="num"><b>₩${fmt(r.amount)}</b></td>
            <td style="max-width:140px;overflow:hidden;text-overflow:ellipsis">${esc(r.memo)}</td>
            <td>${esc(r.created_by)}</td>
            <td style="white-space:nowrap">
              <button class="btn sm secondary" onclick="openErpEditModal('purchases','${r.id}')">수정</button>
              <button class="btn sm danger" onclick="deleteErpRow('purchases','${r.id}')">삭제</button></td>
          </tr>`).join("") : `<tr><td colspan="10" class="empty">${erpMonth}월 매입이 없습니다</td></tr>`}
        </tbody>
      </table></div>
    </div>

    <div class="card">
      <h2>부대비용 내역 (택배비 · 운송비)</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>일자</th><th>구분</th><th>거래처</th><th class="num">금액</th><th>입력자</th><th></th></tr></thead>
        <tbody>${costRows.length ? costRows.map(c => `
          <tr>
            <td>${esc(c.date)}</td>
            <td>${c.kind === "택배비" ? '<span class="chip mine">택배비</span>' : '<span class="chip waiting">운송비</span>'}</td>
            <td>${esc(c.supplier)}</td>
            <td class="num"><b>₩${fmt(c.amount)}</b></td>
            <td>${esc(c.created_by)}</td>
            <td><button class="btn sm danger" onclick="deleteErpRow('purchase_costs','${c.id}')">삭제</button></td>
          </tr>`).join("") : `<tr><td colspan="6" class="empty">${erpMonth}월 부대비용이 없습니다</td></tr>`}
        </tbody>
      </table></div>
      <p style="color:var(--text-sub);font-size:12px;margin-top:10px">
        ※ 택배비·운송비는 상품 매입액과 분리 집계되며, 재고 단가에는 포함되지 않습니다.
      </p>
    </div>`;
}

function addBuyRow() {
  const tbody = document.getElementById("buy-rows");
  if (!tbody) return;
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td>${productPicker("br-prod", "", "buy", "onBuyRowProduct")}</td>
    <td><input class="br-qty" type="number" min="1" value="1" oninput="calcBuysTotal()"></td>
    <td><input class="br-cost comma" type="text" inputmode="numeric" placeholder="0" oninput="calcBuysTotal()"></td>
    <td class="num br-amt" style="font-weight:700">₩0</td>
    <td><input class="br-memo" placeholder="발주번호 등" maxlength="100"></td>
    <td><button class="btn-row-del" title="삭제" onclick="this.closest('tr').remove();calcBuysTotal()">✕</button></td>`;
  tbody.appendChild(tr);
}
function onBuyRowProduct(sel) {
  // 해당 품목의 최근 매입단가 자동 입력
  const st = erpStock[pidOf(sel)];
  if (st?.lastCost) sel.closest("tr").querySelector(".br-cost").value = fmt(st.lastCost);
  calcBuysTotal();
}
function calcBuysTotal() {
  let total = 0;
  document.querySelectorAll("#buy-rows tr").forEach(tr => {
    const amt = (numOf(tr.querySelector(".br-qty").value) || 0) * (numOf(tr.querySelector(".br-cost").value) || 0);
    tr.querySelector(".br-amt").textContent = "₩" + fmt(amt);
    total += amt;
  });
  const el = document.getElementById("b-total");
  if (el) el.textContent = "₩" + fmt(total);
}

async function savePurchases() {
  const date = document.getElementById("b-date").value;
  const supplier = document.getElementById("b-supplier").value.trim();
  if (!date) return toast("매입일을 선택해 주세요");
  if (!supplier) return toast("거래처를 선택해 주세요 (매입 거래처 화면에서 등록할 수 있습니다)");
  const ship = numOf(document.getElementById("b-ship").value) || 0;
  const freight = numOf(document.getElementById("b-freight").value) || 0;
  const recs = [];
  for (const tr of document.querySelectorAll("#buy-rows tr")) {
    const pid = pidOf(tr.querySelector(".br-prod"));
    const qty = numOf(tr.querySelector(".br-qty").value) || 0;
    const cost = numOf(tr.querySelector(".br-cost").value) || 0;
    if (!pid && !cost) continue;
    if (!pid) return toast("품목을 선택해 주세요");
    if (qty <= 0) return toast("수량은 1 이상이어야 합니다");
    if (!Number.isInteger(qty)) return toast("수량은 정수로 입력해 주세요");
    // 0원 매입이 들어가면 그 상품의 '최근 매입단가'가 0이 되어 재고 평가액과 이익이 전부 망가짐
    if (cost <= 0) return toast(`'${prodName(pid)}'의 매입 단가를 입력해 주세요`);
    recs.push({ date, supplier, product_id: pid, qty, unit_cost: cost, amount: qty * cost,
      warehouse: document.getElementById("b-warehouse")?.value || "자사창고",
      memo: tr.querySelector(".br-memo").value.trim(), created_by: me.name });
  }
  if (!recs.length && !ship && !freight) return toast("품목 또는 부대비용을 입력해 주세요");
  const btn = document.getElementById("btn-save-buys");
  btn.disabled = true;
  // 부대비용을 먼저 넣는다 — 상품 매입이 커밋된 뒤 실패하면 재시도 시 매입이 중복되기 때문
  const costRecs = [];
  if (ship > 0) costRecs.push({ date, kind: "택배비", amount: ship, supplier, created_by: me.name });
  if (freight > 0) costRecs.push({ date, kind: "운송비", amount: freight, supplier, created_by: me.name });
  let costIds = [];
  if (costRecs.length) {
    const ins = await sb.from("purchase_costs").insert(costRecs).select("id");
    if (ins.error) { btn.disabled = false; return toast("부대비용 저장에 실패했습니다 (매입은 아직 저장되지 않았습니다)"); }
    costIds = (ins.data || []).map(x => x.id);
  }
  if (recs.length) {
    const { error } = await sb.from("purchases").insert(recs);
    if (error) {
      btn.disabled = false;
      // 부대비용만 남으면 이중 계상이 되므로, 방금 넣은 행만 정확히 되돌린다
      // (날짜·거래처로 지우면 같은 날 같은 거래처의 기존 부대비용까지 지워질 수 있음)
      if (costIds.length) await sb.from("purchase_costs").delete().in("id", costIds);
      return toast("저장에 실패했습니다");
    }
  }
  toast(`저장되었습니다 (상품 ${recs.length}건${costRecs.length ? ", 부대비용 " + costRecs.length + "건" : ""})`);
  erpMonth = date.slice(0, 7);
  route();
}

/* ---------- 엑셀 업로드 → 초안 확인 → 승인 등록 ---------- */
let xlsDraft = null;

// 열 제목 인식 키워드 — code를 product보다 먼저 검사해야 "상품코드"가 상품명으로 오인되지 않음
const XLS_KEYS = [
  ["code", ["상품코드", "품목코드", "제품코드", "코드", "sku", "code"]],
  ["date", ["판매일", "매입일", "거래일", "주문일", "날짜", "일자", "date"]],
  ["product", ["상품명", "제품명", "품목명", "품명", "상품", "제품", "품목", "product"]],
  ["qty", ["수량", "판매수량", "매입수량", "개수", "qty", "ea"]],
  ["price", ["단가", "판매단가", "매입단가", "판매가", "가격", "price"]],
  ["amount", ["금액", "합계", "총액", "공급가액", "판매금액", "매입금액", "amount"]],
  ["channel", ["판매채널", "판매처", "채널", "쇼핑몰", "몰"]],
  ["supplier", ["거래처", "공급처", "매입처", "공급자"]],
  ["memo", ["적요", "메모", "비고", "주문번호", "발주번호", "note"]],
];
const XLS_LABEL = { code: "상품코드", date: "날짜", product: "상품명", qty: "수량",
  price: "단가", amount: "금액", channel: "채널", supplier: "거래처", memo: "적요" };
const xlsNorm = s => String(s ?? "").toLowerCase().replace(/[\s()\[\]·,\-_]/g, "");
const xlsNum = v => Number(String(v ?? "").replace(/[^\d.\-]/g, "")) || 0;

function xlsDateOf(v) {
  if (v instanceof Date && !isNaN(v)) return `${v.getFullYear()}-${pad2(v.getMonth() + 1)}-${pad2(v.getDate())}`;
  if (typeof v === "number" && v > 20000 && v < 60000) {
    // 엑셀 날짜 일련번호 (1900-01-01 기준)
    return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
  }
  const s = String(v ?? "").trim();
  let m = s.match(/(\d{4})[.\-\/년\s]+(\d{1,2})[.\-\/월\s]+(\d{1,2})/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  m = s.match(/^(\d{1,2})[.\-\/월\s]+(\d{1,2})일?$/);
  if (m) {
    // 연도가 없으면 올해로 보되, 그러면 미래가 되는 경우(연초에 작년 12월 파일)엔 작년으로
    const y = Number(today().slice(0, 4));
    const guess = `${y}-${pad2(m[1])}-${pad2(m[2])}`;
    return guess > today() ? `${y - 1}-${pad2(m[1])}-${pad2(m[2])}` : guess;
  }
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);          // 20260823
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return "";
}

function xlsMatchProduct(nameRaw, codeRaw, isSale) {
  const list = isSale ? erpProducts : erpProducts.filter(p => tradeTypeOf(p) === "사입" && !isSetProd(p));
  const code = xlsNorm(codeRaw), name = xlsNorm(nameRaw);
  let p = null;
  if (code) p = list.find(x => xlsNorm(x.code) === code);
  if (!p && name) p = list.find(x => xlsNorm(x.name) === name) || list.find(x => xlsNorm(x.code) === name);
  if (!p && name && name.length >= 3) p = list.find(x => xlsNorm(x.name).includes(name) || name.includes(xlsNorm(x.name)));
  return p || null;
}

function openExcelImport(mode) {
  if (typeof XLSX === "undefined") return toast("엑셀 모듈을 아직 불러오지 못했습니다. 잠시 후 다시 시도해 주세요");
  let inp = document.getElementById("xls-file");
  if (!inp) {
    inp = document.createElement("input");
    inp.type = "file"; inp.id = "xls-file"; inp.accept = ".xlsx,.xls,.csv"; inp.style.display = "none";
    document.body.appendChild(inp);
  }
  inp.value = "";
  inp.onchange = () => { if (inp.files[0]) parseExcelFile(inp.files[0], mode); };
  inp.click();
}

function parseExcelFile(file, mode) {
  const reader = new FileReader();
  reader.onload = e => {
    let wsRows;
    try {
      const wb = XLSX.read(new Uint8Array(e.target.result), { type: "array", cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      wsRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
    } catch (err) { return toast("파일을 읽지 못했습니다. 엑셀(.xlsx) 파일인지 확인해 주세요"); }
    buildExcelDraft(wsRows, mode);
  };
  reader.readAsArrayBuffer(file);
}

function buildExcelDraft(wsRows, mode) {
  const isSale = mode === "sales";
  // 첫 20줄에서 열 제목 줄을 자동 탐색
  let headIdx = -1, colMap = null, bestScore = 0;
  for (let i = 0; i < Math.min(wsRows.length, 20); i++) {
    const map = {};
    (wsRows[i] || []).forEach((cell, ci) => {
      const t = xlsNorm(cell);
      if (!t || Object.values(map).includes(ci)) return;
      for (const [key, kws] of XLS_KEYS) {
        if (map[key] !== undefined) continue;
        if (kws.some(k => t === xlsNorm(k) || t.includes(xlsNorm(k)))) { map[key] = ci; return; }
      }
    });
    const score = Object.keys(map).length;
    if (score > bestScore) { bestScore = score; headIdx = i; colMap = map; }
  }
  if (bestScore < 2 || (colMap.product === undefined && colMap.code === undefined)) {
    return toast("열 제목(상품명·수량 등)을 찾지 못했습니다. '양식↓' 버튼의 표준 양식을 참고해 주세요");
  }
  const rows = [];
  for (let i = headIdx + 1; i < wsRows.length; i++) {
    const r = wsRows[i] || [];
    const get = k => (colMap[k] !== undefined ? r[colMap[k]] : "");
    const prodText = String(get("product") ?? "").trim() || String(get("code") ?? "").trim();
    const qtyRaw = xlsNum(get("qty"));
    const amount = xlsNum(get("amount"));
    if (!prodText && !qtyRaw && !amount) continue;       // 빈 줄
    if (/합계|총계|소계/.test(prodText)) continue;        // 합계 줄 제외
    const p = xlsMatchProduct(get("product"), get("code"), isSale);
    // 값이 없어서 시스템이 대신 채운 항목은 표시해 줘야 사용자가 검토할 수 있음
    const guessed = [];
    const qty = qtyRaw || (guessed.push("수량"), 1);
    let price = xlsNum(get("price"));
    if (!price && amount) price = Math.round(amount / qty);
    // 단가/금액이 아예 없으면 제품 마스터 기준가로 채움 (매출=판매가, 매입=원가)
    if (!price && p) { price = Number(isSale ? p.price : p.cost_price) || 0; if (price) guessed.push("단가"); }
    const parsedDate = xlsDateOf(get("date"));
    if (!parsedDate) guessed.push("날짜");
    rows.push({
      date: parsedDate || today(),
      pid: p ? p.id : "",
      prodText,
      qty, price,
      // 파일에 적힌 금액이 있으면 그대로 보존 (단가 역산 후 재곱하면 원 단위가 어긋남)
      srcAmount: amount || 0,
      guessed,
      party: String(get(isSale ? "channel" : "supplier") ?? "").trim(),
      memo: String(get("memo") ?? "").trim().slice(0, 100),
    });
  }
  if (!rows.length) return toast("읽을 수 있는 데이터 줄이 없습니다");
  if (rows.length > 300) return toast("한 번에 300줄까지만 올릴 수 있습니다. 파일을 나눠 주세요");
  const colNames = Object.entries(colMap)
    .map(([k, ci]) => `${XLS_LABEL[k] || k} ← "${String(wsRows[headIdx][ci]).trim()}"`);
  xlsDraft = { mode, rows, noDateCol: colMap.date === undefined, colNames,
               dateFailed: rows.filter(r => r.guessed.includes("날짜")).length };
  renderExcelPreview();
}

function xlsRowHtml(r, i, isSale) {
  return `
    <tr data-idx="${i}">
      <td><input type="checkbox" class="xr-chk" checked onchange="updateXlsSummary()"></td>
      <td style="white-space:nowrap"><span class="xr-st"></span>${r.guessed?.length
        ? `<div title="파일에 값이 없어 자동으로 채운 항목" style="font-size:11px;color:#d9480f">자동채움<br>${esc(r.guessed.join("·"))}</div>` : ""}</td>
      <td><input type="date" class="xr-date" value="${esc(r.date)}" style="width:130px" onchange="updateXlsSummary()"></td>
      <td>
        <select class="xr-prod" onchange="updateXlsSummary()">${productOptions(r.pid, isSale ? "" : "buy")}</select>
        <div style="font-size:11px;color:${r.pid ? "var(--text-sub)" : "#d9480f"};margin-top:2px">
          원본: ${esc(r.prodText) || "(품목 없음)"}</div>
      </td>
      <td><input type="number" class="xr-qty" min="1" value="${r.qty}" style="width:70px" oninput="updateXlsSummary()"></td>
      <td><input type="text" inputmode="numeric" class="xr-price comma" value="${fmt(r.price)}" style="width:100px" oninput="updateXlsSummary()"></td>
      <td class="num xr-amt" style="font-weight:700"></td>
      <td><input class="xr-party" value="${esc(r.party)}" placeholder="${isSale ? "채널" : "거래처"}" style="width:90px"
        list="${isSale ? "xls-channel-list" : "xls-supplier-list"}"></td>
      <td><input class="xr-memo" value="${esc(r.memo)}" maxlength="100" style="width:110px"></td>
    </tr>`;
}

function renderExcelPreview() {
  const d = xlsDraft;
  const isSale = d.mode === "sales";
  const unmatched = d.rows.filter(r => !r.pid).length;
  document.getElementById("modal-root").innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal" style="max-width:980px;width:96vw">
        <h3>📎 엑셀 초안 확인 — ${isSale ? "매출" : "매입"} ${d.rows.length}줄</h3>
        <p style="font-size:13px;color:var(--text-sub);margin:4px 0 10px">
          엑셀 초안입니다. 확인 후 <b>등록</b>을 누르세요.
          ${unmatched ? `<br>⚠️ 품목을 못 찾은 줄이 <b>${unmatched}건</b> 있습니다 — 직접 선택하거나 체크를 해제해 주세요.` : ""}
          ${d.noDateCol ? `<br>ℹ️ 날짜 열이 없어 전부 오늘 날짜로 넣었습니다. 필요하면 줄마다 고쳐 주세요.` : ""}
          ${d.dateFailed && !d.noDateCol ? `<br>⚠️ 날짜를 읽지 못한 줄이 <b>${d.dateFailed}건</b> 있어 오늘 날짜로 채웠습니다 — 꼭 확인해 주세요.` : ""}</p>
        ${isSale ? "" : `<div class="form-grid" style="margin-bottom:8px">
          <div class="field"><label>입고처 (아래 전체에 적용)</label>
            <select id="xls-warehouse">
              <option value="자사창고">자사창고 — 우리 창고로 들어옴</option>
              <option value="쿠팡">쿠팡 (로켓그로스) — 공급처에서 바로 입고</option>
            </select></div>
        </div>`}
        ${d.colNames?.length ? `<details style="font-size:12px;color:var(--text-sub);margin-bottom:10px">
          <summary style="cursor:pointer">엑셀의 어느 열을 무엇으로 읽었는지 보기 (${d.colNames.length}개)</summary>
          <div style="padding:8px 0 0 6px">${d.colNames.map(esc).join(" · ")}</div>
          <div style="padding-top:4px">※ 잘못 읽었다면 취소하고, [양식↓] 버튼의 표준 양식으로 다시 만들어 주세요.</div>
        </details>` : ""}
        <div class="table-wrap" style="max-height:52vh;overflow:auto"><table>
          <thead><tr><th></th><th>상태</th><th>날짜</th><th style="min-width:200px">품목</th>
            <th class="num">수량</th><th class="num">단가${vatTag(isSale ? "sale" : "buy")}</th><th class="num">금액</th>
            <th>${isSale ? "채널" : "거래처"}</th><th>적요</th></tr></thead>
          <tbody id="xls-rows">${d.rows.map((r, i) => xlsRowHtml(r, i, isSale)).join("")}</tbody>
          <datalist id="xls-channel-list">${erpChannels.map(c => `<option value="${esc(c)}">`).join("")}</datalist>
          <datalist id="xls-supplier-list">${
            [...new Set([...erpSupplierList.filter(s => s.active !== false).map(s => s.name), ...erpSuppliers])]
              .filter(Boolean).map(n => `<option value="${esc(n)}">`).join("")}</datalist>
        </table></div>
        <div class="total-line" id="xls-summary"></div>
        <div class="modal-actions">
          <button class="btn secondary" onclick="closeModal()">취소</button>
          <button class="btn" id="btn-xls-go" onclick="confirmExcelImport()">등록</button>
        </div>
      </div>
    </div>`;
  updateXlsSummary();
}

function updateXlsSummary() {
  let valid = 0, warn = 0, total = 0;
  document.querySelectorAll("#xls-rows tr").forEach(tr => {
    const on = tr.querySelector(".xr-chk").checked;
    const pid = tr.querySelector(".xr-prod").value;
    const date = tr.querySelector(".xr-date").value;
    const qty = numOf(tr.querySelector(".xr-qty").value) || 0;
    const price = numOf(tr.querySelector(".xr-price").value) || 0;
    const amt = qty * price;
    tr.querySelector(".xr-amt").textContent = "₩" + fmt(amt);
    const st = tr.querySelector(".xr-st");
    if (!on) { st.textContent = "제외"; st.style.color = "var(--text-sub)"; tr.style.opacity = ".45"; return; }
    tr.style.opacity = "1";
    // 채널/거래처가 비면 수기 입력과 달리 조용히 통과해 수수료가 0으로 계산됨
    const party = tr.querySelector(".xr-party").value.trim();
    // 단가 0원은 매출·원가를 망가뜨리므로 반드시 확인시킴
    if (!pid || !date || qty <= 0 || price <= 0 || !party) { st.textContent = "⚠️ 확인"; st.style.color = "#d9480f"; warn++; }
    else { st.textContent = "✅"; st.style.color = ""; valid++; total += amt; }
  });
  const sum = document.getElementById("xls-summary");
  const btn = document.getElementById("btn-xls-go");
  if (!sum || !btn) return;
  sum.innerHTML = warn
    ? `⚠️ 확인 필요 <b style="color:#d9480f">${warn}건</b> — 품목·날짜·수량·단가·${xlsDraft?.mode === "sales" ? "채널" : "거래처"}을(를) 채우거나 체크를 해제해 주세요`
    : `등록 대상 <b>${valid}건</b> · 합계 <b>₩${fmt(total)}</b>`;
  btn.disabled = valid === 0 || warn > 0;
  btn.textContent = valid ? `${valid}건 등록` : "등록";
}

async function confirmExcelImport() {
  const isSale = xlsDraft.mode === "sales";
  const recs = [];
  document.querySelectorAll("#xls-rows tr").forEach(tr => {
    if (!tr.querySelector(".xr-chk").checked) return;
    const idx = Number(tr.dataset.idx);
    const src = xlsDraft.rows[idx];
    const pid = tr.querySelector(".xr-prod").value;
    const qty = numOf(tr.querySelector(".xr-qty").value) || 0;
    const price = numOf(tr.querySelector(".xr-price").value) || 0;
    const party = tr.querySelector(".xr-party").value.trim();
    // 파일에 적힌 금액을 그대로 쓴다 (단가를 역산해 다시 곱하면 원 단위가 어긋나고 할인가가 사라짐)
    const keepSrc = src && src.srcAmount > 0 && qty === src.qty && price === src.price;
    const base = {
      date: tr.querySelector(".xr-date").value, product_id: pid, qty,
      amount: keepSrc ? src.srcAmount : qty * price,
      memo: tr.querySelector(".xr-memo").value.trim(), created_by: me.name,
    };
    recs.push(isSale
      ? { ...base, unit_price: price, channel: party || "기타",
          unit_cost: effCostOf(pid) || null }
      : { ...base, unit_cost: price, supplier: party,
          warehouse: document.getElementById("xls-warehouse")?.value || "자사창고" });
  });
  if (!recs.length) return;

  // 같은 파일을 두 번 올리는 사고 방지 — 날짜+품목+수량+금액이 같은 기존 데이터와 대조
  const dates = [...new Set(recs.map(r => r.date))];
  const { data: exist } = await sb.from(isSale ? "sales" : "purchases")
    .select("date,product_id,qty,amount").in("date", dates);
  if (exist?.length) {
    const key = r => `${r.date}|${r.product_id}|${r.qty}|${r.amount}`;
    const existKeys = new Set(exist.map(key));
    const dup = recs.filter(r => existKeys.has(key(r)));
    if (dup.length && !confirm(
      `이미 등록된 것과 완전히 같은 내용이 ${dup.length}건 있습니다.\n`
      + `(같은 날짜·품목·수량·금액)\n\n`
      + `예시: ${dup.slice(0, 3).map(r => `${r.date} ${prodName(r.product_id)} ${r.qty}개`).join(", ")}\n\n`
      + `같은 파일을 두 번 올린 것이라면 [취소]를 누르세요.\n`
      + `실제로 같은 주문이 여러 건이면 [확인]을 눌러 계속하세요.`)) return;
  }

  if (isSale) {
    // 사입 상품 재고 초과 경고 (품목별 합산)
    const byPid = {};
    recs.forEach(r => { byPid[r.product_id] = (byPid[r.product_id] || 0) + r.qty; });
    const warns = Object.entries(byPid)
      .filter(([pid, q]) => tradeTypeOfId(pid) === "사입" && q > (erpStock[pid]?.stock ?? 0))
      .map(([pid, q]) => `'${prodName(pid)}' 재고(${fmt(erpStock[pid]?.stock ?? 0)}) < 판매수량(${fmt(q)})`);
    if (warns.length && !confirm(warns.join("\n") + "\n\n재고보다 많이 팔린 것으로 기록됩니다. 그래도 등록할까요?")) return;
  }
  const btn = document.getElementById("btn-xls-go");
  btn.disabled = true;
  const { error } = await sb.from(isSale ? "sales" : "purchases").insert(recs);
  if (error) { btn.disabled = false; return toast("등록에 실패했습니다. 다시 시도해 주세요"); }
  const months = [...new Set(recs.map(r => r.date.slice(0, 7)))].sort();
  toast(months.length > 1
    ? `엑셀 ${recs.length}건 등록 (${months.join(", ")}) — 달을 바꿔 확인하세요`
    : `엑셀 ${recs.length}건이 등록되었습니다`);
  closeModal();
  xlsDraft = null;
  erpMonth = months[months.length - 1];   // 여러 달이면 가장 최근 달로
  route();
}

function downloadXlsTemplate(mode) {
  const isSale = mode === "sales";
  const vTag = isSale
    ? (vatCfg.salePriceIncludesVat ? "부가세포함" : "부가세별도")
    : (vatCfg.purchaseCostIncludesVat ? "부가세포함" : "부가세별도");
  const rows = isSale
    ? [["판매일", "채널", "상품명", "수량", `단가(${vTag})`, "적요(주문번호)"],
       [today(), "쿠팡 로켓그로스", "(상품명 또는 상품코드)", "3", "15000", "ORD-0001"]]
    : [["매입일", "거래처", "상품명", "수량", `단가(${vTag})`, "적요(발주번호)"],
       [today(), "(등록한 거래처명)", "(상품명 또는 상품코드)", "10", "8000", "PO-0001"]];
  const csv = "﻿" + rows.map(r => r.join(",")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = isSale ? "매출_업로드양식.csv" : "매입_업로드양식.csv";
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------- 개선 요청 · 반복업무 신고 (→ 대표에게 알림) ----------
   반복업무 신고는 자동화 검토의 입력 데이터가 됩니다:
   AI가 주기적으로 [반복업무] 태그를 모아 "자주 하고 규칙이 명확한 일"부터 자동화를 제안합니다. */
function openFeedback() {
  document.getElementById("modal-root").innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal">
        <h3>💬 대표에게 보내기</h3>
        <div style="display:flex;gap:14px;margin:8px 0 10px;font-size:13.5px">
          <label style="display:flex;align-items:center;gap:5px;cursor:pointer">
            <input type="radio" name="fb-kind" value="req" checked onchange="fbKindChange()"> 개선 요청·불편사항</label>
          <label style="display:flex;align-items:center;gap:5px;cursor:pointer">
            <input type="radio" name="fb-kind" value="manual" onchange="fbKindChange()"> 반복업무 신고</label>
        </div>
        <p id="fb-desc" style="font-size:13px;color:var(--text-sub);margin:4px 0 10px">
          불편한 점이나 원하는 기능을 적어 주세요. 대표에게 바로 전달됩니다.</p>
        <div id="fb-extra" class="hidden" style="display:flex;gap:10px;margin-bottom:10px">
          <div class="field" style="flex:1"><label>얼마나 자주?</label>
            <select id="fb-freq"><option>매일</option><option>매주</option><option>매월</option><option>가끔</option></select></div>
          <div class="field" style="flex:1"><label>1회 소요시간(분)</label>
            <input id="fb-mins" type="number" min="1" placeholder="예: 30"></div>
        </div>
        <textarea id="fb-text" rows="5" maxlength="500" placeholder="예) 매출 입력할 때 어제 날짜가 기본이면 좋겠어요"
          style="width:100%;border:1.5px solid var(--line);border-radius:9px;padding:10px;font:inherit;resize:vertical"></textarea>
        <div class="modal-actions">
          <button class="btn secondary" onclick="closeModal()">취소</button>
          <button class="btn" id="btn-fb-send" onclick="sendFeedback()">보내기</button>
        </div>
      </div>
    </div>`;
  document.getElementById("fb-text").focus();
}

function fbKindChange() {
  const manual = document.querySelector('input[name="fb-kind"]:checked')?.value === "manual";
  document.getElementById("fb-extra").classList.toggle("hidden", !manual);
  document.getElementById("fb-desc").innerHTML = manual
    ? `<b>손으로 반복하는 일</b>을 알려주세요. AI가 자동화 방법을 찾아 없애 드립니다.`
    : `불편한 점이나 원하는 기능을 적어 주세요. 대표에게 바로 전달됩니다.`;
  document.getElementById("fb-text").placeholder = manual
    ? "예) 매주 월요일마다 쿠팡 정산 엑셀을 내려받아 순이익을 계산해요"
    : "예) 매출 입력할 때 어제 날짜가 기본이면 좋겠어요";
}

async function sendFeedback() {
  const text = document.getElementById("fb-text").value.trim();
  if (!text) return toast("내용을 입력해 주세요");
  const manual = document.querySelector('input[name="fb-kind"]:checked')?.value === "manual";
  // 최상위 직급(대표)에게 업무 지시 형태로 전달 → 기존 푸시 알림 그대로 활용
  // rank가 비어 있으면 자기 자신에게 보내지므로, 그 경우 결재권자를 우선 찾는다
  const top = USERS.reduce((a, b) => ((Number(b.rank) || 0) > (Number(a?.rank) || 0) ? b : a), null)
    || USERS.find(u => u.approver && u.id !== me.id) || me;
  const btn = document.getElementById("btn-fb-send");
  btn.disabled = true;
  const freq = manual ? document.getElementById("fb-freq").value : "";
  const mins = manual ? numOf(document.getElementById("fb-mins").value) : 0;
  const tag = manual ? "[반복업무]" : "[개선요청]";
  const meta = manual ? `주기: ${freq}${mins ? ` · 1회 약 ${mins}분` : ""}\n` : "";
  const { error } = await sb.from("tasks").insert({
    title: `${tag} ` + text.slice(0, 40) + (text.length > 40 ? "…" : ""),
    detail: meta + text + `\n\n— ${me.name}이(가) ${manual ? "신고한 손으로 하는 반복업무입니다. 자동화 검토 대상입니다." : "앱 사용 중 보낸 개선 요청입니다."}`,
    assignee_id: top.id,
    creator_id: me.id,
    due_date: null,
  });
  if (error) { btn.disabled = false; return toast("전송에 실패했습니다"); }
  toast(manual ? "반복업무를 신고했습니다 (자동화 검토 목록에 추가)" : "개선 요청을 보냈습니다 (알림 발송)");
  closeModal();
}

/* ---------- 내역 수정 / 삭제 / CSV ---------- */
function openErpEditModal(table, id) {
  const r = erpRowsCache.find(x => x.id === id);
  if (!r) return;
  const isSale = table === "sales";
  const root = document.getElementById("modal-root");
  root.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal">
        <h3>${isSale ? "매출" : "매입"} 내역 수정</h3>
        <div class="form-grid">
          <div class="field"><label>${isSale ? "판매일" : "매입일"}</label><input id="e-date" type="date" value="${esc(r.date)}"></div>
          <div class="field"><label>${isSale ? "채널" : "거래처"}</label>
            ${isSale
              ? `<select id="e-party">${[...new Set([...erpChannels, r.channel, "기타"])].filter(Boolean).map(c => `<option ${c === r.channel ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>`
              : `<select id="e-party">${
                  [...new Set([...erpSupplierList.filter(s => s.active !== false).map(s => s.name), ...erpSuppliers, r.supplier])]
                    .filter(Boolean)
                    .map(n => `<option ${n === r.supplier ? "selected" : ""}>${esc(n)}</option>`).join("")}</select>`}</div>
          <div class="field full"><label>품목</label>${productPicker("e-prod", r.product_id, isSale ? "" : "buy")}</div>
          ${isSale ? "" : `<div class="field"><label>입고처</label>
            <select id="e-wh">
              <option value="자사창고" ${r.warehouse !== "쿠팡" ? "selected" : ""}>자사창고</option>
              <option value="쿠팡" ${r.warehouse === "쿠팡" ? "selected" : ""}>쿠팡 (로켓그로스 직송)</option>
            </select></div>`}
          <div class="field"><label>수량</label><input id="e-qty" type="number" min="1" value="${r.qty}"></div>
          <div class="field"><label>단가(원)${vatTag(isSale ? "sale" : "buy")}</label>
            <input id="e-price" type="text" inputmode="numeric" class="comma" value="${cfv(isSale ? r.unit_price : r.unit_cost)}"></div>
          <div class="field full"><label>적요</label><input id="e-memo" value="${esc(r.memo)}" maxlength="100"></div>
        </div>
        <div class="modal-actions">
          <button class="btn secondary" onclick="closeModal()">취소</button>
          <button class="btn" onclick="saveErpEdit('${table}','${id}')">저장</button>
        </div>
      </div>
    </div>`;
}

async function saveErpEdit(table, id) {
  const isSale = table === "sales";
  const pid = pidOf(document.querySelector(".e-prod"));
  const qty = numOf(document.getElementById("e-qty").value) || 0;
  const price = numOf(document.getElementById("e-price").value) || 0;
  if (!pid) return toast("품목을 선택해 주세요");
  if (qty <= 0) return toast("수량은 1 이상이어야 합니다");
  const eDate = document.getElementById("e-date").value;
  // 날짜가 비면 그 내역이 모든 집계에서 사라지므로 반드시 막아야 함
  if (!eDate) return toast("날짜를 입력해 주세요");
  const patch = {
    date: eDate,
    product_id: pid, qty, amount: qty * price,
    memo: document.getElementById("e-memo").value.trim(),
  };
  const party = document.getElementById("e-party").value.trim();
  if (isSale) {
    patch.unit_price = price;
    patch.channel = party || "기타";
    // 품목을 바꾸면 원가 스냅샷도 새 품목 기준으로 갱신 (안 하면 이익 계산이 틀어짐)
    patch.unit_cost = effCostOf(pid) || null;
  } else {
    patch.unit_cost = price; patch.supplier = party;
    // 입고처가 틀리면 자사창고/쿠팡 재고가 서로 어긋나므로 수정할 수 있어야 함
    patch.warehouse = document.getElementById("e-wh")?.value || "자사창고";
  }
  const { data, error } = await sb.from(table).update(patch).eq("id", id).select("id");
  if (error) return toast("수정에 실패했습니다");
  if (!data?.length) return toast("수정할 내역을 찾지 못했습니다 (다른 사람이 이미 삭제했을 수 있습니다)");
  toast("수정되었습니다");
  closeModal();
  route();
}

// 삭제 대상 설명 (무엇을 지우는지 보여줘야 오클릭을 막을 수 있음)
function erpRowLabel(table, id) {
  // 테이블마다 데이터가 있는 캐시가 달라 전부 훑는다
  const row = [...erpRowsCache, ...erpCostsCache, ...profitAdsCache, ...erpTransfers].find(x => x.id === id);
  if (table === "cash_plans") {
    const p = cashPlans.find(x => x.id === id);
    if (!p) return "";
    return `\n\n${p.date} · ${p.kind} · ${p.title} · ₩${fmt(p.amount)}`
      + (p.repeat === "매월" ? "\n\n⚠️ '매월 반복' 계획입니다 — 이번 달뿐 아니라 반복 전체가 삭제됩니다." : "");
  }
  if (!row) return "";
  const who = row.channel || row.supplier || row.kind || "";
  const amt = row.amount != null ? ` · ₩${fmt(row.amount)}` : "";
  const nm = row.product_id ? ` · ${prodName(row.product_id)}` : "";
  const qty = row.qty != null && !row.amount ? ` · ${fmt(row.qty)}개` : "";
  return `\n\n${row.date} · ${who}${nm}${qty}${amt}`;
}

async function deleteErpRow(table, id) {
  const effect = table === "sales" ? "\n(매출을 지우면 재고와 공헌이익이 함께 바뀝니다)"
    : table === "purchases" ? "\n(매입을 지우면 재고가 줄어듭니다)" : "";
  if (!confirm(`이 내역을 삭제할까요?${erpRowLabel(table, id)}${effect}`)) return;
  const { data, error } = await sb.from(table).delete().eq("id", id).select("id");
  if (error) return toast("삭제에 실패했습니다");
  if (!data?.length) return toast("삭제할 내역을 찾지 못했습니다 (이미 삭제되었을 수 있습니다)");
  toast("삭제되었습니다");
  route();
}

function exportErpCSV(table) {
  const isSale = table === "sales";
  const head = isSale
    ? ["판매일", "품목", "채널", "수량", "단가", "금액", "적요", "입력자"]
    : ["매입일", "품목", "거래처", "수량", "단가", "금액", "적요", "입력자"];
  const rows = erpRowsCache.map(r => [
    r.date, prodName(r.product_id), isSale ? r.channel : r.supplier,
    r.qty, isSale ? r.unit_price : r.unit_cost, r.amount, r.memo, r.created_by]);
  const csv = "﻿" + [head, ...rows]
    .map(r => r.map(c => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
  downloadFile(csv, `리버스_${isSale ? "매출" : "매입"}_${erpMonth}.csv`, "text/csv");
}

/* ---------- 재고 · 발주 · 입고 통합 화면(#/stockflow) ---------- */
// 2026-09-04: 기존 4개 화면(재고현황/발주추천/입고계획/쿠팡입고)을 상위
// 메뉴 하나로 묶었어요. 각 탭은 #/stockflow/<tab>으로 기존 라우터가 그대로
// 처리(hash를 '/'로 split해서 param을 넘겨주는 기존 route() 로직 재사용 -
// 새 라우팅 코드를 만들지 않음). 옛 라우트(#/inventory, #/purchasereco,
// #/shipmentplans, #/rginbound)는 전혀 손대지 않아서 그대로 계속 동작해요.
//
// stockFlowCache: purchase_recommendations는 1번(재고현황)과 2번(발주추천)
// 탭이 같은 데이터를 쓰므로, 탭을 오갈 때마다 다시 조회하지 않도록 세션 내
// 한 번만 조회해서 재사용해요("새로고침" 버튼을 누르면 캐시를 비우고 다시
// 조회). 3번(입고계획)/4번(쿠팡입고) 탭은 서로 다른 테이블을 조회하므로
// 공유 캐시 대상이 아니지만, 마찬가지로 한 번 조회한 뒤 탭을 오가도 재조회하지
// 않도록 탭별로 결과를 캐시해요.
let stockFlowCache = { purchaseReco: null, erpBase: null, rgData: null };

async function getStockFlowPurchaseReco() {
  if (!stockFlowCache.purchaseReco) {
    stockFlowCache.purchaseReco = await sb.from("purchase_recommendations").select("*");
  }
  return stockFlowCache.purchaseReco;
}
async function getStockFlowErpBase() {
  if (!stockFlowCache.erpBase) {
    stockFlowCache.erpBase = await loadErpBase();
  }
  return stockFlowCache.erpBase;
}
async function getStockFlowRgData() {
  if (!stockFlowCache.rgData) {
    stockFlowCache.rgData = await Promise.all([
      sb.from("inbound_plans").select("*").order("created_at", { ascending: false }),
      sb.from("inbound_plan_items").select("*"),
    ]);
  }
  return stockFlowCache.rgData;
}
function stockFlowRefresh() {
  stockFlowCache = { purchaseReco: null, erpBase: null, rgData: null };
  route();
}

const STOCKFLOW_TABS = [
  ["stock", "📦 재고현황"],
  ["reco", "📈 발주추천"],
  ["plan", "🚚 입고계획"],
  ["rginbound", "🚀 쿠팡입고"],
];

async function viewStockFlow(tab) {
  tab = STOCKFLOW_TABS.some(t => t[0] === tab) ? tab : "stock";
  let body;
  if (tab === "stock") {
    body = await viewInventory(await getStockFlowErpBase(), await getStockFlowPurchaseReco());
  } else if (tab === "reco") {
    body = await viewPurchaseReco(await getStockFlowPurchaseReco());
  } else if (tab === "plan") {
    body = await viewShipmentPlans();
  } else {
    body = await viewRgInbound(await getStockFlowRgData());
  }
  return `
    <div class="card" style="padding:8px 12px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:14px">
      ${STOCKFLOW_TABS.map(([key, label]) => `
        <button class="btn sm ${tab === key ? "" : "secondary"}" onclick="location.hash='#/stockflow/${key}'">${label}</button>
      `).join("")}
      <span style="flex:1"></span>
      <button class="btn sm secondary" onclick="stockFlowRefresh()" title="탭 캐시를 비우고 새로 조회">🔄 새로고침</button>
    </div>
    ${body}`;
}

/* 판매속도·발주예상 표 - purchase_recommendations를 그대로 재사용(계산은
   GCP가 이미 끝냄, 여기서는 조회+표시만). preloaded를 안 주면 직접 조회. */
async function renderStockVelocityTable(preloaded) {
  const { data, error } = preloaded || await sb.from("purchase_recommendations").select("*");
  if (error) {
    return `<div class="card"><p class="empty">판매속도·발주예상 데이터를 불러오지 못했습니다.</p></div>`;
  }
  const rows = (data || []).filter(r => r.is_active !== false);
  const sorted = [...rows].sort((a, b) => {
    const da = a.stock_days ?? Infinity, db = b.stock_days ?? Infinity;
    if (da !== db) return da - db;
    return (a.product_name || "").localeCompare(b.product_name || "", "ko");
  });
  return `
    <div class="card">
      <div class="card-head"><h2>판매속도 · 발주 예상</h2>
        <span style="font-size:12px;color:var(--text-sub)">"무엇이 언제 부족해지는가" — 발주 의사결정(추천수량 등)은 <a onclick="location.hash='#/stockflow/reco'" style="color:var(--brand);cursor:pointer">발주 추천 탭</a>에서</span></div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th>상품</th><th class="num">최근7일</th><th class="num">최근30일</th><th class="num">일평균</th>
          <th class="num">예상소진일</th><th>발주예상일</th><th class="num">안전재고일</th><th>재고상태</th>
        </tr></thead>
        <tbody>${sorted.length ? sorted.map(r => {
          const [cls, label] = PR_STATUS_CHIP[r.status] || ["waiting", r.status];
          const isChild = r.shared_inventory?.role === "child";
          // 세트상품(child)은 물리재고가 없고 base와 공유하므로(SSOT는
          // products.set_parent_id/set_qty), current_stock=0 기준으로 계산된
          // 예상소진일/발주예상일/안전재고일/재고상태를 그대로 보여주면 "진짜
          // 재고 0"처럼 오인시킬 수 있어요 - 이 4칸을 공유재고 안내 1칸으로
          // 합쳐요(최근7일/최근30일/일평균은 이 SKU 자신의 실제 판매 사실이라
          // 그대로 유지, colspan=4로 헤더 8칸과 정확히 맞춤: 1+3+4=8).
          const tailCells = isChild
            ? `<td colspan="4">${sharedInventoryBadgeHtml(r.shared_inventory)}</td>`
            : `
            <td class="num">${r.stock_days != null ? fmt(r.stock_days) + "일" : "-"}</td>
            <td>${prOrderByDateChip(r.order_by_date)}</td>
            <td class="num">${r.safety_stock_days != null ? r.safety_stock_days + "일" : "-"}</td>
            <td><span class="chip ${cls}">${label}</span></td>`;
          return `
          <tr>
            <td><b>${esc(r.product_name || r.vendor_item_id)}</b>${r.option_name ? `<br><small style="color:var(--text-sub)">${esc(r.option_name)}</small>` : ""}${!isChild ? sharedInventoryBadgeHtml(r.shared_inventory) : ""}</td>
            <td class="num">${r.sales_qty_7d != null ? fmt(r.sales_qty_7d) : "-"}</td>
            <td class="num">${r.sales_qty_30d != null ? fmt(r.sales_qty_30d) : "-"}</td>
            <td class="num">${r.avg_daily_sales != null ? Number(r.avg_daily_sales).toFixed(2) : "-"}</td>
            ${tailCells}
          </tr>`;
        }).join("") : `<tr><td colspan="8" class="empty">데이터가 없습니다</td></tr>`}
        </tbody>
      </table></div>
    </div>`;
}

/* ---------- 재고 현황 ----------
   2026-09-04: "재고 · 발주 · 입고" 통합 화면(#/stockflow)의 1번 탭으로도
   재사용돼요. preloadedErpBase/preloadedPurchaseReco를 주면(스택플로우
   컨테이너가 미리 불러온 데이터) 그걸 그대로 쓰고, 안 주면(기존 #/inventory
   단독 라우트) 예전과 완전히 동일하게 직접 조회해요 - 기존 동작 변경 없음.

   판매속도·발주예상 표(purchase_recommendations 기반)는 여기로 새로 옮겨온
   부분이에요(예전엔 발주추천 화면에 있었음) - "무엇이 언제 부족해지는가"는
   재고현황 몫, "얼마나 발주할까"는 발주추천 몫으로 역할을 나눴어요(사용자
   요청). 두 표를 억지로 한 행으로 합치지 않았어요(현재재고 계산 방식이
   서로 다른 두 소스라 - 로컬 실시간 계산 vs GCP 배치 스냅샷 - 임의로 하나로
   합치지 말라는 지시를 그대로 반영). */
async function viewInventory(preloadedErpBase, preloadedPurchaseReco) {
  const { buys, sales } = preloadedErpBase || await loadErpBase();

  // 재고 관리는 사입 낱개 상품만 (위탁은 공급처 재고, 연동 세트는 낱개 재고에 포함됨)
  const stockProducts = erpProducts.filter(p => tradeTypeOf(p) === "사입" && !isSetProd(p));
  const consignCount = erpProducts.length - stockProducts.length;
  // 매입·판매 수량은 loadErpBase가 계산한 값을 그대로 쓴다 — 세트 판매가 낱개 수량으로 환산되어 있음
  const inv = stockProducts.map(p => {
    const st = erpStock[p.id] || { stock: 0, inHouse: 0, atCoupang: 0, lastCost: 0, bought: 0, sold: 0 };
    return { p, ...st, value: st.stock * st.lastCost };
  });
  const totalValue = inv.reduce((s, r) => s + r.value, 0);
  const totalCoupang = inv.reduce((s, r) => s + r.atCoupang, 0);
  const totalInHouse = inv.reduce((s, r) => s + r.inHouse, 0);
  const recentTransfers = erpTransfers.slice(0, 20);

  return `
    <div class="grid-stats">
      <div class="stat"><div class="stat-label">재고 평가액 (최근 매입가 기준)</div>
        <div class="stat-value blue">₩${fmt(totalValue)}</div></div>
      <div class="stat"><div class="stat-label">자사창고 재고</div>
        <div class="stat-value">${fmt(totalInHouse)}개</div></div>
      <div class="stat"><div class="stat-label">쿠팡 사외재고</div>
        <div class="stat-value amber">${fmt(totalCoupang)}개</div></div>
      <div class="stat" onclick="location.hash='#/products'"><div class="stat-label">위탁 제품 (재고 제외)</div>
        <div class="stat-value">${consignCount}종</div></div>
    </div>
    <div class="card">
      <div class="card-head"><h2>제품별 재고 (자사창고 / 쿠팡)</h2>
        <div style="display:flex;gap:8px">
          <button class="btn sm" onclick="openTransferModal()">🚚 쿠팡 재고 이동</button>
          <button class="btn sm secondary" onclick="location.hash='#/purchases'">＋ 매입 입력</button>
        </div></div>
      <div class="table-wrap"><table>
        <thead><tr><th>제품</th><th class="num">총 매입</th><th class="num">총 판매</th><th class="num">자사창고</th><th class="num">쿠팡</th><th class="num">총 재고</th><th class="num">최근 매입단가</th><th class="num">재고 금액</th></tr></thead>
        <tbody>${inv.length ? inv.map(r => `
          <tr>
            <td><b>${esc(r.p.name)}</b><br><small style="color:var(--text-sub)">${esc(r.p.code)} · ${esc(r.p.spec)}</small></td>
            <td class="num">${fmt(r.bought)}</td>
            <td class="num">${fmt(r.sold)}</td>
            <td class="num" style="color:${r.inHouse < 0 ? "var(--red)" : "var(--text)"}">${fmt(r.inHouse)}</td>
            <td class="num" style="color:${r.atCoupang < 0 ? "var(--red)" : "var(--amber)"}">${fmt(r.atCoupang)}</td>
            <td class="num" style="font-weight:800;color:${r.stock < 0 ? "var(--red)" : r.stock <= 5 ? "var(--amber)" : "var(--text)"}">${fmt(r.stock)}</td>
            <td class="num">₩${fmt(r.lastCost)}</td>
            <td class="num">₩${fmt(r.value)}</td>
          </tr>`).join("") : `<tr><td colspan="8" class="empty">제품이 없습니다</td></tr>`}
        </tbody>
      </table></div>
      ${(() => {
        // 이동 기록 없이 쿠팡에서 팔린 수량 — 그만큼 자사창고 재고가 부풀려져 보인다
        const ut = Object.entries(erpStock).filter(([, s]) => (s.coupangUntracked || 0) > 0);
        return ut.length ? `<div style="background:#fff4e6;border:1px solid #ffa94d;border-radius:9px;padding:12px;margin-top:12px;font-size:13px">
          <b style="color:#d9480f">⚠️ 이동 기록 없이 팔린 쿠팡 재고가 있습니다</b><br>
          ${ut.map(([id, s]) => `${esc(prodName(id))} ${fmt(s.coupangUntracked)}개`).join(", ")}<br>
          창고에서 쿠팡으로 보낸 기록이 빠지면 <b>자사창고 재고가 그만큼 부풀려집니다</b>.
          <a onclick="openTransferModal()" style="color:var(--brand);cursor:pointer;font-weight:600">이동 기록 남기기 →</a>
        </div>` : "";
      })()}
      <p style="color:var(--text-sub);font-size:12px;margin-top:10px">
        ※ 창고에서 쿠팡 물류센터로 보낸 수량은 <b>🚚 쿠팡 재고 이동</b>으로 기록하세요.<br>
        ※ <b>풀필먼트 채널</b>(쿠팡 로켓그로스 등) 매출은 쿠팡 재고에서, 그 외(쿠팡 판매자배송 포함) 매출은 자사창고에서 차감됩니다.<br>
        ※ 숫자가 음수면 이동/매입 기록이 누락된 것입니다. 위탁 상품은 이 화면에 표시되지 않습니다.<br>
        ※ <b>구성이 지정된 세트상품</b>의 판매는 낱개 상품 재고에서 자동 차감되므로, 이 표에는 낱개 상품만 나옵니다.
      </p>
    </div>
    ${await renderStockVelocityTable(preloadedPurchaseReco)}
    <div class="card">
      <h2>쿠팡 재고 이동 내역 (최근 20건)</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>일자</th><th>품목</th><th>구분</th><th class="num">수량</th><th>메모</th><th>입력자</th><th></th></tr></thead>
        <tbody>${recentTransfers.length ? recentTransfers.map(t => `
          <tr>
            <td>${esc(t.date)}</td>
            <td><b>${esc(prodName(t.product_id))}</b></td>
            <td>${t.kind === "쿠팡입고" ? '<span class="chip mine">창고→쿠팡</span>' : '<span class="chip waiting">쿠팡→창고</span>'}</td>
            <td class="num">${fmt(t.qty)}</td>
            <td>${esc(t.memo)}</td>
            <td>${esc(t.created_by)}</td>
            <td><button class="btn sm danger" onclick="deleteErpRow('stock_transfers','${t.id}')">삭제</button></td>
          </tr>`).join("") : `<tr><td colspan="7" class="empty">이동 내역이 없습니다</td></tr>`}
        </tbody>
      </table></div>
    </div>`;
}

function openTransferModal() {
  document.getElementById("modal-root").innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal">
        <h3>🚚 쿠팡 재고 이동</h3>
        <div class="form-grid">
          <div class="field"><label>일자</label><input id="tr-date" type="date" value="${today()}"></div>
          <div class="field"><label>구분</label>
            <select id="tr-kind">
              <option value="쿠팡입고">창고 → 쿠팡 (입고)</option>
              <option value="쿠팡회수">쿠팡 → 창고 (회수)</option>
            </select></div>
          <div class="field full"><label>품목 *</label><select id="tr-prod">${productOptions("", "buy")}</select></div>
          <div class="field"><label>수량 *</label><input id="tr-qty" type="number" min="1" value="1"></div>
          <div class="field"><label>메모</label><input id="tr-memo" placeholder="송장번호 등" maxlength="100"></div>
        </div>
        <div class="modal-actions">
          <button class="btn secondary" onclick="closeModal()">취소</button>
          <button class="btn" onclick="saveTransfer()">저장</button>
        </div>
      </div>
    </div>`;
}

async function saveTransfer() {
  const pid = document.getElementById("tr-prod").value;
  const qty = numOf(document.getElementById("tr-qty").value) || 0;
  const date = document.getElementById("tr-date").value;
  if (!pid) return toast("품목을 선택해 주세요");
  if (qty <= 0) return toast("수량을 입력해 주세요");
  if (!date) return toast("일자를 선택해 주세요");
  const kind = document.getElementById("tr-kind").value;
  if (kind === "쿠팡입고" && qty > (erpStock[pid]?.inHouse ?? 0)) {
    if (!confirm(`자사창고 재고(${fmt(erpStock[pid]?.inHouse ?? 0)})보다 많은 수량입니다.\n그래도 저장할까요?`)) return;
  }
  const { error } = await sb.from("stock_transfers").insert({
    date, product_id: pid, qty, kind,
    memo: document.getElementById("tr-memo").value.trim(),
    created_by: me.name,
  });
  if (error) return toast("저장에 실패했습니다");
  toast("이동이 기록되었습니다");
  closeModal();
  route();
}

/* ==================== 발주 추천 (READ-only, 2026-09-02) ====================
   GCP taltal-app의 purchase_recommendation_batch.get_batch_recommendations()가
   계산해서 Supabase purchase_recommendations 테이블에 저장해둔 "마지막 계산
   결과 스냅샷"을 그대로 읽어서 보여줘요(재고/판매속도/리드타임/재발주점/
   추천수량/BOX·PLT 환산 전부 GCP가 이미 계산 완료한 값 - 이 화면은 그 계산을
   프론트에서 다시 하지 않고 조회+필터/정렬만 해요).

   PURCHASE_RECOMMENDATION_SYNC_ENABLED가 꺼져 있어서(2026-09-02 현재) 이 테이블은
   주기적으로 자동 최신화되지 않아요 - calculated_at을 화면에 그대로 보여줘서
   "언제 계산된 값인지" 항상 알 수 있게 해요(자동 갱신 여부는 별도 결정 필요).

   2026-09-02 추가: option_name/sales_qty_7d/sales_qty_30d/order_by_date 4개
   필드를 실제 DB 값으로 연결했어요(수동 sync 1회로 87개 상품에 채워짐 - 이
   화면은 여전히 계산을 새로 하지 않고 그 값을 그대로 보여줄 뿐이에요). */
function prOrderByDateChip(dateStr) {
  // 발주 예상일을 기존 chip 스타일 안에서 눈에 바로 들어오게: 미래(여유)=회색,
  // 오늘=주황(주의), 과거(이미 늦음)=빨강 - 새 CSS 없이 기존 .chip 클래스만 재사용해요.
  if (!dateStr) return `<span style="color:var(--text-sub)">-</span>`;
  const todayD = new Date(); todayD.setHours(0, 0, 0, 0);
  const d = new Date(dateStr + "T00:00:00");
  const diffDays = Math.round((d - todayD) / 86400000);
  const label = `${d.getMonth() + 1}/${d.getDate()}`;
  if (diffDays > 0) return `<span class="chip waiting">${label}까지 발주</span>`;
  if (diffDays === 0) return `<span class="chip progress">오늘 발주</span>`;
  return `<span class="chip rejected">발주 지연</span>`;
}
const PR_STATUS_GROUP = {
  ORDER_REQUIRED: "발주필요", STOCK_SUFFICIENT: "재고충분",
  NO_INVENTORY: "데이터부족", NO_SALES_HISTORY: "데이터부족",
  UNMAPPED: "데이터부족", MISSING_PROCUREMENT_DATA: "데이터부족", ERROR: "데이터부족",
};
const PR_STATUS_CHIP = {
  ORDER_REQUIRED: ["rejected", "발주 필요"],
  STOCK_SUFFICIENT: ["approved", "재고 충분"],
  NO_INVENTORY: ["waiting", "재고데이터 없음"],
  NO_SALES_HISTORY: ["waiting", "판매이력 부족"],
  UNMAPPED: ["waiting", "ERP 매핑 없음"],
  MISSING_PROCUREMENT_DATA: ["waiting", "발주정보 없음"],
  ERROR: ["rejected", "계산 오류"],
};

/* 공유재고(세트상품) 표시 - 2026-09-04. purchase_recommendations.shared_inventory
   (GCP가 이미 계산해서 저장한 jsonb)를 그대로 포맷팅만 해요 - 프론트에서 풀링을
   다시 계산하지 않습니다(SSOT는 products.set_parent_id/set_qty, 계산은
   purchase_recommendation_batch.py._apply_inventory_pools()가 전담).
   재고현황/발주추천 두 화면이 이 함수 하나를 공유해서 표시 방식이 갈리지 않게 해요. */
function sharedInventoryBadgeHtml(shared) {
  if (!shared) return "";
  if (shared.role === "base") {
    const labels = (shared.velocity_breakdown || [])
      .slice().sort((a, b) => (a.set_qty || 0) - (b.set_qty || 0))
      .map(b => b.set_qty === 1 ? "단품(1개)" : `${b.set_qty}개세트`);
    return `
      <div class="chip mine" style="display:inline-block;margin-top:4px;padding:4px 8px;font-size:12px;line-height:1.6;text-align:left;white-space:normal">
        🔗 공유재고<br>
        실재고 ${fmt(shared.pool_stock)}EA<br>
        ${esc(labels.join(" / "))}가 이 재고를 공유<br>
        환산 일평균 판매량 ${Number(shared.pool_velocity).toFixed(3)}EA/일
      </div>`;
  }
  if (shared.role === "child") {
    return `
      <div class="chip waiting" style="display:inline-block;margin-top:4px;padding:4px 8px;font-size:12px;line-height:1.6;text-align:left;white-space:normal">
        🔗 원상품 재고 공유<br>
        ${shared.set_qty}개세트 → 현재 base 재고 기준 최대 ${fmt(shared.available_sets)}세트 판매 가능<br>
        독립 발주추천은 하지 않음
      </div>`;
  }
  return "";
}

let prRecoCache = [];
let prRecoFilter = { group: "", q: "" };
let prRecoSelected = new Set();   // 선택된 vendor_item_id(발주필요만) - 발주서 초안 미리보기용
let podDraftGroups = [];          // openPODraftModal()이 만든 공급처별 그룹(미리보기용 상태)
// vendor_item_id -> {po_no, status} - 이 추천과 관련된 가장 최근 발주서(있으면).
// purchase_order_items.vendor_item_id를 그대로 재사용한 조회라 새 컬럼/스키마 변경 없음.
let prRecoPoStatusByVid = {};

// 2026-09-03 강화: 발주서 초안 선택 가능 조건 = is_active===true AND
// status==='ORDER_REQUIRED' AND recommended_units>0. recommended_units가
// 0/null인 상품은(추천수량이 없는데도 화면 표시상 발주필요로 보이는 예외 케이스)
// 체크박스 자체를 아예 못 누르게 막아요 - 서버(RPC)의 qty>0 검증과 별개로
// 프론트에서 먼저 막는 이중 방어예요.
function prRecoIsDraftSelectable(r) {
  return r.is_active === true && r.status === "ORDER_REQUIRED" && Number(r.recommended_units) > 0;
}

// ==================== 입고 물류 최적화(shipment_plans, READ-only 연결) ====================
// 2026-09-04: migrations/20260904_shipment_optimization_draft.sql이 실제 운영
// DB에 적용됨(MIGRATION VERIFIED 확인 완료). 이 화면은 이제 그 3개 테이블
// (shipment_optimization_runs/shipment_plans/shipment_plan_items)을 실제로
// 조회해서 보여줘요 - 하드코딩 mock 데이터는 전부 제거했습니다.
//
// 아직 안 하는 것(승인/거절/재계산/실행 버튼은 여전히 DB WRITE 없이 toast만):
// shipment row를 실제로 만드는 건 shipment_execution_planner.py가 poll
// 루프에 연결된 뒤의 별도 단계라서, 지금은 순수 조회 화면입니다 - 지금
// row가 0건인 게 정상이고(그래서 빈 상태 UI를 명시적으로 다뤄요).
function shipmentPlansWriteNotConnected(label) {
  toast(`${label} - 아직 실제 DB WRITE에 연결되지 않았습니다(조회 전용 단계)`);
}

const RUN_STATUS_CHIP = {
  PENDING_REVIEW: "progress", APPROVED: "approved", REJECTED: "rejected", BLOCKED: "rejected",
};
const EXECUTION_STATUS_CHIP = {
  PENDING: "waiting", EXECUTING: "progress", PLAN_CREATED: "approved",
  REPLAN_REQUIRED: "rejected", FAILED: "rejected",
};

async function viewShipmentPlans() {
  const [runsRes, plansRes, itemsRes, poRes, poItemsRes, centersRes, productsRes] = await Promise.all([
    sb.from("shipment_optimization_runs").select("*").order("created_at", { ascending: false }),
    sb.from("shipment_plans").select("*"),
    sb.from("shipment_plan_items").select("*"),
    sb.from("purchase_orders").select("id,po_no"),
    sb.from("purchase_order_items").select("id,product_id"),
    sb.from("coupang_centers").select("id,center_name"),
    sb.from("products").select("id,name"),
  ]);

  // === 2. 조회 에러 처리 - 하나라도 실패하면 원인을 그대로 보여주고 재시도 버튼만 제공 ===
  const firstError = [runsRes, plansRes, itemsRes, poRes, poItemsRes, centersRes, productsRes].find(r => r.error);
  if (firstError) {
    return `
      <div class="card" style="border:2px solid var(--red)">
        <h2 style="color:var(--red)">입고 물류 최적화 데이터를 불러오지 못했습니다</h2>
        <p style="font-size:13px;color:var(--text-sub);margin:8px 0 14px">${esc(firstError.error.message)}</p>
        <button class="btn" onclick="route()">다시 시도</button>
      </div>`;
  }

  const runs = runsRes.data || [];
  const plans = plansRes.data || [];
  const items = itemsRes.data || [];
  const poById = Object.fromEntries((poRes.data || []).map(p => [p.id, p]));
  const poItemById = Object.fromEntries((poItemsRes.data || []).map(p => [p.id, p]));
  const centerById = Object.fromEntries((centersRes.data || []).map(c => [c.id, c]));
  const productById = Object.fromEntries((productsRes.data || []).map(p => [p.id, p]));

  // === 1. 빈 상태 화면 - 지금 실제로 이 상태(row 0건)라 반드시 필요 ===
  if (runs.length === 0) {
    return `
      <div class="card">
        <h2>아직 계산된 입고 물류 최적화 결과가 없습니다</h2>
        <p style="font-size:13px;color:var(--text-sub);margin-top:8px;line-height:1.6">
          shipment_optimization_runs 테이블은 준비돼 있지만(migration 적용 완료),
          아직 PO 승인 → 물류 최적화 자동 실행이 연결되지 않아서 실제 계산 결과가
          없습니다. 이 화면은 그 계산 결과가 생기면 자동으로 표시됩니다.
        </p>
      </div>`;
  }

  // === 4. run -> plan -> item 계층 표시 ===
  return runs.map(run => {
    const runPlans = plans.filter(p => p.optimization_run_id === run.id);
    const po = poById[run.purchase_order_id];
    const runChip = RUN_STATUS_CHIP[run.run_status] || "waiting";
    return `
      <div class="card">
        <div class="card-head">
          <h2>PO 입고 추천안 - ${esc(po ? po.po_no : run.purchase_order_id)}</h2>
          <span class="chip ${runChip}">${esc(run.run_status)}</span>
        </div>
        <p style="font-size:13px;color:var(--text-sub);margin-bottom:10px">
          공급처: ${esc(run.supplier_name)} · min_edd: ${esc(run.min_edd)}
          ${run.blocking_reason ? `<br><span style="color:var(--red)">차단 사유: ${esc(run.blocking_reason)}</span>` : ""}
        </p>
        <div class="grid-stats" style="margin-bottom:14px">
          <div class="stat"><div class="stat-label">확정 계획 PLT</div><div class="stat-value">${run.total_pallet_count}</div></div>
          <div class="stat"><div class="stat-label">차량 대수</div><div class="stat-value">${run.vehicle_count}대</div></div>
          <div class="stat"><div class="stat-label">총 예상운임</div><div class="stat-value">${fmt(run.total_transport_cost)}원</div></div>
        </div>
        ${runPlans.map((p, i) => {
          const planItems = items.filter(it => it.shipment_plan_id === p.id);
          const center = centerById[p.destination_center_id];
          const execChip = EXECUTION_STATUS_CHIP[p.execution_status] || "waiting";
          return `
            <div style="border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:10px">
              <div style="display:flex;justify-content:space-between;font-weight:600">
                <span>차량 ${i + 1} — ${p.total_pallet_count}PLT(확정 계획 PLT) / ${esc(center ? center.center_name : p.destination_center_id)} / ${fmt(p.total_transport_cost)}원</span>
                <span class="chip ${execChip}">${esc(p.execution_status)}</span>
              </div>
              <div style="font-size:12.5px;color:var(--text-sub);margin-top:4px">
                입고 예정: ${esc(p.slot_date)} ${esc(p.slot_time)} · 차종: ${esc(p.vehicle_type)}
                ${p.selection_reason ? `<br>${esc(p.selection_reason)}` : ""}
              </div>
              <ul style="margin:8px 0 0 18px;font-size:13px">
                ${planItems.map(it => {
                  const poItem = poItemById[it.purchase_order_item_id];
                  const product = poItem ? productById[poItem.product_id] : null;
                  const name = product ? product.name : `PO item ${it.purchase_order_item_id}`;
                  return `<li>${esc(name)} ${fmt(it.qty)}개(${it.pallet_count}PLT)</li>`;
                }).join("") || `<li style="color:var(--text-sub)">SKU 정보 없음</li>`}
              </ul>
            </div>`;
        }).join("")}
        <details style="margin-top:8px">
          <summary style="cursor:pointer;font-size:13px;color:var(--brand)">계산 근거 보기(evaluation_snapshot)</summary>
          <pre style="font-size:11.5px;background:#f7f7f7;padding:10px;border-radius:6px;overflow-x:auto;margin-top:8px">${esc(JSON.stringify(run.evaluation_snapshot, null, 2))}</pre>
        </details>
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="btn" onclick="shipmentPlansWriteNotConnected('전체 승인')">전체 승인</button>
          <button class="btn secondary" onclick="shipmentPlansWriteNotConnected('거절')">거절</button>
          <button class="btn secondary" onclick="shipmentPlansWriteNotConnected('재계산')">재계산</button>
        </div>
      </div>`;
  }).join("");
}

// 2026-09-04: "재고 · 발주 · 입고" 통합 화면의 2번 탭으로도 재사용돼요.
// preloaded를 주면(스톡플로우 컨테이너가 재고현황 탭과 공유하는 동일한
// purchase_recommendations 조회 결과) 재조회 없이 그대로 쓰고, 안 주면
// (기존 #/purchasereco 단독 라우트) 예전과 동일하게 직접 조회해요.
//
// 표 컬럼은 "발주 의사결정"에 필요한 것만 남겼어요(공급처/추천수량/BOX/
// 예상PLT/발주근거/PO상태) - 최근7일·30일판매/일평균/예상소진일/안전재고
// 같은 "언제 부족해지는가" 컬럼은 재고현황 탭(renderStockVelocityTable)으로
// 옮겼어요(중복 제거, 사용자 지시 반영). "발주예상일"도 재고현황 쪽 몫으로
// 옮겼습니다.
async function viewPurchaseReco(preloaded) {
  const { data, error } = preloaded || await sb.from("purchase_recommendations").select("*");
  prRecoCache = data || [];
  prRecoSelected = new Set();   // 화면을 새로 열 때마다 선택 초기화(최신 데이터 기준으로 다시 선택)
  if (error) {
    return `<div class="card"><p class="empty">발주추천 데이터를 불러오지 못했습니다.</p></div>`;
  }

  // "PO 상태" 컬럼용 best-effort 조회 - 새 컬럼/스키마 없이 기존
  // purchase_order_items.vendor_item_id로 그대로 조인해요. 여러 PO가 같은
  // vendor_item_id를 가질 수 있어서, 가장 최근(created_at) PO 1건만 대표로 씀.
  {
    const [poItemsRes, poRes] = await Promise.all([
      sb.from("purchase_order_items").select("po_id,vendor_item_id"),
      sb.from("purchase_orders").select("id,po_no,status,created_at").order("created_at", { ascending: false }),
    ]);
    const poById = Object.fromEntries((poRes.data || []).map(p => [p.id, p]));
    const byVid = {};
    (poItemsRes.data || []).forEach(it => {
      const po = poById[it.po_id];
      if (!po || !it.vendor_item_id) return;
      const existing = byVid[it.vendor_item_id];
      if (!existing || (po.created_at || "") > (existing.created_at || "")) byVid[it.vendor_item_id] = po;
    });
    prRecoPoStatusByVid = byVid;
  }
  // 2026-09-02 추가(stale-row 대응): is_active=false는 product_master에서 더 이상 ACTIVE가
  // 아니게 된 상품(판매종료 등)의 과거 계산 이력이에요 - 기본 화면/통계에서는 제외하고,
  // 아래 상태 필터에서 "비활성/제외 상품"을 선택했을 때만 보여줘요(물리 DELETE가 없어서
  // 이력 조회 자체는 항상 가능 - 숨김일 뿐 삭제 아님).
  const activeCache = prRecoCache.filter(r => r.is_active !== false);
  const inactiveCount = prRecoCache.length - activeCache.length;
  const calcAt = activeCache[0]?.calculated_at || prRecoCache[0]?.calculated_at;
  const total = activeCache.length;
  const need = activeCache.filter(r => r.status === "ORDER_REQUIRED").length;
  const ok = activeCache.filter(r => r.status === "STOCK_SUFFICIENT").length;
  const lack = total - need - ok;

  return `
    <div class="grid-stats">
      <div class="stat"><div class="stat-label">전체 상품</div><div class="stat-value">${total}종</div></div>
      <div class="stat"><div class="stat-label">🔴 발주 필요</div><div class="stat-value" style="color:var(--red)">${need}종</div></div>
      <div class="stat"><div class="stat-label">🟢 재고 충분</div><div class="stat-value" style="color:var(--green)">${ok}종</div></div>
      <div class="stat"><div class="stat-label">⚪ 데이터 부족</div><div class="stat-value" style="color:var(--text-sub)">${lack}종</div></div>
    </div>
    <div class="card">
      <div class="card-head"><h2>제품별 발주 추천</h2></div>
      <p style="font-size:12.5px;color:var(--text-sub);margin-bottom:12px">
        GCP 서버가 쿠팡 판매속도·재고·리드타임 기준으로 계산한 결과예요(이 화면은 계산을
        새로 하지 않고 그 결과만 보여줘요). 최종 계산: <b>${calcAt ? esc(new Date(calcAt).toLocaleString("ko-KR")) : "기록 없음"}</b>
        ${calcAt ? ` <span style="color:var(--text-sub)">— 자동 갱신은 아직 꺼져있어 실시간 값이 아닐 수 있어요</span>` : ""}
        ${inactiveCount ? ` <span style="color:var(--text-sub)">— ⚫ 비활성/제외 상품 ${inactiveCount}건은 기본 화면에서 숨겨져 있어요(아래 상태 필터에서 확인 가능)</span>` : ""}
      </p>
      <div class="searchbar" style="margin-bottom:14px">
        <input placeholder="상품명 검색" value="${esc(prRecoFilter.q)}"
          oninput="prRecoFilter.q=this.value;refreshPrRecoTable()">
        <select onchange="prRecoFilter.group=this.value;refreshPrRecoTable()">
          <option value="">전체 상태</option>
          <option value="발주필요" ${prRecoFilter.group === "발주필요" ? "selected" : ""}>🔴 발주 필요</option>
          <option value="재고충분" ${prRecoFilter.group === "재고충분" ? "selected" : ""}>🟢 재고 충분</option>
          <option value="데이터부족" ${prRecoFilter.group === "데이터부족" ? "selected" : ""}>⚪ 데이터 부족</option>
          <option value="비활성제외" ${prRecoFilter.group === "비활성제외" ? "selected" : ""}>⚫ 비활성/제외 상품(${inactiveCount})</option>
        </select>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap">
        <span style="font-size:12.5px;color:var(--text-sub)">🔴 발주 필요 상품만 체크박스로 선택할 수 있어요 - 선택 후 공급처별로 나눠서 발주서 초안을 미리보기(dry-run)할 수 있어요.</span>
        <button class="btn sm" id="pr-draft-btn" disabled onclick="openPODraftModal()">📝 발주서 초안 만들기 (0건 선택)</button>
      </div>
      <div id="pr-reco-table">${prRecoTableHtml(filteredPrReco())}</div>
      <p style="color:var(--text-sub);font-size:12px;margin-top:10px">
        ※ 최근7일·30일 판매량/일평균/예상소진일/발주예상일 같은 "재고 상태" 정보는
        <a onclick="location.hash='#/stockflow/stock'" style="color:var(--brand);cursor:pointer">재고 현황 탭</a>에서 볼 수 있어요.<br>
        ※ 옵션(색상 등)이 있는 상품은 상품명 아래 작은 글씨로 옵션명이 같이 표시돼요.<br>
        ※ ⚫ <b>비활성/제외 상품</b>은 product_master에서 더 이상 ACTIVE가 아니게 된(판매종료 등) 상품의 과거 계산 이력이에요 - 삭제되지 않고 상태 필터로 언제든 다시 볼 수 있어요.<br>
        ※ <b>PO 상태</b>는 이 상품의 vendor_item_id로 만들어진 가장 최근 발주서 상태예요(있으면) - 여러 건이 있어도 최신 1건만 표시돼요.<br>
        ※ <b>발주서 초안 만들기</b>는 아직 미리보기(dry-run)까지만 가능해요 - 실제 발주서 생성은 검토 후 다음 단계에서 열립니다. 그 전까지 발주는 <b>발주서</b> 메뉴에서 직접 작성하세요.
      </p>
    </div>`;
}

function filteredPrReco() {
  let list;
  if (prRecoFilter.group === "비활성제외") {
    list = prRecoCache.filter(r => r.is_active === false);
  } else {
    list = prRecoCache.filter(r => r.is_active !== false);
    if (prRecoFilter.group) list = list.filter(r => PR_STATUS_GROUP[r.status] === prRecoFilter.group);
  }
  if (prRecoFilter.q) {
    const q = prRecoFilter.q.toLowerCase();
    list = list.filter(r => (r.product_name || "").toLowerCase().includes(q));
  }
  return list;
}

function refreshPrRecoTable() {
  document.getElementById("pr-reco-table").innerHTML = prRecoTableHtml(filteredPrReco());
}

function prRecoTableHtml(list) {
  // 발주필요를 예상소진일 오름차순(급한 순)으로 먼저, 그 다음 재고충분, 그 다음 데이터부족
  const groupOrder = { "발주필요": 0, "재고충분": 1, "데이터부족": 2 };
  const sorted = [...list].sort((a, b) => {
    const ga = groupOrder[PR_STATUS_GROUP[a.status]] ?? 3;
    const gb = groupOrder[PR_STATUS_GROUP[b.status]] ?? 3;
    if (ga !== gb) return ga - gb;
    if (ga === 0) {
      const da = a.stock_days ?? Infinity, db = b.stock_days ?? Infinity;
      if (da !== db) return da - db;
    }
    return (a.product_name || "").localeCompare(b.product_name || "", "ko");
  });
  const selectableVids = sorted.filter(prRecoIsDraftSelectable).map(r => r.vendor_item_id);
  const allSelected = selectableVids.length > 0 && selectableVids.every(v => prRecoSelected.has(v));
  // 2026-09-04: 컬럼을 "발주 의사결정"에 필요한 것만 남겼어요(중복 정리 -
  // 재고/판매속도 컬럼은 renderStockVelocityTable로 이동). PLT는 아직 확정이
  // 아니라 "예상 PLT"로 라벨을 명확히 구분했어요(입고계획의 "확정 계획 PLT",
  // 쿠팡입고의 "WING 실행 PLT"와 혼동 방지).
  return `
    <div class="table-wrap"><table>
      <thead><tr>
        <th>${selectableVids.length ? `<input type="checkbox" id="pr-select-all" ${allSelected ? "checked" : ""} onchange="togglePrRecoSelectAll(this.checked)" title="발주필요 상품 전체 선택">` : ""}</th>
        <th>상품</th><th>공급처</th>
        <th class="num">추천수량</th><th class="num">BOX</th><th class="num">예상 PLT</th>
        <th>발주 근거 · 상태</th><th>PO 상태</th>
      </tr></thead>
      <tbody>${sorted.length ? sorted.map(r => {
        const [cls, label] = PR_STATUS_CHIP[r.status] || ["waiting", r.status];
        const selectable = prRecoIsDraftSelectable(r);
        const po = prRecoPoStatusByVid[r.vendor_item_id];
        return `
        <tr>
          <td>${selectable ? `<input type="checkbox" class="pr-reco-chk" ${prRecoSelected.has(r.vendor_item_id) ? "checked" : ""} onchange="togglePrRecoSelect('${esc(r.vendor_item_id)}', this.checked)">` : ""}</td>
          <td><b>${esc(r.product_name || r.vendor_item_id)}</b>${r.option_name ? `<br><small style="color:var(--text-sub)">${esc(r.option_name)}</small>` : ""}${r.is_active === false ? `<br><span class="chip waiting" style="padding:1px 6px;margin-top:2px;display:inline-block">⚫ 비활성${r.stale_at ? "(" + new Date(r.stale_at).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" }) + "부터)" : ""}</span>` : ""}${sharedInventoryBadgeHtml(r.shared_inventory)}</td>
          <td>${esc(r.supplier_name || "-")}</td>
          <td class="num"><b>${r.recommended_units != null ? fmt(r.recommended_units) : "-"}</b></td>
          <td class="num">${r.recommended_boxes != null ? fmt(r.recommended_boxes) : "-"}</td>
          <td class="num">${r.recommended_plts != null ? fmt(r.recommended_plts) : "-"}</td>
          <td><span class="chip ${cls}">${label}</span>${r.reason ? `<br><small style="color:var(--text-sub)">${esc(r.reason)}</small>` : ""}</td>
          <td>${po ? `<a onclick="location.hash='#/podoc/${esc(po.id)}'" style="color:var(--brand);cursor:pointer">${esc(po.po_no)}</a><br><small style="color:var(--text-sub)">${esc(po.status)}</small>` : `<span style="color:var(--text-sub)">-</span>`}</td>
        </tr>`;
      }).join("") : `<tr><td colspan="8" class="empty">조건에 맞는 상품이 없습니다</td></tr>`}
      </tbody>
    </table></div>`;
}

/* ---------- 발주추천 -> 발주서 초안 미리보기(dry-run) ---------- */
// 2026-09-03: 실제 발주서 row는 아직 안 만듦(p_dry_run=true 미리보기까지만).
// 실제 생성/WING/공급처 발송은 전부 다음 단계에서 별도로 활성화 예정.

function togglePrRecoSelect(vid, checked) {
  if (checked) prRecoSelected.add(vid); else prRecoSelected.delete(vid);
  updatePrRecoSelectionUI();
}

function togglePrRecoSelectAll(checked) {
  filteredPrReco()
    .filter(prRecoIsDraftSelectable)
    .forEach(r => { if (checked) prRecoSelected.add(r.vendor_item_id); else prRecoSelected.delete(r.vendor_item_id); });
  refreshPrRecoTable();
  updatePrRecoSelectionUI();
}

function updatePrRecoSelectionUI() {
  const btn = document.getElementById("pr-draft-btn");
  if (!btn) return;
  btn.disabled = prRecoSelected.size === 0;
  btn.textContent = `📝 발주서 초안 만들기 (${prRecoSelected.size}건 선택)`;
}

function openPODraftModal() {
  const selected = prRecoCache.filter(r => prRecoSelected.has(r.vendor_item_id));
  if (!selected.length) return toast("선택된 상품이 없습니다");
  const byGroup = {};
  selected.forEach(r => {
    const key = r.supplier_name || "(공급처 미지정)";
    (byGroup[key] = byGroup[key] || []).push(r);
  });
  podDraftGroups = Object.entries(byGroup).map(([supplier, rows]) => ({ supplier, rows }));
  const approvers = USERS.filter(u => u.id !== me.id).sort((a, b) => (a.name || "").localeCompare(b.name || "", "ko"));
  document.getElementById("modal-root").innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal" style="max-width:920px;width:96vw;max-height:88vh;overflow:auto">
        <h3>📝 발주서 초안 미리보기</h3>
        <p style="font-size:12.5px;color:var(--text-sub);margin-bottom:14px">
          선택한 ${selected.length}개 상품을 공급처별로 나눴어요(${podDraftGroups.length}개 그룹) - 발주서는 공급처마다 따로 만들어져요.
          지금은 <b>미리보기(dry-run)</b>까지만 가능합니다 - 실제 발주서 생성은 검토 후 다음 단계에서 활성화돼요.
          수량은 추천수량이 기본값이고 직접 수정할 수 있어요.
        </p>
        ${podDraftGroups.map((g, gi) => poDraftGroupHtml(g, gi, approvers)).join("")}
        <div class="modal-actions">
          <button class="btn secondary" onclick="closeModal()">닫기</button>
        </div>
      </div>
    </div>`;
  podDraftGroups.forEach((g, gi) => calcPODraftGroupTotal(gi));   // 초기 수량 유효성도 렌더 직후 한 번 검사
}

function poDraftGroupHtml(g, gi, approvers) {
  const groupTotal = g.rows.reduce((s, r) => s + (r.purchase_cost || 0) * (r.recommended_units || 0), 0);
  const rowsHtml = g.rows.map((r, ri) => `
    <tr>
      <td><b>${esc(r.product_name || r.vendor_item_id)}</b>${r.option_name ? `<br><small style="color:var(--text-sub)">${esc(r.option_name)}</small>` : ""}</td>
      <td class="num">${r.recommended_units != null ? fmt(r.recommended_units) : "-"}</td>
      <td class="num"><input type="number" min="1" class="pod-qty" data-gi="${gi}" data-ri="${ri}"
          value="${r.recommended_units != null ? r.recommended_units : 1}" style="width:80px" oninput="calcPODraftGroupTotal(${gi})"></td>
      <td class="num">${r.purchase_cost != null ? "₩" + fmt(r.purchase_cost) : "-"}</td>
      <td class="num pod-amt" data-gi="${gi}" data-ri="${ri}">${r.purchase_cost != null && r.recommended_units != null ? "₩" + fmt(r.purchase_cost * r.recommended_units) : "-"}</td>
    </tr>`).join("");
  return `
    <div class="card" style="margin-bottom:14px;padding:14px">
      <h4 style="margin:0 0 8px">🏭 ${esc(g.supplier)} <span style="color:var(--text-sub);font-weight:400;font-size:12.5px">(${g.rows.length}건)</span></h4>
      <div class="table-wrap"><table>
        <thead><tr><th>상품</th><th class="num">추천수량</th><th class="num">발주수량</th><th class="num">단가</th><th class="num">예상금액</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table></div>
      <div class="total-line">그룹 합계 <b id="pod-total-${gi}">₩${fmt(groupTotal)}</b></div>
      <div class="form-grid" style="margin-top:10px">
        <div class="field"><label>입고처</label>
          <select id="pod-deliver-${gi}">
            <option value="쿠팡" selected>쿠팡 (로켓그로스) — 공급처에서 바로 입고</option>
            <option value="자사창고">자사창고</option>
          </select></div>
        <div class="field"><label>결재자 *</label>
          ${approvers.length ? `<select id="pod-appr-${gi}">${approvers.map(u => `<option value="${u.id}">${esc(u.name)} ${esc(u.role || "")}</option>`).join("")}</select>`
            : `<p style="color:var(--red);font-size:12.5px;margin:0">지정 가능한 결재자가 없습니다</p>`}</div>
        <div class="field full"><label>메모</label><input id="pod-memo-${gi}" maxlength="100" placeholder="예) 발주추천 자동 생성"></div>
      </div>
      <p id="pod-qty-warn-${gi}" class="hidden" style="color:var(--red);font-size:12.5px;margin:6px 0 0">수량은 1 이상 정수로 입력해 주세요 - 잘못된 항목이 있으면 미리보기를 실행할 수 없어요.</p>
      <button class="btn sm" id="pod-preview-btn-${gi}" style="margin-top:10px" ${approvers.length ? "" : "disabled"} onclick="previewPODraft(${gi})">🔍 미리보기 실행 (dry-run)</button>
      <div id="pod-result-${gi}" style="margin-top:10px"></div>
    </div>`;
}

function calcPODraftGroupTotal(gi) {
  const g = podDraftGroups[gi];
  if (!g) return;
  let total = 0;
  let allQtyValid = true;
  document.querySelectorAll(`.pod-qty[data-gi="${gi}"]`).forEach(inp => {
    const ri = Number(inp.dataset.ri);
    const r = g.rows[ri];
    const n = Number(inp.value);
    // 프론트 1차 방어: 0/음수/소수/NaN은 미리보기 버튼 자체를 막아요(서버 RPC의
    // qty>0 검증은 그대로 유지 - 이중 방어).
    const validQty = inp.value !== "" && Number.isInteger(n) && n > 0;
    inp.style.borderColor = validQty ? "" : "var(--red)";
    if (!validQty) allQtyValid = false;
    const qty = validQty ? n : 0;
    const amt = qty * (r.purchase_cost || 0);
    const amtCell = document.querySelector(`.pod-amt[data-gi="${gi}"][data-ri="${ri}"]`);
    if (amtCell) amtCell.textContent = "₩" + fmt(amt);
    total += amt;
  });
  const totalEl = document.getElementById(`pod-total-${gi}`);
  if (totalEl) totalEl.textContent = "₩" + fmt(total);
  const warnEl = document.getElementById(`pod-qty-warn-${gi}`);
  if (warnEl) warnEl.classList.toggle("hidden", allQtyValid);
  const btn = document.getElementById(`pod-preview-btn-${gi}`);
  const hasApprover = !!document.getElementById(`pod-appr-${gi}`);
  if (btn) btn.disabled = !allQtyValid || !hasApprover;
}

async function previewPODraft(gi) {
  const g = podDraftGroups[gi];
  if (!g) return;
  const apprSel = document.getElementById(`pod-appr-${gi}`);
  if (!apprSel || !apprSel.value) return toast("결재자를 선택해 주세요");
  const items = [];
  for (let ri = 0; ri < g.rows.length; ri++) {
    const inp = document.querySelector(`.pod-qty[data-gi="${gi}"][data-ri="${ri}"]`);
    const qty = numOf(inp?.value) || 0;
    if (qty <= 0 || !Number.isInteger(qty)) return toast(`'${g.rows[ri].product_name || g.rows[ri].vendor_item_id}'의 수량을 1 이상 정수로 입력해 주세요`);
    items.push({
      vendor_item_id: g.rows[ri].vendor_item_id,
      qty,
      client_calculated_at: g.rows[ri].calculated_at || null,
    });
  }
  const resultEl = document.getElementById(`pod-result-${gi}`);
  if (resultEl) resultEl.innerHTML = `<p style="color:var(--text-sub);font-size:13px">확인 중...</p>`;
  const { data, error } = await sb.rpc("create_purchase_order_draft", {
    p_supplier: g.supplier,
    p_deliver_to: document.getElementById(`pod-deliver-${gi}`).value,
    p_memo: document.getElementById(`pod-memo-${gi}`).value.trim(),
    p_approver_id: apprSel.value,
    p_items: items,
    p_dry_run: true,
  });
  if (!resultEl) return;
  if (error) {
    resultEl.innerHTML = `<div style="background:var(--red-bg);border:1px solid var(--red);border-radius:8px;padding:10px 12px;font-size:13px;color:var(--red)">
      ⚠️ ${esc(error.message || "미리보기에 실패했습니다")}</div>`;
    return;
  }
  resultEl.innerHTML = poDraftPreviewHtml(gi, data);
}

function poDraftPreviewHtml(gi, data) {
  const g = podDraftGroups[gi];
  const po = data?.would_create_po || {};
  const items = data?.would_create_items || [];
  const nameOf = vid => { const r = g?.rows.find(x => x.vendor_item_id === vid); return r ? (r.product_name || vid) : vid; };
  const apprName = u => { const u2 = USERS.find(x => x.id === u); return u2 ? u2.name : u; };
  return `
    <div style="background:var(--green-bg);border:1px solid var(--green);border-radius:8px;padding:10px 12px;font-size:13px">
      ✅ 검증 통과 — 이대로 만들면 <b>${fmt(items.length)}개 품목</b>, 합계 <b>₩${fmt(po.total)}</b>인 발주서가 생성됩니다
      (결재자: <b>${esc(apprName(po.approver_id))}</b> · 입고처: ${esc(po.deliver_to || "-")}) — <b>아직 실제로 생성하지 않았습니다.</b>
      <div class="table-wrap" style="margin-top:8px"><table>
        <thead><tr><th>상품</th><th class="num">수량</th><th class="num">단가</th><th class="num">금액</th></tr></thead>
        <tbody>${items.map(it => `
          <tr><td><b>${esc(nameOf(it.vendor_item_id))}</b>${it.option_name ? `<br><small style="color:var(--text-sub)">${esc(it.option_name)}</small>` : ""}</td>
            <td class="num">${fmt(it.qty)}</td><td class="num">₩${fmt(it.unit_cost)}</td><td class="num">₩${fmt(it.amount)}</td></tr>`).join("")}
        </tbody>
      </table></div>
    </div>`;
}

/* ---------- 월별 리포트 ---------- */
/* ---------- 공헌이익 (매출 − 변동비) ---------- */
// 변동비 = 상품원가 + 판매수수료 + 출고배송비 + 광고비
// 공헌이익이 고정비를 넘어서는 순간부터 회사가 흑자입니다.

function channelSetting(name) {
  const c = erpChannelList.find(x => x.name === name);
  return {
    fee: Number(c?.fee_rate) || 0,        // 판매수수료 %
    ship: Number(c?.ship_fee) || 0,       // 주문 1건당 배송비 (직접 배송)
    unit: Number(c?.unit_fee) || 0,       // 개당 물류비 (로켓그로스 등 풀필먼트 입출고비)
    type: c?.ship_type || "직접배송",
  };
}

// 매출 1줄의 공헌이익 계산 (광고비 제외 — 광고비는 기간 단위로 배분)
// 배송비는 '주문 1건당 1회'. 같은 날·같은 채널·같은 적요(주문번호)면 한 주문으로 묶는다.
// 적요가 비어 있으면 묶을 근거가 없으므로 그 줄만 1회 부과.
function shipKeyOf(r) {
  const memo = (r.memo || "").trim();
  return memo ? `${r.date}|${r.channel}|${memo}` : `row:${r.id || Math.random()}`;
}
function shipChargedRows(rows) {
  const seen = new Set(), charged = new Set();
  for (const r of rows) {
    const k = shipKeyOf(r);
    if (!seen.has(k)) { seen.add(k); charged.add(r); }
  }
  return charged; // 주문의 첫 줄에만 배송비를 매김
}

function cmOfSale(r, shipCharged) {
  const gross = Number(r.amount) || 0;              // 고객이 낸 돈 (부가세 포함)
  const qty = Number(r.qty) || 0;
  const p = erpProducts.find(x => x.id === r.product_id);
  // 이익은 전부 공급가액(부가세 뺀 금액) 기준 — 부가세는 우리 돈이 아니라 나중에 내야 할 돈
  const revenue = saleNet(gross, p);
  const outVat = saleVat(gross, p);
  // 판매 시점 원가 스냅샷 우선, 없으면 현재 제품 마스터 원가 (연동 세트는 낱개 원가 × 구성 수량)
  const unitCost = Number(r.unit_cost ?? effCost(p)) || 0;
  const cost = buyNet(unitCost * qty, p);
  const st = channelSetting(r.channel);
  // 수수료율·물류비·배송비는 모두 상품별 값 우선(카테고리·상품마다 다름), 세트는 기본제품 값, 없으면 채널 기본값
  const base = isSetProd(p) ? setBaseOf(p) : null;
  const pick = (own, baseVal, chVal) => {
    const v = own ?? baseVal;
    return v != null ? Number(v) : chVal;
  };
  const feePct = pick(p?.fee_rate, base?.fee_rate, st.fee);
  const unitFee = pick(p?.unit_fee, base?.unit_fee, st.unit);
  const shipFee = pick(p?.ship_fee, base?.ship_fee, st.ship);
  // 수수료는 '고객이 실제로 결제한 금액'(부가세 포함)에 붙는다
  const feeGross = Math.round((revenue + outVat) * feePct / 100);
  // 배송 방식에 따라 둘 중 하나만 붙는다 — 직접배송은 주문 1건당 택배비,
  // 풀필먼트(로켓그로스 등)는 개당 물류비. 채널 설정에 두 값이 모두 남아 있어도 이중으로 계산하지 않는다.
  const isFulfill = st.type === "풀필먼트";
  const shipGross = (!isFulfill && (!shipCharged || shipCharged.has(r))) ? shipFee : 0;
  const logiGross = isFulfill ? unitFee * qty : 0;
  const fee = expNet(feeGross), ship = expNet(shipGross), logi = expNet(logiGross);
  return {
    // 고객이 실제로 낸 돈 = 공급가액 + 부가세 (판매가를 부가세 별도로 적는 경우도 맞음)
    gross: revenue + outVat, revenue, outVat, qty, cost, fee, ship, logi,
    // 수수료·배송비·물류비에 붙은 부가세 — 부가세 신고 시 공제받는 매입세액
    feeShipVat: expVat(feeGross) + expVat(shipGross) + expVat(logiGross),
    inVat: buyVat(unitCost * qty, p) + expVat(feeGross) + expVat(shipGross) + expVat(logiGross),
    cm: revenue - cost - fee - ship - logi,
    noCost: !unitCost,
    noChannel: !!r.channel && !erpChannelList.some(c => c.name === r.channel),
  };
}

function sumCM(rows) {
  const shipCharged = shipChargedRows(rows);
  return rows.reduce((s, r) => {
    const c = cmOfSale(r, shipCharged);
    s.gross += c.gross; s.revenue += c.revenue; s.outVat += c.outVat; s.inVat += c.inVat;
    s.qty += c.qty; s.cost += c.cost;
    s.fee += c.fee; s.ship += c.ship; s.logi += c.logi; s.cm += c.cm;
    if (c.noCost) { s.noCostRows++; s.noCostRevenue += c.revenue; }
    if (c.noChannel) s.unknownChannels.add(r.channel);
    return s;
  }, { gross: 0, revenue: 0, outVat: 0, inVat: 0, qty: 0, cost: 0, fee: 0, ship: 0, logi: 0, cm: 0,
       noCostRows: 0, noCostRevenue: 0, unknownChannels: new Set() });
}

/* 한 달치 공헌이익 계산 — 공헌이익 화면과 팀 목표 화면이 같은 숫자를 쓰도록 공용화.
   두 화면의 값이 어긋나면 사용자가 어느 쪽도 믿지 않게 된다. */
function computeCmOfMonth(month, sales, ads, fixed) {
  // 아직 오지 않은 날짜는 실적이 아니므로 제외 (미래 매출을 미리 입력해도 이익이 부풀지 않도록)
  const td = today();
  const rows = sales.filter(r => monthOf(r) === month && (r.date || "") <= td);
  const monthAds = ads.filter(a => String(a.date).slice(0, 7) === month && String(a.date) <= td);
  const adGross = monthAds.reduce((s, a) => s + Number(a.amount), 0);
  const adTotal = expNet(adGross);                    // 광고비도 공급가액 기준으로
  const fixTotal = fixed.reduce((s, f) => s + Number(f.amount), 0);

  const t = sumCM(rows);
  const shipCharged = shipChargedRows(rows);
  const cmNet = t.cm - adTotal;                       // 광고비까지 뺀 최종 공헌이익
  const cmRate = t.revenue ? (cmNet / t.revenue) * 100 : 0;
  const op = cmNet - fixTotal;                        // 영업이익 (고정비 차감)
  const bepRate = fixTotal ? Math.max(0, Math.min(100, Math.round((cmNet / fixTotal) * 100))) : null;

  // 일별 누적 (쌓여가는 구조)
  const dayMap = {};
  rows.forEach(r => {
    const d = r.date;
    if (!dayMap[d]) dayMap[d] = { revenue: 0, gross: 0, cm: 0 };
    const c = cmOfSale(r, shipCharged);
    dayMap[d].revenue += c.revenue;
    dayMap[d].gross += c.gross;      // 고객이 실제로 낸 금액 (일간 매출 목표는 이 기준)
    dayMap[d].cm += c.cm;
  });
  monthAds.forEach(a => {
    const d = String(a.date);
    if (!dayMap[d]) dayMap[d] = { revenue: 0, gross: 0, cm: 0 };
    dayMap[d].cm -= expNet(a.amount);
  });
  let acc = 0;
  const dayRows = Object.keys(dayMap).sort().map(d => { acc += dayMap[d].cm; return { d, ...dayMap[d], acc }; });

  return { td, rows, monthAds, adGross, adTotal, adVat: adGross - adTotal, fixTotal,
           t, shipCharged, cmNet, cmRate, op, bepRate, dayRows, acc };
}

async function viewProfit() {
  const { sales } = await loadErpBase();
  const [adRes, fixRes] = await Promise.all([
    sb.from("ad_costs").select("*").order("date", { ascending: false }),
    sb.from("fixed_costs").select("*").order("created_at"),
  ]);
  const ads = adRes.data || [];
  const fixed = (fixRes.data || []).filter(f => f.active !== false);
  profitAdsCache = ads;
  profitFixedCache = fixed;

  const m = computeCmOfMonth(erpMonth, sales, ads, fixed);
  const { td, rows, monthAds, adTotal, fixTotal, t, shipCharged, cmNet, cmRate, op, bepRate, dayRows, acc } = m;
  const maxAcc = Math.max(fixTotal, ...dayRows.map(x => Math.abs(x.acc)), 1);

  // BEP 달성 예상일
  let bepMsg = "";
  if (fixTotal > 0) {
    const hit = dayRows.find(x => x.acc >= fixTotal);
    if (hit) {
      bepMsg = `🎉 <b>${hit.d.slice(5)}에 손익분기 돌파</b> — 이후 공헌이익은 그대로 이익입니다`;
    } else if (acc > 0) {
      // '거래가 있었던 날 수'가 아니라 '실제 경과 일수'로 나눠야 속도가 부풀지 않음
      const isThisMonth = erpMonth === td.slice(0, 7);
      const lastDay = new Date(Number(erpMonth.slice(0, 4)), Number(erpMonth.slice(5, 7)), 0).getDate();
      const elapsed = isThisMonth ? Number(td.slice(8, 10)) : lastDay;
      const remain = isThisMonth ? lastDay - elapsed : 0;
      const perDay = acc / Math.max(1, elapsed);
      const need = Math.ceil((fixTotal - acc) / perDay);
      bepMsg = `현재 속도(하루 평균 ₩${fmt(Math.round(perDay))})면 <b>약 ${need}일 더</b> 필요합니다`
        + (isThisMonth
            ? (need > remain
                ? ` — 이번 달 남은 ${remain}일로는 <b style="color:var(--red)">도달이 어렵습니다</b>`
                : ` (이번 달 ${remain}일 남음)`)
            : "");
    } else {
      bepMsg = `손익분기까지 <b>₩${fmt(fixTotal - cmNet)}</b> 남았습니다`;
    }
  }

  // 채널별
  const byCh = {};
  rows.forEach(r => {
    const k = r.channel || "기타";
    if (!byCh[k]) byCh[k] = { revenue: 0, cost: 0, fee: 0, ship: 0, logi: 0, cm: 0, ad: 0 };
    const c = cmOfSale(r, shipCharged);
    byCh[k].revenue += c.revenue; byCh[k].cost += c.cost;
    byCh[k].fee += c.fee; byCh[k].ship += c.ship; byCh[k].logi += c.logi; byCh[k].cm += c.cm;
  });
  monthAds.forEach(a => {
    const k = a.channel || "기타";
    if (!byCh[k]) byCh[k] = { revenue: 0, cost: 0, fee: 0, ship: 0, logi: 0, cm: 0, ad: 0 };
    // 상단 합계와 같은 기준(부가세 제외)으로 차감해야 두 숫자가 어긋나지 않음
    const net = expNet(a.amount);
    byCh[k].ad += net;
    byCh[k].cm -= net;
  });

  // 품목별
  const byProd = {};
  rows.forEach(r => {
    if (!byProd[r.product_id]) byProd[r.product_id] = { qty: 0, revenue: 0, cm: 0 };
    const c = cmOfSale(r, shipCharged);
    byProd[r.product_id].qty += c.qty;
    byProd[r.product_id].revenue += c.revenue;
    byProd[r.product_id].cm += c.cm;
  });
  const prodList = Object.entries(byProd).sort((a, b) => b[1].cm - a[1].cm);

  const noSetting = erpChannelList.filter(c => !Number(c.fee_rate)).map(c => c.name);

  return `
    <div class="card">
      <div class="card-head">
        <h2>${erpMonth} 공헌이익</h2>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          ${monthPicker()}
          <button class="btn sm secondary" onclick="openAdModal()">＋ 광고비</button>
          <button class="btn sm secondary" onclick="openFixedModal()">고정비 설정</button>
        </div>
      </div>
      <div class="grid-stats">
        <div class="stat"><div class="stat-label">매출 (부가세 제외)</div>
          <div class="stat-value">₩${fmt(t.revenue)}</div>
          ${vatCfg.enabled && t.outVat ? `<div style="font-size:12px;color:var(--text-sub);margin-top:2px">
            고객이 낸 돈 ₩${fmt(t.gross)} − 부가세 ₩${fmt(t.outVat)}</div>` : ""}</div>
        <div class="stat"><div class="stat-label">변동비 합계</div>
          <div class="stat-value amber">₩${fmt(t.cost + t.fee + t.ship + t.logi + adTotal)}</div></div>
        <div class="stat"><div class="stat-label">공헌이익</div>
          <div class="stat-value" style="color:${cmNet >= 0 ? "var(--green)" : "var(--red)"}">₩${fmt(cmNet)}</div></div>
        <div class="stat"><div class="stat-label">공헌이익률</div>
          <div class="stat-value ${cmRate >= 30 ? "blue" : "amber"}">${cmRate.toFixed(1)}%</div></div>
      </div>
      ${vatCfg.enabled ? `<p style="font-size:12.5px;color:var(--text-sub);margin-top:10px">
        🧾 모든 금액은 <b>부가세를 뺀 공급가액</b> 기준입니다. 고객이 낸 부가세는 우리 이익이 아니라
        <a onclick="location.hash='#/vat'" style="color:var(--brand);cursor:pointer">나중에 내야 할 돈</a>이라 이익에서 제외합니다.
        (${vatCfg.salePriceIncludesVat ? "판매가=부가세 포함" : "판매가=부가세 별도"} ·
         ${vatCfg.purchaseCostIncludesVat ? "매입원가=부가세 포함" : "매입원가=부가세 별도"} —
        <a onclick="location.hash='#/settings'" style="color:var(--brand);cursor:pointer">설정 변경</a>)</p>` : ""}
      ${t.noCostRows ? `<div style="background:#fff4e6;border:1px solid #ffa94d;border-radius:9px;padding:12px;margin-top:12px;font-size:13px">
        <b style="color:#d9480f">⚠️ 위 공헌이익은 실제보다 부풀려져 있습니다</b><br>
        원가가 등록되지 않은 매출이 <b>${t.noCostRows}줄 (₩${fmt(t.noCostRevenue)})</b> 있습니다.
        이 매출은 원가를 0원으로 계산하므로, 실제 이익은 표시된 금액보다 <b>최소 ₩${fmt(Math.round(t.noCostRevenue * 0.5))} 이상 적습니다</b>.<br>
        <a onclick="location.hash='#/products'" style="color:var(--brand);cursor:pointer;font-weight:600">제품 마스터에서 원가 입력하기 →</a>
      </div>` : ""}
      ${t.unknownChannels.size ? `<div style="background:#fff4e6;border:1px solid #ffa94d;border-radius:9px;padding:12px;margin-top:10px;font-size:13px">
        <b style="color:#d9480f">⚠️ 채널 목록에 없는 이름으로 기록된 매출이 있습니다</b>: ${[...t.unknownChannels].map(esc).join(", ")}<br>
        이 매출들은 수수료·배송비가 0원으로 계산됩니다. 판매채널 화면에서 같은 이름으로 등록하거나, 매출의 채널명을 맞춰 주세요.
      </div>` : ""}
      ${noSetting.length ? `<p style="color:var(--text-sub);font-size:13px;margin-top:8px">
        ℹ️ 수수료율 0%: ${noSetting.map(esc).join(", ")} — 오픈마켓이라면
        <a onclick="location.hash='#/channels'" style="color:var(--brand);cursor:pointer">수수료율을 입력하세요</a>.</p>` : ""}
    </div>

    <div class="card">
      <h2>변동비 구성</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>항목</th><th class="num">금액</th><th class="num">매출 대비</th></tr></thead>
        <tbody>
          <tr><td>매출액</td><td class="num"><b>₩${fmt(t.revenue)}</b></td><td class="num">100%</td></tr>
          ${[["상품원가", t.cost], ["판매수수료", t.fee], ["출고배송비", t.ship],
             ["물류비 (로켓그로스 등)", t.logi], ["광고비", adTotal]]
            .filter(([label, v]) => v > 0 || !label.startsWith("물류비")).map(([label, v]) => `
            <tr><td style="padding-left:18px;color:var(--text-sub)">− ${label}</td>
              <td class="num">₩${fmt(v)}</td>
              <td class="num">${t.revenue ? (v / t.revenue * 100).toFixed(1) : 0}%</td></tr>`).join("")}
          <tr style="border-top:2px solid var(--line)">
            <td><b>= 공헌이익</b></td>
            <td class="num"><b style="color:${cmNet >= 0 ? "var(--green)" : "var(--red)"}">₩${fmt(cmNet)}</b></td>
            <td class="num"><b>${cmRate.toFixed(1)}%</b></td></tr>
          <tr><td style="padding-left:18px;color:var(--text-sub)">− 고정비 (월)</td>
            <td class="num">₩${fmt(fixTotal)}</td><td class="num">—</td></tr>
          <tr style="border-top:2px solid var(--line)">
            <td><b>= 영업이익</b></td>
            <td class="num"><b style="color:${op >= 0 ? "var(--green)" : "var(--red)"}">₩${fmt(op)}</b></td>
            <td class="num">${t.revenue ? (op / t.revenue * 100).toFixed(1) + "%" : "—"}</td></tr>
        </tbody>
      </table></div>
      ${fixTotal ? `
        <div style="margin-top:16px">
          <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:6px">
            <span>손익분기 달성률</span><b>${bepRate}%</b></div>
          <div class="bar bar-lg">
            <div class="bar-fill ${bepRate >= 100 ? "green" : ""}" style="width:${Math.max(0, bepRate)}%"></div>
          </div>
          <p style="font-size:13px;color:var(--text-sub);margin-top:8px">${bepMsg}</p>
        </div>` : `
        <p style="color:var(--text-sub);font-size:13px;margin-top:12px">
          ※ 고정비를 등록하면 손익분기가 표시됩니다.</p>`}
    </div>

    <div class="card">
      <h2>일별 공헌이익 누적</h2>
      ${dayRows.length ? `
      <div class="table-wrap"><table>
        <thead><tr><th>일자</th><th class="num">매출</th><th class="num">공헌이익</th><th class="num">누적</th><th style="min-width:120px">누적 추이</th></tr></thead>
        <tbody>${dayRows.map(x => {
          const w = Math.min(100, Math.round(Math.abs(x.acc) / maxAcc * 100));
          const over = fixTotal && x.acc >= fixTotal;
          return `<tr>
            <td>${esc(x.d.slice(5))}</td>
            <td class="num">₩${fmt(x.revenue)}</td>
            <td class="num" style="color:${x.cm >= 0 ? "var(--green)" : "var(--red)"}">₩${fmt(x.cm)}</td>
            <td class="num"><b>₩${fmt(x.acc)}</b></td>
            <td><div class="bar" style="height:10px">
              <div class="bar-fill ${x.acc < 0 ? "red" : over ? "green" : ""}" style="width:${w}%"></div></div></td>
          </tr>`; }).join("")}
        </tbody>
      </table></div>
      ${fixTotal ? `<p style="font-size:12px;color:var(--text-sub);margin-top:8px">
        막대는 월 고정비 ₩${fmt(fixTotal)} 기준입니다. 초록색이면 그 날짜에 손익분기를 넘긴 상태입니다.</p>` : ""}
      ` : `<div class="table-wrap"><table><tbody><tr><td class="empty">${erpMonth} 매출이 없습니다</td></tr></tbody></table></div>`}
    </div>

    <div class="card">
      <h2>채널별 공헌이익</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>채널</th><th class="num">매출</th><th class="num">원가</th><th class="num">수수료</th><th class="num">배송비</th><th class="num">물류비</th><th class="num">광고비</th><th class="num">공헌이익</th><th class="num">이익률</th></tr></thead>
        <tbody>${Object.keys(byCh).length ? Object.entries(byCh)
          .sort((a, b) => b[1].cm - a[1].cm).map(([k, v]) => `
          <tr>
            <td><b>${esc(k)}</b></td>
            <td class="num">₩${fmt(v.revenue)}</td>
            <td class="num">₩${fmt(v.cost)}</td>
            <td class="num">₩${fmt(v.fee)}</td>
            <td class="num">₩${fmt(v.ship)}</td>
            <td class="num">${v.logi ? "₩" + fmt(v.logi) : '<span style="color:var(--text-sub)">—</span>'}</td>
            <td class="num">₩${fmt(v.ad)}</td>
            <td class="num"><b style="color:${v.cm >= 0 ? "var(--green)" : "var(--red)"}">₩${fmt(v.cm)}</b></td>
            <td class="num">${v.revenue ? (v.cm / v.revenue * 100).toFixed(1) + "%" : "—"}</td>
          </tr>`).join("") : `<tr><td colspan="9" class="empty">데이터가 없습니다</td></tr>`}
        </tbody>
      </table></div>
    </div>

    <div class="card">
      <h2>품목별 공헌이익</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>품목</th><th class="num">수량</th><th class="num">매출</th><th class="num">공헌이익</th><th class="num">이익률</th><th class="num">개당 이익</th></tr></thead>
        <tbody>${prodList.length ? prodList.map(([pid, v]) => {
          const rate = v.revenue ? (v.cm / v.revenue * 100) : 0;
          return `<tr>
            <td><b>${esc(prodName(pid))}</b></td>
            <td class="num">${fmt(v.qty)}</td>
            <td class="num">₩${fmt(v.revenue)}</td>
            <td class="num"><b style="color:${v.cm >= 0 ? "var(--green)" : "var(--red)"}">₩${fmt(v.cm)}</b></td>
            <td class="num" style="color:${rate < 15 ? "#d9480f" : "inherit"}">${rate.toFixed(1)}%</td>
            <td class="num">₩${fmt(v.qty ? Math.round(v.cm / v.qty) : 0)}</td>
          </tr>`; }).join("") : `<tr><td colspan="6" class="empty">데이터가 없습니다</td></tr>`}
        </tbody>
      </table></div>
      <p style="font-size:12px;color:var(--text-sub);margin-top:10px">
        ※ 이익률 15% 미만은 주황색입니다. 많이 팔릴수록 손해인 상품을 여기서 잡아냅니다.</p>
    </div>

    <div class="card">
      <div class="card-head"><h2>${erpMonth} 광고비 내역</h2>
        <button class="btn sm secondary" onclick="openAdModal()">＋ 광고비 입력</button></div>
      <div class="table-wrap"><table>
        <thead><tr><th>일자</th><th>채널</th><th class="num">금액</th><th>메모</th><th>입력자</th><th></th></tr></thead>
        <tbody>${monthAds.length ? monthAds.map(a => `
          <tr>
            <td>${esc(String(a.date))}</td>
            <td>${esc(a.channel || "전체")}</td>
            <td class="num"><b>₩${fmt(a.amount)}</b></td>
            <td>${esc(a.memo)}</td>
            <td>${esc(a.created_by)}</td>
            <td><button class="btn sm danger" onclick="deleteErpRow('ad_costs','${a.id}')">삭제</button></td>
          </tr>`).join("") : `<tr><td colspan="6" class="empty">${erpMonth} 광고비가 없습니다</td></tr>`}
        </tbody>
      </table></div>
    </div>`;
}

let profitAdsCache = [], profitFixedCache = [];

/* ---------- 부가세 ---------- */
// 부가세 신고는 분기 단위. 1기 예정(1~3월)·확정(4~6월), 2기 예정(7~9월)·확정(10~12월)
const VAT_PERIODS = [
  { key: "1", label: "1~3월", months: ["01", "02", "03"], due: "4월 25일" },
  { key: "2", label: "4~6월", months: ["04", "05", "06"], due: "7월 25일" },
  { key: "3", label: "7~9월", months: ["07", "08", "09"], due: "10월 25일" },
  { key: "4", label: "10~12월", months: ["10", "11", "12"], due: "1월 25일" },
];
function vatPeriodOf(dateStr) {
  const m = String(dateStr).slice(5, 7);
  return VAT_PERIODS.find(p => p.months.includes(m));
}

async function viewVat() {
  const { sales, buys, costs } = await loadErpBase();
  const [adRes] = await Promise.all([sb.from("ad_costs").select("*")]);
  const ads = adRes.data || [];
  const td = today();
  const year = erpMonth.slice(0, 4);

  const calc = period => {
    const inRange = d => String(d).slice(0, 4) === year && period.months.includes(String(d).slice(5, 7)) && String(d) <= td;
    const s = sales.filter(r => inRange(r.date));
    const b = buys.filter(r => inRange(r.date));
    const c = costs.filter(r => inRange(r.date));
    const a = ads.filter(r => inRange(r.date));
    const prodOf = id => erpProducts.find(p => p.id === id);
    // 매출세액 = 고객에게 받은 부가세 (면세 상품은 0)
    const outVat = s.reduce((sum, r) => sum + saleVat(r.amount, prodOf(r.product_id)), 0);
    // 과세표준은 과세 매출만. 면세 매출은 신고서의 별도 칸이라 나눠서 보여줘야 함
    const taxableNet = s.filter(r => isTaxable(prodOf(r.product_id)))
      .reduce((sum, r) => sum + saleNet(r.amount, prodOf(r.product_id)), 0);
    const freeNet = s.filter(r => !isTaxable(prodOf(r.product_id)))
      .reduce((sum, r) => sum + Number(r.amount), 0);
    // 매입세액 = 우리가 낸 부가세 (공제받음)
    const buyVatSum = b.reduce((sum, r) => sum + buyVat(r.amount, prodOf(r.product_id)), 0);
    const buyNetSum = b.reduce((sum, r) => sum + buyNet(r.amount, prodOf(r.product_id)), 0);
    const costVat = c.reduce((sum, r) => sum + expVat(r.amount), 0);
    const adVat = a.reduce((sum, r) => sum + expVat(r.amount), 0);
    // 판매수수료·출고배송비에 붙은 부가세도 공제 대상 — 커머스에서 금액이 가장 큰 항목
    const shipCharged = shipChargedRows(s);
    const feeShipVat = s.reduce((sum, r) => sum + cmOfSale(r, shipCharged).feeShipVat, 0);
    const inVat = buyVatSum + costVat + adVat + feeShipVat;
    return { period, outVat, inVat, pay: outVat - inVat, taxableNet, freeNet, buyNetSum,
             costVat, adVat, buyVatSum, feeShipVat, saleCnt: s.length, buyCnt: b.length };
  };
  const periods = VAT_PERIODS.map(calc);
  // 선택한 연도가 올해가 아니면 '진행 중' 분기가 없음 (지난 해는 전 분기가 확정)
  const isThisYear = year === td.slice(0, 4);
  const nowP = isThisYear ? vatPeriodOf(td) : null;
  const cur = nowP ? periods.find(p => p.period.key === nowP.key) : periods[periods.length - 1];
  const yearPay = periods.reduce((s, p) => s + p.pay, 0);

  return `
    <div class="card">
      <div class="card-head"><h2>${year}년 부가세</h2>${monthPicker()}</div>
      ${vatCfgWarning()}
      ${!vatCfg.enabled ? `<p style="color:var(--text-sub);font-size:13.5px">
        부가세 계산이 <b>꺼져 있습니다</b>.
        일반과세자라면 <a onclick="location.hash='#/settings'" style="color:var(--brand);cursor:pointer">설정에서 켜 주세요</a>.</p>` : `
      <div class="grid-stats">
        <div class="stat"><div class="stat-label">${isThisYear ? "이번 분기" : "마지막 분기"} (${cur.period.label}) 낼 세금</div>
          <div class="stat-value ${cur.pay >= 0 ? "red" : "green"}">₩${fmt(Math.abs(cur.pay))}</div>
          <div style="font-size:12px;color:var(--text-sub);margin-top:2px">
            ${cur.pay >= 0 ? `${cur.period.due}까지 납부` : "환급 예상"}</div></div>
        <div class="stat"><div class="stat-label">받은 부가세 (매출세액)</div>
          <div class="stat-value">₩${fmt(cur.outVat)}</div></div>
        <div class="stat"><div class="stat-label">낸 부가세 (매입세액)</div>
          <div class="stat-value">₩${fmt(cur.inVat)}</div></div>
        <div class="stat"><div class="stat-label">${year}년 전체 예상</div>
          <div class="stat-value">₩${fmt(yearPay)}</div></div>
      </div>
      <div style="background:var(--brand-light);border-radius:9px;padding:14px;margin-top:14px;font-size:13.5px;line-height:1.7">
        <b>부가세는 우리 돈이 아닙니다.</b><br>
        물건을 팔 때 고객에게서 <b>부가세를 대신 받아 두었다가</b>, 분기마다 나라에 냅니다.
        대신 우리가 물건을 사면서 낸 부가세는 빼 줍니다.<br><br>
        <b>낼 세금 = 받은 부가세 − 낸 부가세</b><br>
        ${cur.period.label} = ₩${fmt(cur.outVat)} − ₩${fmt(cur.inVat)} = <b style="color:${cur.pay >= 0 ? "var(--red)" : "var(--green)"}">₩${fmt(cur.pay)}</b>
        ${cur.pay < 0 ? " (마이너스면 돌려받습니다)" : ""}<br><br>
        <span style="color:var(--text-sub)">낸 부가세에는 상품 매입 ₩${fmt(cur.buyVatSum)},
        판매수수료·배송비 ₩${fmt(cur.feeShipVat)}, 택배·운송비 ₩${fmt(cur.costVat)}, 광고비 ₩${fmt(cur.adVat)}가 들어 있습니다.</span>
      </div>`}
    </div>

    ${!vatCfg.enabled ? "" : `
    <div class="card">
      <h2>분기별 내역</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>분기</th><th class="num">과세 매출<br><small>부가세 제외</small></th><th class="num">면세 매출</th>
          <th class="num">받은 부가세</th><th class="num">매입<br><small>부가세 제외</small></th><th class="num">낸 부가세</th>
          <th class="num">낼 세금</th><th>납부기한</th><th></th></tr></thead>
        <tbody>${periods.map(p => {
          const isNow = nowP && p.period.key === nowP.key;
          return `
          <tr ${isNow ? 'style="background:var(--brand-light)"' : ""}>
            <td><b>${p.period.label}</b>${isNow ? ' <span class="chip mine">진행 중</span>' : ""}</td>
            <td class="num">₩${fmt(p.taxableNet)}</td>
            <td class="num">${p.freeNet ? "₩" + fmt(p.freeNet) : '<span style="color:var(--text-sub)">—</span>'}</td>
            <td class="num">₩${fmt(p.outVat)}</td>
            <td class="num">₩${fmt(p.buyNetSum)}</td>
            <td class="num">₩${fmt(p.inVat)}</td>
            <td class="num"><b style="color:${p.pay >= 0 ? "var(--red)" : "var(--green)"}">₩${fmt(p.pay)}</b></td>
            <td>${p.period.due}</td>
            <td>${p.pay > 0
              ? `<button class="btn sm secondary" onclick="registerVatPlan(${p.pay}, '${p.period.label}', '${p.period.due}', '${year}')">나갈 돈 등록</button>`
              : ""}</td>
          </tr>`; }).join("")}
        </tbody>
      </table></div>
      <p style="font-size:12px;color:var(--text-sub);margin-top:10px">
        ※ <b>낸 부가세</b> = 상품 매입 + 판매수수료 + 출고배송비 + 택배·운송비 + 광고비에 붙은 부가세를 모두 합한 금액입니다.<br>
        ※ 과세표준(과세 매출)과 면세 매출은 신고서에서 칸이 다르므로 나눠서 표시합니다.<br>
        ※ 실제 신고는 세무대리인을 통해 하시고, 이 화면은 <b>미리 준비하고 자금을 확보하기 위한 참고용</b>입니다.
      </p>
    </div>

    <div class="card">
      <h2>💰 세금 낼 돈 미리 챙겨두기</h2>
      <p style="font-size:13.5px;color:var(--text-sub);margin-bottom:12px">
        부가세는 통장에 있는 돈처럼 보이지만 <b>나중에 나갈 돈</b>입니다.
        미리 '나갈 돈'으로 등록해 두면 자금 예측에 반영되어, 납부일에 당황하지 않습니다.
        위 표에서 분기마다 <b>[나갈 돈 등록]</b>을 누르면 납부기한 날짜로 등록됩니다.</p>
      ${cur.pay > 0 ? `
        <button class="btn" onclick="registerVatPlan(${cur.pay}, '${cur.period.label}', '${cur.period.due}', '${year}')">
          ${cur.period.label} 부가세 ₩${fmt(cur.pay)}을(를) 나갈 돈으로 등록</button>
        ${isThisYear ? `<p style="font-size:12px;color:var(--text-sub);margin-top:8px">
          ※ 분기가 끝나기 전이라 금액은 계속 늘어납니다. 분기 마감 후 다시 등록하면 정확합니다.</p>` : ""}
      ` : `<p style="color:var(--text-sub);font-size:13px">${cur.period.label}은 낼 세금이 없습니다 (환급 또는 0원).</p>`}
    </div>`}`;
}

async function registerVatPlan(amount, label, due, year) {
  // 납부일은 '그 분기가 속한 연도' 기준. 4분기(10~12월)만 다음 해 1월 25일
  const y = Number(year || today().slice(0, 4));
  const mm = { "4월 25일": "04", "7월 25일": "07", "10월 25일": "10", "1월 25일": "01" }[due];
  const yy = mm === "01" ? y + 1 : y;
  const date = `${yy}-${mm}-25`;
  if (date < today() && !confirm(
    `${date}은 이미 지난 날짜입니다.\n(${label} 부가세 납부기한)\n\n그래도 등록할까요?`)) return;
  if (!confirm(`${label} 부가세 ₩${fmt(amount)}을(를)\n${date} 나갈 돈으로 등록할까요?`)) return;
  const { error } = await sb.from("cash_plans").insert({
    date, kind: "출금", title: `부가세 납부 (${label})`, amount, repeat: "없음", created_by: me.name,
  });
  if (error) return toast("등록에 실패했습니다");
  toast("자금일보의 '나갈 돈'에 등록되었습니다");
  location.hash = "#/cash";
}

function openAdModal() {
  const chOpts = erpChannels.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
  document.getElementById("modal-root").innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal">
        <h3>광고비 입력</h3>
        <div class="form-grid">
          <div class="field"><label>일자 *</label><input id="ad-date" type="date" value="${today()}"></div>
          <div class="field"><label>채널</label>
            <select id="ad-ch"><option value="">전체 (공통)</option>${chOpts}</select></div>
          <div class="field full"><label>금액(원) *${vatTag("exp")}</label><input id="ad-amt" type="text" inputmode="numeric" class="comma" placeholder="0">
            <p style="font-size:12px;color:var(--text-sub);margin-top:4px">
              ${vatCfg.expenseIncludesVat ? "광고비 청구서에 적힌 금액 그대로 입력하세요 (부가세 포함)." : "부가세를 뺀 금액으로 입력하세요."}</p></div>
          <div class="field full"><label>메모</label><input id="ad-memo" maxlength="100" placeholder="예) 쿠팡 광고 8월 1주차"></div>
        </div>
        <div class="modal-actions">
          <button class="btn secondary" onclick="closeModal()">취소</button>
          <button class="btn" id="btn-ad-save" onclick="saveAd()">저장</button>
        </div>
      </div>
    </div>`;
}

async function saveAd() {
  const date = document.getElementById("ad-date").value;
  const amount = numOf(document.getElementById("ad-amt").value) || 0;
  if (!date) return toast("일자를 선택해 주세요");
  if (amount <= 0) return toast("금액을 입력해 주세요");
  const btn = document.getElementById("btn-ad-save");
  btn.disabled = true;
  const { error } = await sb.from("ad_costs").insert({
    date, amount,
    channel: document.getElementById("ad-ch").value || null,
    memo: document.getElementById("ad-memo").value.trim(),
    created_by: me.name,
  });
  if (error) { btn.disabled = false; return toast("저장에 실패했습니다"); }
  toast("광고비가 저장되었습니다");
  closeModal();
  erpMonth = date.slice(0, 7);
  route();
}

function openFixedModal() {
  const list = profitFixedCache;
  const total = list.reduce((s, f) => s + Number(f.amount), 0);
  document.getElementById("modal-root").innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal" style="max-width:560px">
        <h3>월 고정비 설정</h3>
        <p style="font-size:13px;color:var(--text-sub);margin:4px 0 12px">
          매달 고정 지출 (임대료·급여 등). 공헌이익이 이걸 넘으면 흑자입니다.</p>
        <div class="table-wrap"><table>
          <thead><tr><th>항목</th><th class="num">월 금액</th><th></th></tr></thead>
          <tbody>${list.length ? list.map(f => `
            <tr><td>${esc(f.title)}</td><td class="num">₩${fmt(f.amount)}</td>
              <td><button class="btn sm danger" onclick="deleteFixed('${f.id}')">삭제</button></td></tr>`).join("")
            : `<tr><td colspan="3" class="empty">등록된 고정비가 없습니다</td></tr>`}
          </tbody>
          ${list.length ? `<tfoot><tr><td><b>합계</b></td><td class="num"><b>₩${fmt(total)}</b></td><td></td></tr></tfoot>` : ""}
        </table></div>
        <div class="form-grid" style="margin-top:14px">
          <div class="field"><label>항목명</label><input id="fx-title" maxlength="40" placeholder="예) 사무실 임대료"></div>
          <div class="field"><label>월 금액(원)</label><input id="fx-amt" type="text" inputmode="numeric" class="comma" placeholder="0"></div>
        </div>
        <div class="modal-actions">
          <button class="btn secondary" onclick="closeModal()">닫기</button>
          <button class="btn" id="btn-fx-save" onclick="saveFixed()">추가</button>
        </div>
      </div>
    </div>`;
}

async function saveFixed() {
  const title = document.getElementById("fx-title").value.trim();
  const amount = numOf(document.getElementById("fx-amt").value) || 0;
  if (!title) return toast("항목명을 입력해 주세요");
  if (amount <= 0) return toast("금액을 입력해 주세요");
  const btn = document.getElementById("btn-fx-save");
  btn.disabled = true;
  const { error } = await sb.from("fixed_costs").insert({ title, amount });
  if (error) { btn.disabled = false; return toast("저장에 실패했습니다"); }
  toast("고정비가 추가되었습니다");
  closeModal();
  route();
}

async function deleteFixed(id) {
  if (!confirm("이 고정비 항목을 삭제할까요?")) return;
  const { error } = await sb.from("fixed_costs").delete().eq("id", id);
  if (error) return toast("삭제에 실패했습니다");
  toast("삭제되었습니다");
  closeModal();
  route();
}

async function viewReport() {
  const { buys, sales, costs } = await loadErpBase();

  // 최근 6개월 매출/매입/차액 (매입 = 상품 + 택배·운송비)
  const months = [];
  const now = new Date();
  for (let i = 0; i < 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}`);
  }
  const monthRows = months.map(m => {
    const sale = sales.filter(r => monthOf(r) === m).reduce((s, r) => s + Number(r.amount), 0);
    const goods = buys.filter(r => monthOf(r) === m).reduce((s, r) => s + Number(r.amount), 0);
    const extra = costs.filter(r => monthOf(r) === m).reduce((s, r) => s + Number(r.amount), 0);
    const buy = goods + extra;
    return { m, sale, buy, goods, extra, diff: sale - buy };
  });

  // 이번 달 채널별 / 품목별
  const nowMonth = months[0];
  const monthSales = sales.filter(r => monthOf(r) === nowMonth);
  const byChannel = {};
  monthSales.forEach(r => {
    const c = r.channel || "기타";
    byChannel[c] = (byChannel[c] || 0) + Number(r.amount);
  });
  const byProduct = {};
  monthSales.forEach(r => {
    if (!byProduct[r.product_id]) byProduct[r.product_id] = { qty: 0, amount: 0 };
    byProduct[r.product_id].qty += Number(r.qty);
    byProduct[r.product_id].amount += Number(r.amount);
  });
  const topProducts = Object.entries(byProduct)
    .sort((a, b) => b[1].amount - a[1].amount).slice(0, 5);

  // 이번 달 사입/위탁 매출 분리
  const saipSales = monthSales.filter(r => tradeTypeOfId(r.product_id) === "사입")
    .reduce((s, r) => s + Number(r.amount), 0);
  const witakSales = monthSales.filter(r => tradeTypeOfId(r.product_id) === "위탁")
    .reduce((s, r) => s + Number(r.amount), 0);

  return `
    <div class="grid-stats">
      <div class="stat"><div class="stat-label">${nowMonth} 사입 매출</div>
        <div class="stat-value blue">₩${fmt(saipSales)}</div></div>
      <div class="stat"><div class="stat-label">${nowMonth} 위탁 매출</div>
        <div class="stat-value amber">₩${fmt(witakSales)}</div></div>
    </div>
    <div class="card">
      <h2>최근 6개월 매출 · 매입</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>월</th><th class="num">매출</th><th class="num">매입</th><th class="num">차액 (매출−매입)</th></tr></thead>
        <tbody>${monthRows.map(r => `
          <tr>
            <td><b>${r.m}</b></td>
            <td class="num">₩${fmt(r.sale)}</td>
            <td class="num">₩${fmt(r.buy)}${r.extra ? `<br><small style="color:var(--text-sub)">상품 ₩${fmt(r.goods)} + 택배·운송 ₩${fmt(r.extra)}</small>` : ""}</td>
            <td class="num" style="font-weight:700;color:${r.diff >= 0 ? "var(--green)" : "var(--red)"}">₩${fmt(r.diff)}</td>
          </tr>`).join("")}
        </tbody>
      </table></div>
      <p style="color:var(--text-sub);font-size:12px;margin-top:10px">
        ※ 매입 = 상품 매입 + 택배비·운송비. 차액은 단순 매출−매입입니다. (기간 내 재고 변동·경비 미반영)
      </p>
    </div>

    <div class="card">
      <h2>${nowMonth} 채널별 매출</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>채널</th><th class="num">매출액</th><th class="num">비중</th></tr></thead>
        <tbody>${Object.keys(byChannel).length ? Object.entries(byChannel)
          .sort((a, b) => b[1] - a[1]).map(([c, v]) => {
            const total = Object.values(byChannel).reduce((s, x) => s + x, 0);
            return `<tr><td><b>${esc(c)}</b></td><td class="num">₩${fmt(v)}</td>
              <td class="num">${total ? Math.round(v / total * 100) : 0}%</td></tr>`;
          }).join("") : `<tr><td colspan="3" class="empty">이번 달 매출이 없습니다</td></tr>`}
        </tbody>
      </table></div>
    </div>

    <div class="card">
      <h2>${nowMonth} 품목별 매출 TOP 5</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>품목</th><th class="num">판매 수량</th><th class="num">매출액</th></tr></thead>
        <tbody>${topProducts.length ? topProducts.map(([pid, v]) => `
          <tr><td><b>${esc(prodName(pid))}</b></td>
            <td class="num">${fmt(v.qty)}</td><td class="num">₩${fmt(v.amount)}</td></tr>`).join("")
          : `<tr><td colspan="3" class="empty">이번 달 매출이 없습니다</td></tr>`}
        </tbody>
      </table></div>
    </div>`;
}

/* ==================== 발주서 ====================
   발주(예정) 과 매입(실적)은 분리한다. 발주만 하고 안 들어온 물건이 재고로 잡히면 안 되기 때문.
   흐름: 작성 → 결재 → 발주 완료 → 입고 처리(부분 가능) → 매입 자동 생성 */
let poCache = [], poItemCache = {};

const PO_STATUS = {
  progress: { label: "결재 대기", chip: "progress" },
  approved: { label: "승인 완료", chip: "approved" },
  rejected: { label: "반려", chip: "rejected" },
  ordered:  { label: "발주 완료", chip: "mine" },
  partial:  { label: "부분 입고", chip: "progress" },
  done:     { label: "입고 완료", chip: "approved" },
  canceled: { label: "취소", chip: "waiting" },
};
const poChip = s => { const t = PO_STATUS[s] || PO_STATUS.progress;
  return `<span class="chip ${t.chip}">${t.label}</span>`; };

async function loadPOs() {
  const [poRes, itRes] = await Promise.all([
    sb.from("purchase_orders").select("*").order("date", { ascending: false }).order("created_at", { ascending: false }),
    sb.from("purchase_order_items").select("*"),
  ]);
  poCache = poRes.data || [];
  poItemCache = {};
  (itRes.data || []).forEach(it => { (poItemCache[it.po_id] ||= []).push(it); });
  return poCache;
}

const poRemain = id => (poItemCache[id] || []).reduce((s, it) => s + (Number(it.qty) - Number(it.received_qty)), 0);
const poOrdered = id => (poItemCache[id] || []).reduce((s, it) => s + Number(it.qty), 0);

async function viewPurchaseOrders() {
  await loadErpBase();
  await loadPOs();
  const waiting = poCache.filter(p => p.status === "progress" &&
    p.approval_line?.[p.current_step]?.userId === me.id).length;
  const open = poCache.filter(p => ["ordered", "partial"].includes(p.status));

  return `
    <div class="card">
      <div class="card-head"><h2>📦 발주서</h2>
        <button class="btn" onclick="openPOModal()">＋ 발주서 작성</button></div>
      <p style="font-size:13px;color:var(--text-sub)">
        발주 = 주문. <b>[입고 처리]</b>를 눌러야 재고에 반영됩니다.</p>
      ${waiting ? `<div style="background:var(--amber-bg);border:1px solid var(--amber);border-radius:9px;padding:10px 12px;margin-top:12px;font-size:13.5px">
        ⏳ 내 결재를 기다리는 발주서가 <b>${waiting}건</b> 있습니다.</div>` : ""}
    </div>

    ${open.length ? `
    <div class="card">
      <h2>🚚 입고 대기 중 (${open.length}건)</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>발주번호</th><th>거래처</th><th>입고처</th><th class="num">발주 수량</th><th class="num">미입고</th><th>상태</th><th></th></tr></thead>
        <tbody>${open.map(p => `
          <tr>
            <td><b>${esc(p.po_no)}</b><br><small style="color:var(--text-sub)">${esc(p.date)}</small></td>
            <td>${esc(p.supplier)}</td>
            <td>${p.deliver_to === "쿠팡" ? '<span class="chip mine">쿠팡 직송</span>' : "자사창고"}</td>
            <td class="num">${fmt(poOrdered(p.id))}</td>
            <td class="num"><b style="color:var(--amber)">${fmt(poRemain(p.id))}</b></td>
            <td>${poChip(p.status)}</td>
            <td><button class="btn sm" onclick="openReceiveModal('${p.id}')">입고 처리</button></td>
          </tr>`).join("")}
        </tbody>
      </table></div>
    </div>` : ""}

    <div class="card">
      <h2>전체 발주 내역 (${poCache.length}건)</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>발주번호</th><th>발주일</th><th>거래처</th><th>입고처</th><th class="num">금액</th><th class="num">운송비(예상)</th><th>상태</th><th>기안</th><th></th></tr></thead>
        <tbody>${poCache.length ? poCache.map(p => `
          <tr class="clickable" onclick="openPODetail('${p.id}')">
            <td><b>${esc(p.po_no)}</b></td>
            <td>${esc(p.date)}</td>
            <td>${esc(p.supplier)}</td>
            <td>${p.deliver_to === "쿠팡" ? "쿠팡 직송" : "자사창고"}</td>
            <td class="num">₩${fmt(p.total)}</td>
            <td class="num">${p.freight_est ? "₩" + fmt(p.freight_est) : "—"}</td>
            <td>${poChip(p.status)}</td>
            <td>${esc(userName(p.drafter_id))}</td>
            <td style="white-space:nowrap">
              <button class="btn sm secondary" onclick="event.stopPropagation();openPODetail('${p.id}')">열기</button>
              <button class="btn sm secondary" onclick="event.stopPropagation();location.hash='#/podoc/${p.id}'">📄</button></td>
          </tr>`).join("") : `<tr><td colspan="9" class="empty">작성된 발주서가 없습니다</td></tr>`}
        </tbody>
      </table></div>
    </div>`;
}

function openPOModal() {
  const approvers = USERS.filter(u => u.id !== me.id && (Number(u.rank) || 0) > (Number(me.rank) || 0));
  const isJeongyeol = approvers.length === 0;   // 최상위가 기안하면 전결
  document.getElementById("modal-root").innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal" style="max-width:820px;width:96vw">
        <h3>📦 발주서 작성</h3>
        <div class="form-grid">
          <div class="field"><label>발주일 *</label><input id="po-date" type="date" value="${today()}"></div>
          <div class="field"><label>납품희망일</label><input id="po-due" type="date" value="${addDaysStr(today(), 7)}"></div>
          <div class="field"><label>거래처 *
            <a onclick="closeModal();location.hash='#/suppliers'" style="color:var(--brand);font-size:12px;cursor:pointer;font-weight:400">＋거래처 관리</a></label>
            ${supplierOptionsHtml().replace(/id="b-supplier"/, 'id="po-supplier"')}</div>
          <div class="field"><label>입고처 *</label>
            <select id="po-deliver">
              <option value="쿠팡">쿠팡 (로켓그로스) — 공급처에서 바로 입고</option>
              <option value="자사창고">자사창고 — 우리 창고로 받음</option>
            </select></div>
          <div class="field"><label>예상 운송비(원) ${vatTag("exp")}</label>
            <input id="po-freight" type="text" inputmode="numeric" class="comma" placeholder="0">
            <p style="font-size:12px;color:var(--text-sub);margin-top:4px">우리가 운송업체에 직접 내는 금액입니다.</p></div>
          ${isJeongyeol ? "" : `
          <div class="field full"><label>결재자 *</label>
            <select id="po-appr">${approvers.map(u =>
              `<option value="${u.id}">${esc(u.name)} ${esc(u.role)}</option>`).join("")}</select></div>`}
          <div class="field full"><label>메모</label><input id="po-memo" maxlength="100" placeholder="예) 로켓그로스 8월 보충"></div>
        </div>
        <div class="table-wrap" style="margin-top:8px"><table class="items-table">
          <thead><tr><th style="min-width:190px">품목</th><th style="width:85px" class="num">수량</th>
            <th style="width:130px" class="num">단가${vatTag("buy")}</th><th style="width:110px" class="num">금액</th><th style="width:40px"></th></tr></thead>
          <tbody id="po-rows"></tbody>
        </table></div>
        <button class="btn sm secondary" onclick="addPORow()" style="margin-top:8px">＋ 품목 추가</button>
        <div class="total-line">상품 합계 <b id="po-total">₩0</b></div>
        ${isJeongyeol ? `<p style="font-size:13px;color:var(--text-sub)">
          ※ 상위 결재자가 없어 <b>전결</b>로 바로 승인 처리됩니다.</p>` : ""}
        <div class="modal-actions">
          <button class="btn secondary" onclick="closeModal()">취소</button>
          <button class="btn" id="btn-po-save" onclick="savePO(${isJeongyeol})">${isJeongyeol ? "발주서 등록 (전결)" : "결재 올리기"}</button>
        </div>
      </div>
    </div>`;
  addPORow();
}

function addPORow() {
  const tb = document.getElementById("po-rows");
  if (!tb) return;
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td>${productPicker("po-prod", "", "buy", "onPORowProduct")}</td>
    <td><input class="po-qty" type="number" min="1" value="1" oninput="calcPOTotal()"></td>
    <td><input class="po-cost comma" type="text" inputmode="numeric" placeholder="0" oninput="calcPOTotal()"></td>
    <td class="num po-amt" style="font-weight:700">₩0</td>
    <td><button class="btn-row-del" title="삭제" onclick="this.closest('tr').remove();calcPOTotal()">✕</button></td>`;
  tb.appendChild(tr);
}
function onPORowProduct(sel) {
  const st = erpStock[pidOf(sel)];
  if (st?.lastCost) sel.closest("tr").querySelector(".po-cost").value = fmt(st.lastCost);
  calcPOTotal();
}
function calcPOTotal() {
  let total = 0;
  document.querySelectorAll("#po-rows tr").forEach(tr => {
    const amt = (numOf(tr.querySelector(".po-qty").value) || 0) * (numOf(tr.querySelector(".po-cost").value) || 0);
    tr.querySelector(".po-amt").textContent = "₩" + fmt(amt);
    total += amt;
  });
  const el = document.getElementById("po-total");
  if (el) el.textContent = "₩" + fmt(total);
}

async function savePO(isJeongyeol) {
  const date = document.getElementById("po-date").value;
  const supplier = document.getElementById("po-supplier")?.value.trim() || "";
  if (!date) return toast("발주일을 선택해 주세요");
  if (!supplier) return toast("거래처를 선택해 주세요");
  const items = [];
  for (const tr of document.querySelectorAll("#po-rows tr")) {
    const pid = pidOf(tr.querySelector(".po-prod"));
    const qty = numOf(tr.querySelector(".po-qty").value) || 0;
    const cost = numOf(tr.querySelector(".po-cost").value) || 0;
    if (!pid && !cost) continue;
    if (!pid) return toast("품목을 선택해 주세요");
    if (qty <= 0 || !Number.isInteger(qty)) return toast("수량은 1 이상 정수로 입력해 주세요");
    if (cost <= 0) return toast(`'${prodName(pid)}'의 단가를 입력해 주세요`);
    items.push({ product_id: pid, qty, unit_cost: cost, amount: qty * cost });
  }
  if (!items.length) return toast("품목을 1개 이상 입력해 주세요");
  const btn = document.getElementById("btn-po-save");
  btn.disabled = true;

  const { data: noData } = await sb.rpc("next_po_no");
  const line = isJeongyeol ? [] : [{ userId: document.getElementById("po-appr").value, status: "pending", date: "" }];
  const { data: po, error } = await sb.from("purchase_orders").insert({
    po_no: noData || `리버스-발주-${today().slice(0, 4)}-${Date.now().toString().slice(-3)}`,
    date, supplier,
    due_date: document.getElementById("po-due").value || null,
    deliver_to: document.getElementById("po-deliver").value,
    freight_est: numOf(document.getElementById("po-freight").value) || 0,
    total: items.reduce((s, i) => s + i.amount, 0),
    memo: document.getElementById("po-memo").value.trim(),
    status: isJeongyeol ? "ordered" : "progress",
    drafter_id: me.id, approval_line: line, current_step: 0,
    ordered_at: isJeongyeol ? new Date().toISOString() : null,
  }).select("id").single();
  if (error || !po) { btn.disabled = false; return toast("발주서 등록에 실패했습니다"); }

  const { error: e2 } = await sb.from("purchase_order_items")
    .insert(items.map(i => ({ ...i, po_id: po.id })));
  if (e2) { await sb.from("purchase_orders").delete().eq("id", po.id); btn.disabled = false; return toast("품목 저장에 실패했습니다"); }

  toast(isJeongyeol ? "발주서가 등록되었습니다 (전결)" : "결재를 올렸습니다 (알림 발송)");
  closeModal();
  route();
}

function openPODetail(id) {
  const p = poCache.find(x => x.id === id);
  if (!p) return;
  const items = poItemCache[id] || [];
  const step = p.approval_line?.[p.current_step];
  const canDecide = p.status === "progress" && step?.userId === me.id;
  const canOrder = p.status === "approved";
  const canReceive = ["ordered", "partial"].includes(p.status);
  const sup = erpSupplierList.find(s => s.name === p.supplier);
  document.getElementById("modal-root").innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal" style="max-width:820px;width:96vw">
        <div class="card-head" style="margin-bottom:10px">
          <h3>${esc(p.po_no)}</h3>${poChip(p.status)}
        </div>
        <div class="table-wrap"><table><tbody>
          <tr><td style="width:110px;color:var(--text-sub)">발주일</td><td>${esc(p.date)}</td>
              <td style="width:110px;color:var(--text-sub)">거래처</td><td>${esc(p.supplier)}${sup?.pay_terms ? ` <span class="chip waiting">${esc(sup.pay_terms)}</span>` : ""}</td></tr>
          <tr><td style="color:var(--text-sub)">입고처</td><td>${p.deliver_to === "쿠팡" ? "쿠팡 (로켓그로스 직송)" : "자사창고"}</td>
              <td style="color:var(--text-sub)">기안</td><td>${esc(userName(p.drafter_id))}</td></tr>
          <tr><td style="color:var(--text-sub)">예상 운송비</td><td>${p.freight_est ? "₩" + fmt(p.freight_est) : "—"}</td>
              <td style="color:var(--text-sub)">메모</td><td>${esc(p.memo) || "—"}</td></tr>
        </tbody></table></div>

        <h3 style="font-size:15px;margin:16px 0 8px">품목</h3>
        <div class="table-wrap"><table>
          <thead><tr><th>품목</th><th class="num">발주</th><th class="num">입고</th><th class="num">미입고</th><th class="num">단가</th><th class="num">금액</th></tr></thead>
          <tbody>${items.map(it => `
            <tr>
              <td><b>${esc(prodName(it.product_id))}</b></td>
              <td class="num">${fmt(it.qty)}</td>
              <td class="num" style="color:var(--green)">${fmt(it.received_qty)}</td>
              <td class="num" style="color:${it.qty - it.received_qty > 0 ? "var(--amber)" : "var(--text-sub)"}">${fmt(it.qty - it.received_qty)}</td>
              <td class="num">₩${fmt(it.unit_cost)}</td>
              <td class="num"><b>₩${fmt(it.amount)}</b></td>
            </tr>`).join("")}
          </tbody>
          <tfoot><tr><td colspan="5"><b>합계</b></td><td class="num"><b>₩${fmt(p.total)}</b></td></tr></tfoot>
        </table></div>

        ${p.approval_line?.length ? `
          <h3 style="font-size:15px;margin:16px 0 8px">결재</h3>
          <div class="table-wrap"><table><tbody>${p.approval_line.map((s, i) => `
            <tr><td>${esc(userName(s.userId))}</td>
              <td>${s.status === "approved" ? '<span class="chip approved">승인</span>'
                  : s.status === "rejected" ? '<span class="chip rejected">반려</span>'
                  : i === p.current_step ? '<span class="chip progress">차례</span>' : '<span class="chip waiting">대기</span>'}</td>
              <td>${esc(s.date) || "—"}</td></tr>`).join("")}
          </tbody></table></div>` : `
          <p style="font-size:13px;color:var(--text-sub);margin-top:12px">전결 처리된 발주서입니다.</p>`}

        <div class="modal-actions" style="flex-wrap:wrap;gap:8px">
          <button class="btn secondary" onclick="closeModal()">닫기</button>
          <button class="btn secondary" onclick="closeModal();location.hash='#/podoc/${p.id}'">📄 발주서 보기</button>
          ${canOrder || ["ordered","partial","done"].includes(p.status)
            ? `<button class="btn" onclick="closeModal();location.hash='#/podoc/${p.id}'">📧 메일 보내기</button>` : ""}
          ${canDecide ? `
            <button class="btn danger" onclick="decidePO('${p.id}','rejected')">반려</button>
            <button class="btn green" onclick="decidePO('${p.id}','approved')">승인</button>` : ""}
          ${canOrder ? `<button class="btn" onclick="markOrdered('${p.id}')">거래처에 발주 완료</button>` : ""}
          ${canReceive ? `<button class="btn" onclick="openReceiveModal('${p.id}')">입고 처리</button>` : ""}
          ${["progress", "approved"].includes(p.status) && p.drafter_id === me.id
            ? `<button class="btn danger" onclick="cancelPO('${p.id}')">발주 취소</button>` : ""}
        </div>
      </div>
    </div>`;
}

/* ---------- 발주서 문서 (인쇄·PDF·메일용 정식 양식) ---------- */
async function viewPODoc(id) {
  // 문서 화면은 항상 최신 상태로 — 캐시를 쓰면 결재 결과가 반영되지 않는다
  await loadErpBase();
  await loadPOs();
  const p = poCache.find(x => x.id === id);
  if (!p) return `<div class="card"><p>발주서를 찾을 수 없습니다.</p>
    <button class="btn" onclick="location.hash='#/po'">발주서 목록으로</button></div>`;
  const items = poItemCache[id] || [];
  const sup = erpSupplierList.find(s => s.name === p.supplier) || {};
  // 면세 상품은 부가세가 붙지 않으므로 품목별로 계산해야 정확하다
  const { net, vat } = poVatOf(items);
  const grand = net + vat;
  const approved = ["approved", "ordered", "partial", "done"].includes(p.status);
  const apprStep = (p.approval_line || []).find(s => s.status === "approved");
  const canSend = approved;

  return `
    <div class="no-print" style="margin-bottom:14px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <button class="btn secondary" onclick="location.hash='#/po'">← 목록</button>
      ${canSend ? `
        <button class="btn" onclick="mailPOHtml('${p.id}')">📧 메일로 보내기 (표 그대로)</button>
        <button class="btn secondary" onclick="window.print()">🖨 인쇄 · PDF 저장</button>
        <button class="btn secondary" onclick="mailPO('${p.id}')">✉️ 휴대폰 메일앱 (텍스트)</button>
        <button class="btn secondary" onclick="copyPOText('${p.id}')">📋 텍스트 복사</button>
      ` : `<span class="chip progress">결재가 끝나야 보낼 수 있습니다</span>`}
      ${!sup.email && canSend ? `<span style="font-size:12.5px;color:#d9480f">
        ⚠️ ${esc(p.supplier)}의 이메일이 등록되지 않았습니다 —
        <a onclick="location.hash='#/suppliers'" style="color:var(--brand);cursor:pointer;font-weight:600">등록하기 →</a></span>` : ""}
      ${!companyCfg.biz_no ? `<span style="font-size:12.5px;color:#d9480f">
        ⚠️ 우리 회사 사업자정보가 비어 있습니다 —
        <a onclick="location.hash='#/settings'" style="color:var(--brand);cursor:pointer;font-weight:600">설정에서 입력 →</a></span>` : ""}
    </div>

    <div class="card po-doc" id="po-doc">
      <div class="po-title">발 주 서</div>
      <div class="po-sub">PURCHASE ORDER</div>

      <table class="po-meta">
        <tr><th>발주번호</th><td><b>${esc(p.po_no)}</b></td>
            <th>발주일</th><td>${esc(p.date)}</td></tr>
        <tr><th>납품희망일</th><td>${p.due_date ? esc(p.due_date) : "협의"}</td>
            <th>입고처</th><td>${p.deliver_to === "쿠팡" ? "쿠팡 물류센터 (로켓그로스)" : "자사창고"}</td></tr>
      </table>

      <div class="po-parties">
        <div class="po-party">
          <div class="po-party-h">공급자 (받는 분)</div>
          <table><tbody>
            <tr><th>상호</th><td><b>${esc(p.supplier)}</b></td></tr>
            <tr><th>사업자번호</th><td>${esc(sup.biz_no) || "—"}</td></tr>
            <tr><th>대표자</th><td>${esc(sup.ceo) || "—"}</td></tr>
            <tr><th>담당자</th><td>${esc(sup.manager) || "—"}</td></tr>
            <tr><th>연락처</th><td>${esc(sup.phone) || "—"}</td></tr>
            <tr><th>이메일</th><td>${esc(sup.email) || "—"}</td></tr>
          </tbody></table>
        </div>
        <div class="po-party">
          <div class="po-party-h">발주자 (보내는 분)</div>
          <table><tbody>
            <tr><th>상호</th><td><b>${esc(companyCfg.name)}</b></td></tr>
            <tr><th>사업자번호</th><td>${esc(companyCfg.biz_no) || "—"}</td></tr>
            <tr><th>대표자</th><td>${esc(companyCfg.ceo) || "—"}</td></tr>
            <tr><th>주소</th><td>${esc(companyCfg.addr) || "—"}</td></tr>
            <tr><th>연락처</th><td>${esc(companyCfg.phone) || "—"}</td></tr>
            <tr><th>이메일</th><td>${esc(companyCfg.email) || "—"}</td></tr>
          </tbody></table>
        </div>
      </div>

      <p class="po-greet">아래와 같이 발주하오니 확인 후 납품하여 주시기 바랍니다.</p>

      <table class="po-items">
        <thead><tr><th style="width:36px">No</th><th>품목</th><th style="width:80px" class="num">수량</th>
          <th style="width:110px" class="num">단가</th><th style="width:130px" class="num">공급가액</th></tr></thead>
        <tbody>${items.map((it, i) => `
          <tr>
            <td class="num">${i + 1}</td>
            <td><b>${esc(prodName(it.product_id))}</b>${isTaxable(erpProducts.find(x => x.id === it.product_id)) ? "" : " <small>(면세)</small>"}${it.memo ? `<br><small>${esc(it.memo)}</small>` : ""}</td>
            <td class="num">${fmt(it.qty)}</td>
            <td class="num">${fmt(it.unit_cost)}</td>
            <td class="num">${fmt(it.amount)}</td>
          </tr>`).join("")}
        </tbody>
        <tfoot>
          <tr><td colspan="4">공급가액</td><td class="num">${fmt(net)}</td></tr>
          ${vatCfg.enabled ? `<tr><td colspan="4">부가세 (10%)</td><td class="num">${fmt(vat)}</td></tr>` : ""}
          <tr class="po-grand"><td colspan="4"><b>합계 금액</b></td><td class="num"><b>₩${fmt(grand)}</b></td></tr>
        </tfoot>
      </table>

      ${p.freight_est ? `<p class="po-note">※ 운송비 ₩${fmt(p.freight_est)}는 <b>${esc(companyCfg.name)}</b>가 운송업체에 직접 지급합니다.</p>` : ""}
      ${p.memo ? `<p class="po-note">※ ${esc(p.memo)}</p>` : ""}

      <div class="po-sign">
        <div class="po-sign-box">
          <div class="po-sign-h">기안</div>
          <div class="po-sign-name">${esc(userName(p.drafter_id))}</div>
          <div class="po-sign-date">${esc(p.date)}</div>
        </div>
        <div class="po-sign-box">
          <div class="po-sign-h">승인</div>
          <div class="po-sign-name">${apprStep ? esc(userName(apprStep.userId))
            : (p.approval_line || []).length === 0 && approved ? esc(userName(p.drafter_id)) + " (전결)" : "—"}</div>
          <div class="po-sign-date">${apprStep ? esc(String(apprStep.date).slice(0, 10)) : approved ? esc(p.date) : ""}</div>
        </div>
      </div>

      <div class="po-foot">
        ${esc(companyCfg.name)}${companyCfg.addr ? " · " + esc(companyCfg.addr) : ""}
        ${companyCfg.phone ? " · " + esc(companyCfg.phone) : ""}
      </div>
    </div>`;
}

/* 메일에 붙여넣을 발주서 HTML.
   메일 클라이언트는 <style>을 지우므로 모든 서식을 인라인으로 넣어야 표가 유지된다. */
// 발주서 합계 — 품목별 과세/면세를 반영한 공급가액·부가세 (면세 품목엔 부가세를 매기지 않는다)
function poVatOf(items) {
  const prodOf = pid => erpProducts.find(x => x.id === pid);
  const net = items.reduce((s, it) => s + buyNet(it.amount, prodOf(it.product_id)), 0);
  const vat = items.reduce((s, it) => s + buyVat(it.amount, prodOf(it.product_id)), 0);
  return { net, vat };
}

function poEmailHtml(id) {
  const p = poCache.find(x => x.id === id);
  const items = poItemCache[id] || [];
  const sup = erpSupplierList.find(s => s.name === p.supplier) || {};
  const { net, vat } = poVatOf(items);
  const apprStep = (p.approval_line || []).find(s => s.status === "approved");
  const approver = apprStep ? userName(apprStep.userId)
    : (p.approval_line || []).length === 0 ? userName(p.drafter_id) + " (전결)" : "—";

  const B = "1px solid #e3e7ef";
  const th = `background:#eef0f4;font-size:12px;font-weight:700;padding:9px 10px;border-bottom:${B}`;
  const td = `font-size:13px;padding:9px 12px;border-bottom:${B}`;
  const pth = `width:74px;color:#6b7487;font-size:11.5px;padding:6px 12px;border-bottom:${B}`;
  const ptd = `font-size:12.5px;padding:6px 12px;border-bottom:${B}`;
  // 메일에서는 div 대신 표 행으로 — 일부 메일앱이 div 여백을 무시해 줄이 붙어버림
  const party = (title, rows) => `
    <td width="49%" valign="top" style="border:${B};border-radius:8px">
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse">
        <tr><td colspan="2" style="background:#eef3fe;color:#2b5df0;font-weight:800;font-size:12px;padding:8px 12px">${title}</td></tr>
        ${rows.map(([k, v]) => `<tr><td style="${pth}">${k}</td><td style="${ptd}">${esc(v) || "—"}</td></tr>`).join("")}
      </table></td>`;
  const signBox = (label, name, date) => `
    <td style="width:118px;border:${B};border-radius:6px">
      <table cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr><td style="background:#eef0f4;font-size:11px;font-weight:700;color:#6b7487;padding:5px;text-align:center">${label}</td></tr>
        <tr><td style="font-size:14px;font-weight:800;padding:14px 4px 4px;text-align:center">${esc(name)}</td></tr>
        <tr><td style="font-size:11px;color:#6b7487;padding-bottom:10px;text-align:center">${esc(date)}</td></tr>
      </table></td>`;
  const greet = `${sup.manager ? esc(sup.manager) + " 님, " : ""}안녕하세요. ${esc(companyCfg.name)}입니다.`;

  return `<div style="font-family:'Malgun Gothic','Apple SD Gothic Neo',sans-serif;color:#1c2333">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:660px;background:#ffffff">
<tr><td style="font-size:13.5px;line-height:1.75;padding-bottom:22px">
  ${greet}<br>아래와 같이 발주드리오니 확인 후 납품 부탁드립니다.
</td></tr>
<tr><td>
<table cellpadding="0" cellspacing="0" border="0" width="100%">
  <tr><td style="text-align:center;font-size:28px;font-weight:900;letter-spacing:12px;padding-bottom:3px">발 주 서</td></tr>
  <tr><td style="text-align:center;font-size:11px;color:#6b7487;letter-spacing:3px">PURCHASE ORDER</td></tr></table>

<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:24px;border-top:2px solid #1c2333;border-collapse:collapse">
  <tr><td style="width:92px;${th}">발주번호</td><td style="${td}"><b>${esc(p.po_no)}</b></td>
      <td style="width:92px;${th}">발주일</td><td style="${td}">${esc(p.date)}</td></tr>
  <tr><td style="${th}">납품희망일</td><td style="${td}">${p.due_date ? esc(p.due_date) : "협의"}</td>
      <td style="${th}">입고처</td><td style="${td}">${p.deliver_to === "쿠팡" ? "쿠팡 물류센터 (로켓그로스)" : "자사창고"}</td></tr>
</table>

<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:18px"><tr>
${party("공급자 (받는 분)", [["상호", p.supplier], ["사업자번호", sup.biz_no], ["대표자", sup.ceo], ["담당자", sup.manager], ["연락처", sup.phone]])}
<td width="2%"></td>
${party("발주자 (보내는 분)", [["상호", companyCfg.name], ["사업자번호", companyCfg.biz_no], ["대표자", companyCfg.ceo], ["주소", companyCfg.addr], ["연락처", companyCfg.phone]])}
</tr></table>

<table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
  <td style="font-size:13.5px;padding:22px 0 10px">아래와 같이 발주하오니 확인 후 납품하여 주시기 바랍니다.</td></tr></table>

<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;border-top:2px solid #1c2333">
<thead><tr>
  <th style="width:36px;${th}">No</th>
  <th style="${th};text-align:left">품목</th>
  <th style="width:70px;${th};text-align:right">수량</th>
  <th style="width:90px;${th};text-align:right">단가</th>
  <th style="width:110px;${th};text-align:right">공급가액</th>
</tr></thead>
<tbody>${items.map((it, i) => `<tr>
  <td style="${td};text-align:center">${i + 1}</td>
  <td style="${td}"><b>${esc(prodName(it.product_id))}</b>${isTaxable(erpProducts.find(x => x.id === it.product_id)) ? "" : " (면세)"}</td>
  <td style="${td};text-align:right">${fmt(it.qty)}</td>
  <td style="${td};text-align:right">${fmt(it.unit_cost)}</td>
  <td style="${td};text-align:right">${fmt(it.amount)}</td>
</tr>`).join("")}</tbody>
<tfoot>
  <tr><td colspan="4" style="background:#fafbfd;font-size:12.5px;padding:9px 12px;text-align:right;border-bottom:${B}">공급가액</td>
      <td style="background:#fafbfd;font-size:12.5px;padding:9px 10px;text-align:right;border-bottom:${B}">${fmt(net)}</td></tr>
  ${vatCfg.enabled ? `<tr><td colspan="4" style="background:#fafbfd;font-size:12.5px;padding:9px 12px;text-align:right;border-bottom:${B}">부가세 (10%)</td>
      <td style="background:#fafbfd;font-size:12.5px;padding:9px 10px;text-align:right;border-bottom:${B}">${fmt(vat)}</td></tr>` : ""}
  <tr><td colspan="4" style="background:#eef3fe;font-size:14.5px;font-weight:800;padding:11px 12px;text-align:right">합계 금액</td>
      <td style="background:#eef3fe;font-size:14.5px;font-weight:800;padding:11px 10px;text-align:right">₩${fmt(net + vat)}</td></tr>
</tfoot>
</table>

${p.freight_est || p.memo ? `<table cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td style="font-size:12.5px;color:#6b7487;padding-top:12px;line-height:1.7">
${p.freight_est ? `※ 운송비 ₩${fmt(p.freight_est)}는 <b>${esc(companyCfg.name)}</b>가 운송업체에 직접 지급합니다.` : ""}
${p.freight_est && p.memo ? "<br>" : ""}${p.memo ? `※ ${esc(p.memo)}` : ""}
</td></tr></table>` : ""}

<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="padding-top:26px"><tr><td align="right">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
    ${signBox("기안", userName(p.drafter_id), p.date)}<td style="width:10px"></td>${signBox("승인", approver, apprStep ? String(apprStep.date).slice(0, 10) : p.date)}
  </tr></table>
</td></tr></table>

<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:32px"><tr>
  <td style="text-align:center;font-size:11px;color:#6b7487;padding-top:14px;border-top:${B}">
    ${esc(companyCfg.name)}${companyCfg.addr ? " · " + esc(companyCfg.addr) : ""}${companyCfg.phone ? " · " + esc(companyCfg.phone) : ""}
  </td></tr></table>
</td></tr></table></div>`;
}

/* 표 서식을 유지한 채 클립보드에 복사 → 메일 작성창에 붙여넣으면 발주서 표가 그대로 들어간다 */
async function copyPOHtml(id) {
  const html = poEmailHtml(id);
  const plain = poPlainText(id);
  try {
    await navigator.clipboard.write([new ClipboardItem({
      "text/html": new Blob([html], { type: "text/html" }),
      "text/plain": new Blob([plain], { type: "text/plain" }),
    })]);
    return true;
  } catch (e) {
    // ClipboardItem 미지원 브라우저 — 화면에서 직접 선택 복사하도록 안내
    try {
      const holder = document.createElement("div");
      holder.innerHTML = html;
      holder.style.cssText = "position:fixed;left:-9999px;top:0";
      document.body.appendChild(holder);
      const range = document.createRange(); range.selectNodeContents(holder);
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      const ok = document.execCommand("copy");
      sel.removeAllRanges(); document.body.removeChild(holder);
      return ok;
    } catch (e2) { return false; }
  }
}

// 발주서를 메일로: 표 서식을 복사한 뒤 메일 작성창을 연다
async function mailPOHtml(id) {
  const p = poCache.find(x => x.id === id);
  const sup = erpSupplierList.find(s => s.name === p.supplier) || {};
  const ok = await copyPOHtml(id);
  if (!ok) return toast("복사에 실패했습니다 — 발주서 화면을 직접 드래그해 복사해 주세요");
  const subject = `[발주서] ${p.po_no} · ${companyCfg.name}`;
  const gmail = `https://mail.google.com/mail/?view=cm&fs=1`
    + `&to=${encodeURIComponent(sup.email || "")}&su=${encodeURIComponent(subject)}`;
  alert(
    "발주서를 복사했습니다.\n\n"
    + "메일 작성창이 열리면 본문에서 붙여넣기(Ctrl+V)를 누르세요.\n"
    + "표가 그대로 들어갑니다.\n\n"
    + (sup.email ? `받는사람: ${sup.email}` : "※ 거래처 이메일이 등록되지 않아 직접 입력하셔야 합니다."));
  window.open(gmail, "_blank", "noopener");
}

// 메일 본문(텍스트) — HTML을 못 쓰는 환경용
function poPlainText(id) {
  const p = poCache.find(x => x.id === id);
  const sup = erpSupplierList.find(s => s.name === p.supplier) || {};
  const items = poItemCache[id] || [];
  const { net, vat } = poVatOf(items);
  return [
    `${sup.manager ? sup.manager + " 님, " : ""}안녕하세요. ${companyCfg.name}입니다.`,
    `아래와 같이 발주드리오니 확인 후 납품 부탁드립니다.`,
    "",
    `■ 발주번호: ${p.po_no}`,
    `■ 발주일: ${p.date}`,
    `■ 납품희망일: ${p.due_date || "협의"}`,
    `■ 입고처: ${p.deliver_to === "쿠팡" ? "쿠팡 물류센터 (로켓그로스)" : companyCfg.name + " 자사창고"}`,
    "",
    "■ 품목",
    ...items.map((it, i) => `${i + 1}. ${prodName(it.product_id)}${isTaxable(erpProducts.find(x => x.id === it.product_id)) ? "" : " (면세)"} / ${fmt(it.qty)}개 / 단가 ${fmt(it.unit_cost)}원 / ${fmt(it.amount)}원`),
    "",
    `공급가액: ${fmt(net)}원`,
    ...(vatCfg.enabled ? [`부가세: ${fmt(vat)}원`] : []),
    `합계: ${fmt(net + vat)}원`,
    ...(p.freight_est ? ["", `※ 운송비 ${fmt(p.freight_est)}원은 당사가 운송업체에 직접 지급합니다.`] : []),
    ...(p.memo ? [`※ ${p.memo}`] : []),
    "",
    "확인 부탁드립니다. 감사합니다.",
    "",
    `${companyCfg.name}`,
    ...(companyCfg.ceo ? [`대표 ${companyCfg.ceo}`] : []),
    ...(companyCfg.phone ? [companyCfg.phone] : []),
    ...(companyCfg.addr ? [companyCfg.addr] : []),
  ].join("\n");
}

// 메일 앱(휴대폰 등)으로 텍스트 발주서 보내기 — 표가 필요 없을 때
function mailPO(id) {
  const p = poCache.find(x => x.id === id);
  const sup = erpSupplierList.find(s => s.name === p.supplier) || {};
  const url = `mailto:${encodeURIComponent(sup.email || "")}`
    + `?subject=${encodeURIComponent(`[발주서] ${p.po_no} · ${companyCfg.name}`)}`
    + `&body=${encodeURIComponent(poPlainText(id))}`;
  location.href = url;
  toast("메일 앱을 열었습니다 — 내용 확인 후 보내세요");
}

// 거래처에 그대로 붙여넣어 보낼 수 있는 텍스트
function copyPOText(id) {
  const p = poCache.find(x => x.id === id);
  const items = poItemCache[id] || [];
  const txt = [
    `[발주서] ${p.po_no}`,
    `발주일: ${p.date}`,
    `거래처: ${p.supplier}`,
    `입고처: ${p.deliver_to === "쿠팡" ? "쿠팡 물류센터 (로켓그로스)" : "주식회사 리버스 자사창고"}`,
    "",
    ...items.map(it => `- ${prodName(it.product_id)} / ${fmt(it.qty)}개 / 단가 ${fmt(it.unit_cost)}원 / ${fmt(it.amount)}원`),
    "",
    `합계: ${fmt(p.total)}원 (부가세 ${vatCfg.purchaseCostIncludesVat ? "포함" : "별도"})`,
    p.memo ? `메모: ${p.memo}` : "",
    "",
    "주식회사 리버스",
  ].filter(x => x !== "").join("\n");
  copyText(txt);
}

async function decidePO(id, decision) {
  const { data: fresh } = await sb.from("purchase_orders").select("*").eq("id", id).maybeSingle();
  if (!fresh || fresh.status !== "progress") { toast("이미 처리된 발주서입니다"); closeModal(); return route(); }
  const line = [...(fresh.approval_line || [])];
  const step = line[fresh.current_step];
  if (!step || step.userId !== me.id) { toast("결재 차례가 아닙니다"); closeModal(); return route(); }
  step.status = decision; step.date = nowStr();
  const last = fresh.current_step >= line.length - 1;
  const patch = decision === "rejected"
    ? { approval_line: line, status: "rejected" }
    : { approval_line: line, status: last ? "approved" : "progress", current_step: last ? fresh.current_step : fresh.current_step + 1 };
  const { data, error } = await sb.from("purchase_orders").update(patch)
    .eq("id", id).eq("current_step", fresh.current_step).select("id");
  if (error || !data?.length) return toast("처리에 실패했습니다");
  toast(decision === "approved" ? "승인되었습니다" : "반려되었습니다");
  closeModal();
  route();
}

// 승인된 발주서를 실제로 거래처에 보냈을 때 → 결제 예정도 함께 등록
async function markOrdered(id) {
  const p = poCache.find(x => x.id === id);
  const sup = erpSupplierList.find(s => s.name === p.supplier);
  const { data, error } = await sb.from("purchase_orders")
    .update({ status: "ordered", ordered_at: new Date().toISOString() }).eq("id", id).select("id");
  if (error || !data?.length) return toast("처리에 실패했습니다");

  // 결제조건이 있으면 '나갈 돈'으로 미리 잡아둔다
  const total = Number(p.total) + Number(p.freight_est || 0);
  if (total > 0 && confirm(
    `발주 완료로 처리했습니다.\n\n대금 ₩${fmt(total)}${p.freight_est ? " (운송비 포함)" : ""}을(를)\n`
    + `자금일보의 '나갈 돈'에 미리 등록할까요?${sup?.pay_terms ? `\n(${p.supplier} 결제조건: ${sup.pay_terms})` : ""}`)) {
    const due = addDaysStr(today(), 30);
    await sb.from("cash_plans").insert({
      date: due, kind: "출금", title: `${p.supplier} 발주대금 (${p.po_no})`,
      amount: total, repeat: "없음", created_by: me.name });
    toast("자금일보 '나갈 돈'에 등록했습니다 (날짜는 자금일보에서 조정하세요)");
  } else {
    toast("발주 완료로 처리했습니다");
  }
  closeModal();
  route();
}

async function cancelPO(id) {
  if (!confirm("이 발주서를 취소할까요?\n(이미 입고된 매입 기록은 남습니다)")) return;
  const { data, error } = await sb.from("purchase_orders").update({ status: "canceled" }).eq("id", id).select("id");
  if (error || !data?.length) return toast("처리에 실패했습니다");
  toast("취소되었습니다");
  closeModal();
  route();
}

/* 입고 처리 — 실제로 들어온 수량만 매입으로 만든다 (부분 입고 지원) */
function openReceiveModal(id) {
  const p = poCache.find(x => x.id === id);
  const items = (poItemCache[id] || []).filter(it => it.qty - it.received_qty > 0);
  if (!items.length) return toast("입고할 수량이 없습니다");
  document.getElementById("modal-root").innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal" style="max-width:760px;width:96vw">
        <h3>🚚 입고 처리 — ${esc(p.po_no)}</h3>
        <p style="font-size:13px;color:var(--text-sub);margin:4px 0 12px">
          실제 들어온 수량만 입력하세요 — 그만큼 재고가 늘어납니다.<br>
          입고처: <b>${p.deliver_to === "쿠팡" ? "쿠팡 (로켓그로스)" : "자사창고"}</b> · 거래처: <b>${esc(p.supplier)}</b></p>
        <div class="form-grid">
          <div class="field"><label>입고일 *</label><input id="rc-date" type="date" value="${today()}"></div>
          <div class="field"><label>실제 운송비(원) ${vatTag("exp")}</label>
            <input id="rc-freight" type="text" inputmode="numeric" class="comma" value="${cfv(p.freight_est || "")}"></div>
        </div>
        <div class="table-wrap" style="margin-top:8px"><table>
          <thead><tr><th>품목</th><th class="num">발주</th><th class="num">기입고</th><th class="num">미입고</th><th style="width:110px" class="num">이번 입고</th></tr></thead>
          <tbody>${items.map(it => `
            <tr data-item="${it.id}" data-pid="${it.product_id}" data-cost="${it.unit_cost}" data-remain="${it.qty - it.received_qty}">
              <td><b>${esc(prodName(it.product_id))}</b></td>
              <td class="num">${fmt(it.qty)}</td>
              <td class="num">${fmt(it.received_qty)}</td>
              <td class="num">${fmt(it.qty - it.received_qty)}</td>
              <td><input class="rc-qty" type="number" min="0" max="${it.qty - it.received_qty}" value="${it.qty - it.received_qty}"></td>
            </tr>`).join("")}
          </tbody>
        </table></div>
        <div class="modal-actions">
          <button class="btn secondary" onclick="closeModal()">취소</button>
          <button class="btn" id="btn-rc-save" onclick="saveReceive('${id}')">입고 확정</button>
        </div>
      </div>
    </div>`;
}

async function saveReceive(id) {
  const p = poCache.find(x => x.id === id);
  const date = document.getElementById("rc-date").value;
  if (!date) return toast("입고일을 선택해 주세요");
  if (date > today()) return toast("입고일은 오늘보다 뒤일 수 없습니다");
  const freight = numOf(document.getElementById("rc-freight").value) || 0;
  const rows = [...document.querySelectorAll("#modal-root tr[data-item]")];
  const recs = [], updates = [];
  for (const tr of rows) {
    const qty = numOf(tr.querySelector(".rc-qty").value) || 0;
    const remain = Number(tr.dataset.remain);
    if (qty <= 0) continue;
    if (qty > remain) return toast(`'${prodName(tr.dataset.pid)}'는 미입고 ${fmt(remain)}개보다 많이 입력할 수 없습니다`);
    const cost = Number(tr.dataset.cost);
    recs.push({ date, supplier: p.supplier, product_id: tr.dataset.pid, qty,
      unit_cost: cost, amount: qty * cost, warehouse: p.deliver_to, po_id: p.id,
      memo: p.po_no, created_by: me.name });
    updates.push({ id: tr.dataset.item, add: qty });
  }
  if (!recs.length) return toast("입고 수량을 입력해 주세요");
  const btn = document.getElementById("btn-rc-save");
  btn.disabled = true;

  // 운송비를 먼저 (실패 시 매입이 중복되지 않도록)
  if (freight > 0) {
    const { error: ef } = await sb.from("purchase_costs").insert({
      date, kind: "운송비", amount: freight, supplier: p.supplier, created_by: me.name });
    if (ef) { btn.disabled = false; return toast("운송비 저장에 실패했습니다 (매입은 아직 기록되지 않았습니다)"); }
  }
  const { error } = await sb.from("purchases").insert(recs);
  if (error) { btn.disabled = false; return toast("매입 기록에 실패했습니다"); }

  // 입고 수량 반영
  for (const u of updates) {
    const it = (poItemCache[id] || []).find(x => x.id === u.id);
    await sb.from("purchase_order_items").update({ received_qty: Number(it.received_qty) + u.add }).eq("id", u.id);
  }
  // 전량 입고면 완료
  const after = (poItemCache[id] || []).map(it => {
    const u = updates.find(x => x.id === it.id);
    return Number(it.received_qty) + (u ? u.add : 0) >= Number(it.qty);
  });
  await sb.from("purchase_orders").update({ status: after.every(Boolean) ? "done" : "partial" }).eq("id", id);

  toast(`입고 ${recs.length}건이 매입으로 기록되었습니다 (${p.deliver_to})`);
  closeModal();
  route();
}

/* ==================== 쿠팡 로켓그로스 입고관리 (READ-only, 2026-09-02) ====================
   쿠팡 WING 로켓그로스로의 전자 입고신청(PRE-FLIGHT → 승인 → 제출) 진행 상태를 보여줘요.
   inbound_plans/inbound_plan_items는 위 발주서/입고 처리(openReceiveModal, 실물 입고 수량을
   직접 세서 입력하는 기능)와는 완전히 별개의 테이블·흐름이에요 - 서로 겹치지 않습니다.
   이번 라운드는 조회 전용이라 sb.from(...).select(...)만 쓰고, insert/update/upsert/delete는
   이 섹션 어디에도 없습니다. */
const RG_PREFLIGHT_CHIP = {
  NOT_RUN: ["waiting", "미실행"], RUNNING: ["progress", "실행중"],
  PASSED: ["approved", "통과"], FAILED: ["rejected", "실패"],
};
const RG_APPROVAL_CHIP = {
  PENDING_APPROVAL: ["progress", "승인대기"], APPROVED: ["approved", "승인됨"], REJECTED: ["rejected", "거절됨"],
};
const rgChip = (map, val) => {
  const [cls, label] = map[val] || ["waiting", val || "-"];
  return `<span class="chip ${cls}">${label}</span>`;
};

// submit_status만으로는 "제출됨"이 성공인지 실패인지 구분이 안 돼서(2026-09-02
// 실제 첫 submit이 WING 슬롯 거부로 실패했는데도 UI는 "제출됨"만 보여준 문제),
// submit_status(NOT_SUBMITTED/SUBMIT_ATTEMPTED, 한 번 ATTEMPTED되면 영구 고정)와
// internal_status(SUCCEEDED/FAILED/RECOVERY_NEEDED 등)를 함께 봐서 실제 결과를
// 구분해요. submit_status가 SUBMIT_ATTEMPTED인데 internal_status가 아직
// SUCCEEDED/FAILED 둘 다 아니면(SUBMITTING/PROCESSING/RECOVERY_NEEDED/UNKNOWN 등)
// 결과가 아직 애매한 상태라 "결과확인필요"로 묶어요.
function rgSubmitChipInfo(p) {
  if (p.submit_status !== "SUBMIT_ATTEMPTED") return ["waiting", "미제출"];
  if (p.internal_status === "SUCCEEDED") return ["approved", "제출완료"];
  if (p.internal_status === "FAILED") return ["rejected", "제출실패"];
  return ["progress", "결과확인필요"];
}

// 재시도 가능한(=새 슬롯으로 다시 시도하면 될 수 있는) 실패인지 판정. 지금은
// 2026-09-02 실전 실패("No available truck slot")로 확인된 패턴만 알아요 -
// 새로운 실패 유형이 나오면 여기 목록만 늘리면 돼요. 알 수 없는 실패는 보수적으로
// retryable=false로 둬서(재고 이상, 권한 문제 등 슬롯과 무관한 실패까지 "새
// 슬롯으로 재시도"라고 잘못 안내하지 않도록) 담당자 확인을 유도해요.
const RG_RETRYABLE_ERROR_PATTERNS = [
  { test: /no available truck slot/i, label: "슬롯 없음" },
];
function rgErrorClassify(p) {
  const msg = p.last_error_message || "";
  const hit = RG_RETRYABLE_ERROR_PATTERNS.find(r => r.test.test(msg));
  return hit ? { retryable: true, label: hit.label } : { retryable: false, label: null };
}

function rgSubmitStatusHtml(p) {
  const [cls, label] = rgSubmitChipInfo(p);
  let html = `<span class="chip ${cls}">${label}</span>`;
  if (p.internal_status === "FAILED" && p.last_error_message) {
    const { retryable, label: errLabel } = rgErrorClassify(p);
    const prefix = retryable ? `${esc(errLabel)} · ` : "";
    html += `<br><small style="color:var(--red)">${prefix}${esc(p.last_error_message)}</small>`;
    if (retryable) {
      html += `<br><small style="color:var(--text-sub)">🔄 새 슬롯으로 재시도 필요</small>`;
    }
  }
  return html;
}

// 승인/거절이 가능한 조건 - decideRgInbound()의 CAS .eq() 조건과 반드시 동일하게 유지
const rgCanDecide = p => p.preflight_status === "PASSED" && p.approval_status === "PENDING_APPROVAL" && p.submit_status === "NOT_SUBMITTED";
const rgCanSubmit = p => p.approval_status === "APPROVED" && p.submit_status === "NOT_SUBMITTED";
// retry_of_plan_id로 이 plan을 가리키는 다른 plan이 있으면(=이미 새 슬롯으로
// 재시도가 진행 중/완료됨) 이 plan은 대체(superseded)된 거예요 - 서버 gate
// (erp_submit_gate.submit_gate_check()의 superseded_ids 로직)와 정확히 같은
// 의미로, 여기서도 "쿠팡 제출" 버튼을 절대 보여주지 않아요. supersededIds는
// viewRgInbound()가 이미 불러온 전체 plans에서 한 번만 계산해서 넘겨줘요(추가
// 쿼리 없음).
const rgIsSuperseded = (p, supersededIds) => supersededIds.has(p.id);
// SUBMIT_ATTEMPTED + FAILED + retryable 패턴 매치 - 이 plan 자체는 CAS 트리거로
// 영구 고정돼서 재사용 불가능하니, "재시도 준비"는 새 슬롯을 골라 별도의 새
// plan을 만드는 절차로 이어져요(이 plan 자체는 절대 안 건드림). 이미 이 plan의
// retry가 만들어졌으면(supersededIds에 있음) 중복으로 또 만들 필요가 없어서
// 버튼을 더 이상 보여주지 않아요(서버의 _already_has_retry() 중복 차단과 동일 의미).
const rgCanPrepareRetry = (p, supersededIds) =>
  p.submit_status === "SUBMIT_ATTEMPTED" && p.internal_status === "FAILED" &&
  rgErrorClassify(p).retryable && !supersededIds.has(p.id);

// PARCEL(BOX) 전용 - 2026-09-04 추가. TRUCK 조건(rgCanDecide/rgCanSubmit/
// rgCanPrepareRetry)은 위에서 이미 다 걸러지므로, 여기 두 조건은 transport_
// type==='PARCEL'인 plan에서만 의미가 있어요(TRUCK plan은 automation_state
// 자체를 안 씀 - null이라 아래 두 조건에 절대 안 걸림).
const rgCanEnterParcelBoxes = p => p.transport_type === "PARCEL" && p.automation_state === "STEP1_DONE";
const rgCanSelectParcelFc = p => p.transport_type === "PARCEL" && p.automation_state === "FC_MAPPING_DONE";
// PDF 저장 - SHIPMENT_CONFIRMED(=실제 WING 제출이 끝나 shipmentId가 확정된
// 뒤)에만 버튼을 보여줌(2026-09-04 추가). PDF_ATTACHED/ERP_SUCCESS로 넘어가면
// 이 조건에 더 이상 안 걸려서 버튼이 자동으로 사라짐(중복 클릭 방지는 서버
// attach_parcel_pdf()가 이미 함 - 여기는 화면 표시 조건만).
const rgCanAttachParcelPdf = p => p.transport_type === "PARCEL" && p.automation_state === "SHIPMENT_CONFIRMED";

function rgActionsHtml(p, supersededIds) {
  if (rgCanDecide(p)) {
    return `<button class="btn sm green" onclick="decideRgInbound('${p.id}','APPROVED')">승인</button>
            <button class="btn sm danger" onclick="decideRgInbound('${p.id}','REJECTED')">거절</button>`;
  }
  if (rgCanSubmit(p) && !rgIsSuperseded(p, supersededIds)) {
    return `<button class="btn sm" onclick="submitRgInbound('${p.id}')">쿠팡 제출</button>`;
  }
  if (rgCanPrepareRetry(p, supersededIds)) {
    return `<button class="btn sm secondary" onclick="openRgRetryModal('${p.id}')">🔄 재시도 준비</button>`;
  }
  if (rgCanEnterParcelBoxes(p)) {
    return `<button class="btn sm" onclick="openParcelBoxConfigModal('${p.id}')">📦 박스 송장번호 입력</button>`;
  }
  if (rgCanSelectParcelFc(p)) {
    return `<button class="btn sm" onclick="openParcelFcSelectModal('${p.id}')">🏢 입고센터·입고일 선택</button>`;
  }
  if (rgCanAttachParcelPdf(p)) {
    return `<button class="btn sm" onclick="attachParcelPdf('${p.id}')">📄 PDF 저장</button>`;
  }
  return "";
}

// WING 실제 제출 - decideRgInbound()와 동일한 원칙(더블클릭 방지 + 클릭 직전
// fresh 재확인)에 실제 백엔드 호출 하나만 더해요. 버튼은 rgCanSubmit(승인된
// plan)일 때만 렌더되지만, 그 사이 다른 사람이 먼저 처리했을 수 있어서 여기서
// 한 번 더 확인해요 - 최종 권한/상태 검증은 어차피 GCP 서버(JWT+profiles.
// can_submit_wing_inbound+DB gate)가 다시 하므로, 이건 UX용 빠른 확인이에요.
async function submitRgInbound(planId) {
  if (!confirm("쿠팡(WING)에 실제로 입고신청을 제출합니다.\n제출 후에는 취소할 수 없습니다. 계속할까요?")) return;

  const row = event?.target?.closest("tr");
  const rowBtns = row ? row.querySelectorAll("button") : [];
  rowBtns.forEach(b => b.disabled = true);

  const { data: fresh, error: e0 } = await sb.from("inbound_plans").select("*").eq("id", planId).maybeSingle();
  if (e0 || !fresh || !rgCanSubmit(fresh)) {
    toast("이미 처리됐거나 제출 가능한 상태가 아닙니다");
    return route();
  }
  // 렌더 시점 이후 다른 사람이 먼저 이 plan의 retry plan을 만들었을 수도 있어서
  // (rgIsSuperseded 판정과 동일 의미) 클릭 시점에 한 번 더 확인해요 - 최종 차단은
  // 어차피 서버 gate(erp_submit_gate.submit_gate_check())가 하지만, 여기서 먼저
  // 걸러야 사람이 이미 무의미해진 버튼을 눌러 API 호출까지 가지 않아요.
  const { data: supersededBy } = await sb.from("inbound_plans").select("id").eq("retry_of_plan_id", planId).limit(1);
  if (supersededBy && supersededBy.length) {
    toast("이미 새 슬롯으로 재시도 plan이 만들어져서 이 plan은 더 이상 제출할 수 없습니다");
    return route();
  }

  const { data: { session } } = await sb.auth.getSession();
  const jwt = session?.access_token;
  if (!jwt) {
    toast("로그인 세션이 만료됐습니다. 다시 로그인해주세요");
    rowBtns.forEach(b => b.disabled = false);
    return;
  }

  try {
    const resp = await fetch(`${WING_SUBMIT_API_BASE}/api/inbound-plans/${planId}/submit`, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}` },
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      toast(`제출 실패: ${body.detail || resp.status}`);
      rowBtns.forEach(b => b.disabled = false);
      return route();
    }
    toast(body.ok ? "쿠팡 제출이 완료됐습니다" : `제출 결과 확인 필요: ${body.internal_status}`);
  } catch (e) {
    toast(`제출 요청 중 오류: ${e.message}`);
    rowBtns.forEach(b => b.disabled = false);
    return;
  }
  route();
}

// ===== 재시도 준비: 새 슬롯 조회 -> 사람이 선택 -> 새 retry plan PRE-FLIGHT =====
// "제출실패(슬롯 없음) -> 새 슬롯으로 재시도 필요 -> 재시도 준비 -> 슬롯 선택 ->
// PRE-FLIGHT 진행 -> 승인대기" 흐름의 뒷부분이에요. 실제 WING WRITE(새 draft
// 생성)는 사람이 슬롯을 고르고 "이 슬롯으로 PRE-FLIGHT 진행"을 눌러야만 실행되고,
// 그 결과는 항상 승인대기(PENDING_APPROVAL)에서 멈춰요 - 이 흐름 어디에도 실제
// 쿠팡 제출은 없습니다(그건 여전히 별도 승인 + "쿠팡 제출" 버튼 몫).
let _rgRetrySelectedSlot = null;

async function openRgRetryModal(planId) {
  const { data: { session } } = await sb.auth.getSession();
  const jwt = session?.access_token;
  if (!jwt) { toast("로그인 세션이 만료됐습니다. 다시 로그인해주세요"); return; }

  _rgRetrySelectedSlot = null;
  document.getElementById("modal-root").innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal">
        <h3>🔄 새 슬롯으로 재시도 준비</h3>
        <p style="font-size:13.5px;color:var(--text-sub);margin:4px 0 12px;line-height:1.7">
          이전 제출이 <b>슬롯 없음</b>으로 실패했습니다. 아래에서 실제 가용 슬롯을 확인하고 하나를 선택하면,
          그 슬롯으로 <b>새 입고신청(PRE-FLIGHT)</b>을 진행합니다. 기존 실패 plan은 그대로 남고, 새 plan은
          <b>승인 후에만</b> 실제 쿠팡 제출이 가능합니다 — 여기서 바로 쿠팡에 제출되지 않습니다.</p>
        <div id="rg-retry-slots" style="font-size:13.5px;color:var(--text-sub)">슬롯 조회 중...</div>
        <div class="modal-actions">
          <button class="btn secondary" onclick="closeModal()">취소</button>
          <button class="btn" id="rg-retry-confirm" disabled onclick="confirmRgRetry('${planId}')">이 슬롯으로 PRE-FLIGHT 진행</button>
        </div>
      </div>
    </div>`;

  try {
    const resp = await fetch(`${WING_SUBMIT_API_BASE}/api/inbound-plans/${planId}/retry-slots`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    const body = await resp.json().catch(() => ({}));
    const box = document.getElementById("rg-retry-slots");
    if (!box) return;  // 조회 도중 모달을 닫았으면(취소) 아무것도 안 함
    if (!resp.ok) {
      box.innerHTML = `<span class="chip rejected">조회 실패</span> ${esc(body.detail || String(resp.status))}`;
      return;
    }
    renderRgRetrySlots(body);
  } catch (e) {
    const box = document.getElementById("rg-retry-slots");
    if (box) box.innerHTML = `<span class="chip rejected">조회 오류</span> ${esc(e.message)}`;
  }
}

function renderRgRetrySlots(body) {
  const box = document.getElementById("rg-retry-slots");
  if (!box) return;
  const fcCode = body.own_center_fc_code;
  const slots = (body.slots_by_center || {})[fcCode] || [];
  if (!slots.length) {
    box.innerHTML = `<span class="chip waiting">가용 슬롯 없음</span> 지금은 <b>${esc(fcCode || "-")}</b> 센터에
      예약 가능한 슬롯이 없습니다(최소 2시간 이후 슬롯만 표시). 잠시 후 다시 시도해주세요.`;
    return;
  }
  box.innerHTML = `
    <div style="margin-bottom:8px"><b>${esc(fcCode || "-")}</b> 센터 · 지금부터 최소 2시간 이후 슬롯만 표시됩니다</div>
    <div style="max-height:260px;overflow-y:auto;display:flex;flex-direction:column;gap:6px">
      ${slots.map((s, i) => `
        <label style="display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--border);border-radius:8px;cursor:pointer">
          <input type="radio" name="rg-retry-slot" value="${i}" onchange="pickRgRetrySlot(${i})">
          ${esc(s.edd)} ${esc(s.booking_time.slice(0, 2))}:${esc(s.booking_time.slice(2, 4))}
        </label>`).join("")}
    </div>`;
  box.dataset.slots = JSON.stringify(slots);
}

function pickRgRetrySlot(index) {
  const box = document.getElementById("rg-retry-slots");
  const slots = JSON.parse(box?.dataset.slots || "[]");
  _rgRetrySelectedSlot = slots[index] || null;
  const btn = document.getElementById("rg-retry-confirm");
  if (btn) btn.disabled = !_rgRetrySelectedSlot;
}

async function confirmRgRetry(planId) {
  if (!_rgRetrySelectedSlot) return;
  const slot = _rgRetrySelectedSlot;
  const timeLabel = `${slot.booking_time.slice(0, 2)}:${slot.booking_time.slice(2, 4)}`;
  if (!confirm(`선택한 슬롯(${slot.edd} ${timeLabel})으로 새 입고신청(PRE-FLIGHT)을 진행합니다.\n실제 쿠팡 제출은 아니며, 승인 대기 상태로 만들어집니다. 계속할까요?`)) return;

  const btn = document.getElementById("rg-retry-confirm");
  if (btn) btn.disabled = true;

  const { data: { session } } = await sb.auth.getSession();
  const jwt = session?.access_token;
  if (!jwt) { toast("로그인 세션이 만료됐습니다. 다시 로그인해주세요"); if (btn) btn.disabled = false; return; }

  try {
    const resp = await fetch(`${WING_SUBMIT_API_BASE}/api/inbound-plans/${planId}/retry`, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({ edd: slot.edd, booking_time: slot.booking_time }),
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      toast(`재시도 준비 실패: ${body.detail || resp.status}`);
      if (btn) btn.disabled = false;
      return;
    }
    toast(body.preflight_status === "PASSED"
      ? "새 입고신청(PRE-FLIGHT)이 통과했습니다 - 승인 대기 상태로 등록됐어요"
      : `PRE-FLIGHT 결과 확인이 필요합니다: ${body.preflight_status}`);
  } catch (e) {
    toast(`재시도 요청 중 오류: ${e.message}`);
    if (btn) btn.disabled = false;
    return;
  }
  closeModal();
  route();
}

/* ==================== PARCEL(BOX) Pause①/② - 2026-09-04 추가 ====================
   TRUCK 흐름(위 승인/거절/제출/재시도)은 한 줄도 안 건드림 - 여기는 전부 새
   함수예요. wing_submit_api.py의 4개 신규 엔드포인트(GET/POST parcel-box-config,
   GET parcel-fc-candidates, POST parcel-resume)를 openRgRetryModal()과 동일한
   패턴(세션 JWT 획득 -> fetch -> 에러/성공 처리 -> closeModal()+route())으로
   호출해요. */

// Pause① - STEP2 이전에 저장된 박스 뼈대(handlingId/수량)를 보여주고, 박스별
// creation_invoice_number(값 A)를 입력받아요. 실제 출고 송장번호(actual_
// invoice_number, "값 B")와는 완전히 다른 개념이라 이 모달에서 절대 안 다뤄요
// (2차 워크플로우 - 이번 라운드 범위 밖).
async function openParcelBoxConfigModal(planId) {
  const { data: { session } } = await sb.auth.getSession();
  const jwt = session?.access_token;
  if (!jwt) { toast("로그인 세션이 만료됐습니다. 다시 로그인해주세요"); return; }

  document.getElementById("modal-root").innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal">
        <h3>📦 박스별 송장번호 입력</h3>
        <p style="font-size:13.5px;color:var(--text-sub);margin:4px 0 12px;line-height:1.7">
          WING 입고신청 생성(STEP2)에는 박스마다 <b>송장번호(creation_invoice_number)</b>가 필요합니다.
          아직 실제 택배 출고 전이라 실제 운송장번호가 없다면, 임시로 식별 가능한 값을 입력하세요 —
          실제 출고 1일 전에 공급처가 알려주는 <b>진짜 운송장번호는 별도 단계</b>에서 다시 입력합니다.</p>
        <div id="parcel-box-list" style="font-size:13.5px;color:var(--text-sub)">불러오는 중...</div>
        <div class="modal-actions">
          <button class="btn secondary" onclick="closeModal()">취소</button>
          <button class="btn" id="parcel-box-confirm" onclick="confirmParcelBoxConfig('${planId}')">STEP2 진행</button>
        </div>
      </div>
    </div>`;

  try {
    const resp = await fetch(`${WING_SUBMIT_API_BASE}/api/inbound-plans/${planId}/parcel-box-config`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    const body = await resp.json().catch(() => ({}));
    const box = document.getElementById("parcel-box-list");
    if (!box) return;  // 조회 도중 모달을 닫았으면 아무것도 안 함
    if (!resp.ok) {
      box.innerHTML = `<span class="chip rejected">조회 실패</span> ${esc(body.detail || String(resp.status))}`;
      return;
    }
    renderParcelBoxList(body);
  } catch (e) {
    const box = document.getElementById("parcel-box-list");
    if (box) box.innerHTML = `<span class="chip rejected">조회 오류</span> ${esc(e.message)}`;
  }
}

function renderParcelBoxList(body) {
  const box = document.getElementById("parcel-box-list");
  if (!box) return;
  const boxes = body.boxes || [];
  if (!boxes.length) {
    box.innerHTML = `<span class="chip rejected">박스 정보 없음</span> parcel_boxes가 비어있습니다.`;
    return;
  }
  box.innerHTML = `
    <div style="margin-bottom:8px">총 <b>${boxes.length}박스</b> - 박스마다 값을 입력하세요(전부 채워야 진행됩니다)</div>
    <div style="max-height:320px;overflow-y:auto;display:flex;flex-direction:column;gap:6px">
      ${boxes.map(b => `
        <label style="display:flex;align-items:center;gap:8px;padding:6px 10px;border:1px solid var(--border);border-radius:8px">
          <span style="min-width:64px;color:var(--text-sub)">박스 ${b.box_index + 1}</span>
          <input type="text" data-box-index="${b.box_index}" class="parcel-invoice-input"
                 value="${esc(b.creation_invoice_number || "")}" placeholder="송장번호 입력"
                 style="flex:1;padding:6px 8px;border:1px solid var(--border);border-radius:6px">
        </label>`).join("")}
    </div>`;
}

async function confirmParcelBoxConfig(planId) {
  const inputs = document.querySelectorAll(".parcel-invoice-input");
  const invoiceNumbersByIndex = {};
  let hasEmpty = false;
  inputs.forEach(el => {
    const v = el.value.trim();
    if (!v) hasEmpty = true;
    invoiceNumbersByIndex[el.dataset.boxIndex] = v;
  });
  if (!inputs.length || hasEmpty) { toast("모든 박스에 송장번호를 입력해야 합니다"); return; }
  if (!confirm(`${inputs.length}개 박스의 송장번호로 WING STEP2를 진행합니다. 계속할까요?`)) return;

  const btn = document.getElementById("parcel-box-confirm");
  if (btn) btn.disabled = true;

  const { data: { session } } = await sb.auth.getSession();
  const jwt = session?.access_token;
  if (!jwt) { toast("로그인 세션이 만료됐습니다. 다시 로그인해주세요"); if (btn) btn.disabled = false; return; }

  try {
    const resp = await fetch(`${WING_SUBMIT_API_BASE}/api/inbound-plans/${planId}/parcel-box-config`, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({ invoice_numbers_by_index: invoiceNumbersByIndex }),
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      toast(`박스 설정(STEP2) 실패: ${body.detail || resp.status}`);
      if (btn) btn.disabled = false;
      return;
    }
    toast(body.automation_state === "FC_MAPPING_DONE"
      ? "STEP2가 완료됐습니다 - 이제 입고센터·입고일을 선택해주세요"
      : `처리 결과 확인이 필요합니다: ${body.automation_state}`);
  } catch (e) {
    toast(`STEP2 요청 중 오류: ${e.message}`);
    if (btn) btn.disabled = false;
    return;
  }
  closeModal();
  route();
}

// Pause② - fc-mappings 후보를 매번 다시 조회해서 보여줘요("옵션 B" 재조회형 -
// 화면을 열 때마다 최신 후보를 가져오고, 서버(resume_and_finalize_parcel_step3)가
// 확인 시점에 다시 한번 재검증함 - 여기서 보여준 후보와 실제 확정 시점 후보가
// 다를 수 있다는 전제). 순위/추천을 이 화면이 임의로 매기지 않고 WING이 준
// fcPriority만 그대로 보여줘요.
let _parcelSelectedCandidate = null;

async function openParcelFcSelectModal(planId) {
  const { data: { session } } = await sb.auth.getSession();
  const jwt = session?.access_token;
  if (!jwt) { toast("로그인 세션이 만료됐습니다. 다시 로그인해주세요"); return; }

  _parcelSelectedCandidate = null;
  document.getElementById("modal-root").innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal">
        <h3>🏢 입고센터·입고일 선택</h3>
        <p style="font-size:13.5px;color:var(--text-sub);margin:4px 0 12px;line-height:1.7">
          WING이 알려준 후보 중에서 실제 입고를 진행할 센터와 입고예정일을 선택하세요.
          확인을 누르면 그 시점 후보를 <b>다시 한번</b> WING에서 재조회해서 선택값이 여전히
          유효한지 확인한 뒤에만 STEP3를 진행합니다(후보가 바뀌었으면 다시 선택해야 해요).</p>
        <div id="parcel-fc-candidates" style="font-size:13.5px;color:var(--text-sub)">후보 조회 중...</div>
        <div class="modal-actions">
          <button class="btn secondary" onclick="closeModal()">취소</button>
          <button class="btn" id="parcel-fc-confirm" disabled onclick="confirmParcelResume('${planId}')">이 센터·입고일로 확정</button>
        </div>
      </div>
    </div>`;

  try {
    const resp = await fetch(`${WING_SUBMIT_API_BASE}/api/inbound-plans/${planId}/parcel-fc-candidates`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    const body = await resp.json().catch(() => ({}));
    const box = document.getElementById("parcel-fc-candidates");
    if (!box) return;
    if (!resp.ok) {
      box.innerHTML = `<span class="chip rejected">조회 실패</span> ${esc(body.detail || String(resp.status))}`;
      return;
    }
    renderParcelFcCandidates(body);
  } catch (e) {
    const box = document.getElementById("parcel-fc-candidates");
    if (box) box.innerHTML = `<span class="chip rejected">조회 오류</span> ${esc(e.message)}`;
  }
}

function renderParcelFcCandidates(body) {
  const box = document.getElementById("parcel-fc-candidates");
  if (!box) return;
  const byEdd = body.candidates_by_edd || {};
  const edds = Object.keys(byEdd).sort();
  if (!edds.length) {
    box.innerHTML = `<span class="chip waiting">후보 없음</span> 지금은 선택 가능한 입고센터/입고일 후보가 없습니다.`;
    return;
  }
  let idx = 0;
  const flat = [];
  const rows = edds.map(edd => {
    const candidates = (byEdd[edd] || []).slice().sort((a, b) => (a.fc_priority ?? 999) - (b.fc_priority ?? 999));
    return `<div style="margin:6px 0 2px;font-weight:600">${esc(edd)}</div>` + candidates.map(c => {
      const i = idx++;
      flat.push({ edd, fc_code: c.fc_code });
      return `<label style="display:flex;align-items:center;gap:8px;padding:6px 10px;border:1px solid var(--border);border-radius:8px;cursor:pointer">
        <input type="radio" name="parcel-fc-candidate" value="${i}" onchange="pickParcelFcCandidate(${i})">
        ${esc(c.fc_code)}${c.cluster ? ` · ${esc(c.cluster)}` : ""}${c.fc_priority != null ? ` (우선순위 ${esc(String(c.fc_priority))})` : ""}
      </label>`;
    }).join("");
  }).join("");
  box.innerHTML = `<div style="max-height:320px;overflow-y:auto;display:flex;flex-direction:column;gap:6px">${rows}</div>`;
  box.dataset.candidates = JSON.stringify(flat);
}

function pickParcelFcCandidate(index) {
  const box = document.getElementById("parcel-fc-candidates");
  const flat = JSON.parse(box?.dataset.candidates || "[]");
  _parcelSelectedCandidate = flat[index] || null;
  const btn = document.getElementById("parcel-fc-confirm");
  if (btn) btn.disabled = !_parcelSelectedCandidate;
}

async function confirmParcelResume(planId) {
  if (!_parcelSelectedCandidate) return;
  const { edd, fc_code } = _parcelSelectedCandidate;
  if (!confirm(`${edd} · ${fc_code}로 입고를 확정합니다(STEP3). 계속할까요?`)) return;

  const btn = document.getElementById("parcel-fc-confirm");
  if (btn) btn.disabled = true;

  const { data: { session } } = await sb.auth.getSession();
  const jwt = session?.access_token;
  if (!jwt) { toast("로그인 세션이 만료됐습니다. 다시 로그인해주세요"); if (btn) btn.disabled = false; return; }

  try {
    const resp = await fetch(`${WING_SUBMIT_API_BASE}/api/inbound-plans/${planId}/parcel-resume`, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({ chosen_fc_code: fc_code, chosen_edd: edd }),
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      toast(`센터·입고일 확정 실패: ${body.detail || resp.status}`);
      if (btn) btn.disabled = false;
      return;
    }
    toast(body.preflight_status === "PASSED"
      ? "STEP3가 완료됐습니다 - 이제 승인 대기 상태입니다"
      : `처리 결과 확인이 필요합니다: ${body.automation_state}`);
  } catch (e) {
    toast(`센터·입고일 확정 요청 중 오류: ${e.message}`);
    if (btn) btn.disabled = false;
    return;
  }
  closeModal();
  route();
}

// PARCEL(BOX) Phase 1 - "PARCEL 입고 생성" 버튼/모달(2026-09-04 추가). 아직
// plan row 자체가 없는 시점의 시작점이라(승인/거절/제출/재시도/Pause①②처럼
// 기존 plan row에 붙는 액션이 아님) 카드 헤더의 독립 버튼으로 둠. 서버(POST
// /api/inbound-plans/parcel)가 check_no_active_plan_conflict()로 중복을
// 다시 한번 막아주므로, 여기 목록에서 "이미 진행 중" 표시는 사용자 편의용
// 힌트일 뿐 최종 방어선이 아님 - 그래서 서버 판단과 화면 판단이 살짝 어긋나도
// (예: 방금 다른 사람이 같은 품목으로 생성) 안전함(서버가 409로 막음).
async function openParcelCreateModal() {
  const [itemsRes, posRes, planItemsRes, plansRes] = await Promise.all([
    sb.from("purchase_order_items").select("id,po_id,product_id,qty"),
    sb.from("purchase_orders").select("id,po_no,supplier"),
    sb.from("inbound_plan_items").select("purchase_order_item_id,inbound_plan_id"),
    sb.from("inbound_plans").select("id,internal_status"),
  ]);
  const posById = {};
  (posRes.data || []).forEach(p => { posById[p.id] = p; });
  const plansById = {};
  (plansRes.data || []).forEach(p => { plansById[p.id] = p; });
  const activeItemIds = new Set(
    (planItemsRes.data || [])
      .filter(pi => !["FAILED", "CANCELLED"].includes(plansById[pi.inbound_plan_id]?.internal_status))
      .map(pi => pi.purchase_order_item_id)
  );
  const items = (itemsRes.data || []).filter(it => posById[it.po_id]);

  const options = items.map(it => {
    const po = posById[it.po_id];
    const busy = activeItemIds.has(it.id);
    return `<option value="${it.id}" data-qty="${it.qty}" ${busy ? "disabled" : ""}>
      ${esc(po.po_no)} · ${esc(prodName(it.product_id))} · 발주수량 ${fmt(it.qty)}${busy ? " (이미 입고신청 진행 중)" : ""}
    </option>`;
  }).join("");

  document.getElementById("modal-root").innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal">
        <h3>📦 PARCEL(박스/택배) 입고 생성</h3>
        <p style="font-size:13.5px;color:var(--text-sub);margin:4px 0 12px;line-height:1.7">
          쿠팡 WING에 새 PARCEL(BOX) 입고신청 초안을 만듭니다(new/v2~STEP1) - 아직 승인/제출이
          아니라 준비 단계예요. 이미 진행 중인 발주 품목은 목록에서 선택할 수 없습니다.</p>
        <label style="display:block;margin-bottom:10px">
          발주 품목
          <select id="parcel-create-po-item" style="width:100%;padding:6px 8px;border:1px solid var(--border);border-radius:6px;margin-top:4px">
            <option value="">선택하세요</option>
            ${options}
          </select>
        </label>
        <label style="display:block;margin-bottom:10px">
          입고 수량
          <input type="number" id="parcel-create-qty" min="1" step="1"
                 style="width:100%;padding:6px 8px;border:1px solid var(--border);border-radius:6px;margin-top:4px">
        </label>
        <div class="modal-actions">
          <button class="btn secondary" onclick="closeModal()">취소</button>
          <button class="btn" id="parcel-create-confirm" onclick="confirmParcelCreate()">입고 생성 시작</button>
        </div>
      </div>
    </div>`;

  const sel = document.getElementById("parcel-create-po-item");
  if (sel) sel.addEventListener("change", (e) => {
    const opt = e.target.selectedOptions[0];
    const qty = opt?.dataset.qty;
    const qtyInput = document.getElementById("parcel-create-qty");
    if (qty && qtyInput) qtyInput.value = qty;
  });
}

async function confirmParcelCreate() {
  const poItemId = document.getElementById("parcel-create-po-item")?.value;
  const qty = numOf(document.getElementById("parcel-create-qty")?.value);
  if (!poItemId) return toast("발주 품목을 선택해주세요");
  if (!qty || qty <= 0 || !Number.isInteger(qty)) return toast("입고 수량은 1 이상 정수로 입력해주세요");
  if (!confirm("새 PARCEL 입고신청을 생성합니다(WING new/v2). 계속할까요?")) return;

  const btn = document.getElementById("parcel-create-confirm");
  if (btn) btn.disabled = true;

  const { data: { session } } = await sb.auth.getSession();
  const jwt = session?.access_token;
  if (!jwt) { toast("로그인 세션이 만료됐습니다. 다시 로그인해주세요"); if (btn) btn.disabled = false; return; }

  try {
    const resp = await fetch(`${WING_SUBMIT_API_BASE}/api/inbound-plans/parcel`, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({ purchase_order_item_id: poItemId, coupang_inbound_qty: qty }),
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      toast(`PARCEL 입고 생성 실패: ${body.detail || resp.status}`);
      if (btn) btn.disabled = false;
      return;
    }
    toast(body.ok
      ? "PARCEL 입고신청이 생성됐습니다 - 다음 단계(박스 송장번호 입력)를 진행해주세요"
      : `생성은 됐지만 확인이 필요합니다: ${body.error_message || "알 수 없는 오류"}`);
  } catch (e) {
    toast(`PARCEL 입고 생성 요청 중 오류: ${e.message}`);
    if (btn) btn.disabled = false;
    return;
  }
  closeModal();
  route();
}

// PDF 저장 - automation_state=SHIPMENT_CONFIRMED 이후에만 버튼이 보임
// (rgCanAttachParcelPdf). WING PDF fetch -> Storage 업로드는 전부 서버가
// 자동화 계정 토큰으로 하고(2026-09-04 [PARCEL STORAGE OPTION B]), 여기서는
// 사람 JWT로 그 트리거만 함 - Storage/DB 자격증명은 프론트에 전혀 노출 안 됨.
async function attachParcelPdf(planId) {
  if (!confirm("이 입고신청의 WING PDF를 다운로드해서 저장합니다. 계속할까요?")) return;

  const row = event?.target?.closest("tr");
  const rowBtns = row ? row.querySelectorAll("button") : [];
  rowBtns.forEach(b => b.disabled = true);

  const { data: { session } } = await sb.auth.getSession();
  const jwt = session?.access_token;
  if (!jwt) { toast("로그인 세션이 만료됐습니다. 다시 로그인해주세요"); rowBtns.forEach(b => b.disabled = false); return; }

  try {
    const resp = await fetch(`${WING_SUBMIT_API_BASE}/api/inbound-plans/${planId}/parcel-pdf`, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}` },
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      toast(`PDF 저장 실패: ${body.detail || resp.status}`);
      rowBtns.forEach(b => b.disabled = false);
      return;
    }
    toast(body.automation_state === "PDF_ATTACHED" ? "PDF가 저장됐습니다" : `처리 결과 확인이 필요합니다: ${body.automation_state}`);
  } catch (e) {
    toast(`PDF 저장 요청 중 오류: ${e.message}`);
    rowBtns.forEach(b => b.disabled = false);
    return;
  }
  route();
}

async function viewRgInbound(preloaded) {
  const [plansRes, itemsRes] = preloaded || await Promise.all([
    sb.from("inbound_plans").select("*").order("created_at", { ascending: false }),
    sb.from("inbound_plan_items").select("*"),
  ]);
  const plans = plansRes.data || [];
  const plansById = {};
  plans.forEach(p => { plansById[p.id] = p; });
  const itemsByPlan = {};
  (itemsRes.data || []).forEach(it => { (itemsByPlan[it.inbound_plan_id] ||= []).push(it); });

  // supersededIds: retry_of_plan_id로 "가리켜진" 원본 plan id 전체(서버 gate의
  // superseded_ids와 동일 의미) - 이 plan들은 이미 새 slot으로 재시도가 진행
  // 중/완료라서 "쿠팡 제출"도 "재시도 준비"도 더 이상 안 보여줘요.
  // retryByOriginId: 반대 방향(원본 -> 그 원본의 retry plan) - 실패 행에서 화면
  // 흐름(제출실패 -> 재시도 준비 -> 슬롯 선택 -> PRE-FLIGHT 진행 -> 승인대기)이
  // 끊기지 않고 이어지는 걸 보여주려고 씀.
  const supersededIds = new Set(plans.filter(x => x.retry_of_plan_id).map(x => x.retry_of_plan_id));
  const retryByOriginId = {};
  plans.forEach(x => { if (x.retry_of_plan_id) retryByOriginId[x.retry_of_plan_id] = x; });

  const rows = [];
  plans.forEach(p => {
    const items = itemsByPlan[p.id] || [];
    if (!items.length) {
      rows.push(`<tr><td colspan="13"><b>${esc(p.supplier)}</b> — 품목 정보 없음</td></tr>`);
      return;
    }
    // retry_of_plan_id로 연결된 원본 plan이 있으면(슬롯 없음 등으로 새로 만든
    // 재시도 plan) 감사 추적용으로 화면에도 보이게 해요 - 원본 plan은 이미
    // plans 배열에 select("*")로 같이 조회돼 있어서 추가 쿼리 없이 바로 참조 가능.
    const retryOrig = p.retry_of_plan_id ? plansById[p.retry_of_plan_id] : null;
    const retryNote = p.retry_of_plan_id
      ? `<br><small style="color:var(--text-sub)">🔄 재시도 plan${retryOrig ? ` (원본 예정: ${esc(retryOrig.inbound_date || "-")} ${esc(retryOrig.inbound_time || "")})` : ""} · ${rgChip(RG_PREFLIGHT_CHIP, p.preflight_status)} → ${rgChip(RG_APPROVAL_CHIP, p.approval_status)}</small>`
      : "";
    // 이 plan이 이미 대체됐으면(자신이 다른 plan의 원본) 그 후속 plan 상태를
    // 이어서 보여줘요 - "제출실패 -> 재시도 준비 -> 슬롯 선택 -> PRE-FLIGHT 진행
    // -> 승인대기"가 화면에서 끊기지 않고 다음 단계로 자연스럽게 이어지도록.
    const forwardRetry = retryByOriginId[p.id];
    const forwardNote = forwardRetry
      ? `<br><small style="color:var(--text-sub)">→ 새 슬롯으로 재시도 plan 생성됨: ${esc(forwardRetry.inbound_date || "-")} ${esc(forwardRetry.inbound_time || "")} · ${rgChip(RG_PREFLIGHT_CHIP, forwardRetry.preflight_status)} → ${rgChip(RG_APPROVAL_CHIP, forwardRetry.approval_status)}</small>`
      : "";
    // 승인/거절/제출 버튼은 plan 단위 액션이라, 같은 plan의 품목이 여러 줄이어도 첫 줄에만 표시
    items.forEach((it, i) => rows.push(`
      <tr data-rg-plan="${esc(p.id)}">
        <td><b>${esc(it.inventory_name || "-")}</b>${it.option_name ? `<br><small style="color:var(--text-sub)">${esc(it.option_name)}</small>` : ""}${retryNote}${forwardNote}</td>
        <td>${esc(p.supplier)}</td>
        <td class="num">${it.recommended_qty != null ? fmt(it.recommended_qty) : "-"}</td>
        <td class="num"><b>${fmt(it.coupang_inbound_qty)}</b></td>
        <td class="num">${fmt(it.pallet_count)}</td>
        <td>${esc(p.destination_center_raw || "-")}</td>
        <td>${esc(p.inbound_date || "-")} ${esc(p.inbound_time || "")}</td>
        <td>${rgChip(RG_PREFLIGHT_CHIP, p.preflight_status)}</td>
        <td>${rgChip(RG_APPROVAL_CHIP, p.approval_status)}</td>
        <td>${rgSubmitStatusHtml(p)}</td>
        <td>${p.coupang_inbound_plan_id ? `<code style="font-size:12px">${esc(p.coupang_inbound_plan_id)}</code>` : "-"}</td>
        <td>${p.coupang_shipment_id ? `<code style="font-size:12px">${esc(p.coupang_shipment_id)}</code>` : "-"}</td>
        <td style="white-space:nowrap">${i === 0 ? rgActionsHtml(p, supersededIds) : ""}</td>
      </tr>`));
  });

  return `
    <div class="card">
      <div class="card-head">
        <h2>🚀 쿠팡 로켓그로스 입고관리</h2>
        <button class="btn sm" onclick="openParcelCreateModal()">＋ PARCEL 입고 생성</button>
      </div>
      <p style="font-size:13px;color:var(--text-sub)">
        쿠팡 WING 로켓그로스 자동 입고신청(PRE-FLIGHT) 진행 상태예요. 위 <b>발주서 → 입고 처리</b>(자사창고에
        실제로 도착한 수량을 직접 세어 입력하는 기능)와는 별개의 흐름입니다 — 여기는 쿠팡 시스템에 전자적으로
        입고를 신청·승인·제출하는 상태만 보여줘요. 승인/거절만 여기서 처리하고, 실제 쿠팡 제출은 아직 연결 전입니다.</p>
    </div>
    <div class="card">
      <h2>입고신청 내역 (${plans.length}건)</h2>
      <div class="table-wrap"><table>
        <thead><tr>
          <th>상품</th><th>공급처</th><th class="num">추천수량</th><th class="num">최종 입고수량</th>
          <th class="num">WING 실행 PLT</th><th>쿠팡센터</th><th>입고 예정일/시간</th>
          <th>PRE-FLIGHT</th><th>승인</th><th>WING 제출</th><th>WING inboundPlanId</th><th>shipmentId</th><th></th>
        </tr></thead>
        <tbody>${rows.length ? rows.join("") : `<tr><td colspan="13" class="empty">입고신청 내역이 없습니다</td></tr>`}</tbody>
      </table></div>
    </div>`;
}

/* 승인/거절 - 발주서 결재(decidePO)와 동일한 CAS 패턴: 최신 상태를 다시 읽어 조건을
   재확인하고, UPDATE 자체에도 .eq()로 같은 조건을 걸어서 두 사람이 동시에 눌러도
   정확히 한쪽만 성공하게 만들어요. WING은 이 함수 어디에서도 호출하지 않습니다. */
async function decideRgInbound(planId, decision) {
  const row = event?.target?.closest("tr");
  const rowBtns = row ? row.querySelectorAll("button") : [];
  rowBtns.forEach(b => b.disabled = true);  // 요청 중 더블클릭 방지

  const { data: fresh, error: e0 } = await sb.from("inbound_plans").select("*").eq("id", planId).maybeSingle();
  if (e0 || !fresh || !rgCanDecide(fresh)) {
    toast("이미 처리됐거나 조건이 맞지 않는 입고신청입니다");
    return route();
  }

  const { data, error } = await sb.from("inbound_plans")
    .update({ approval_status: decision })
    .eq("id", planId).eq("preflight_status", "PASSED")
    .eq("approval_status", "PENDING_APPROVAL").eq("submit_status", "NOT_SUBMITTED")
    .select("id");
  if (error || !data?.length) {
    toast("처리에 실패했습니다");
    rowBtns.forEach(b => b.disabled = false);
    return route();
  }

  await sb.from("inbound_plan_events").insert({
    inbound_plan_id: planId,
    event_type: decision === "REJECTED" ? "HUMAN_REJECTED" : "HUMAN_APPROVED",
    detail: { decided_by: me.name, decided_at: nowStr() },
  });

  toast(decision === "APPROVED" ? "입고신청을 승인했습니다" : "입고신청을 거절했습니다");
  route();
}

/* ---------- 매입 거래처 ---------- */
let supplierCache = [];

async function viewSuppliers() {
  const { data, error } = await sb.from("suppliers").select("*").order("name");
  supplierCache = error ? [] : (data || []);
  const list = supplierCache;
  return `
    <div class="card">
      <div class="card-head"><h2>매입 거래처 (${list.length}곳)</h2>
        <button class="btn sm" onclick="openSupplierModal()">＋ 거래처 등록</button></div>
      <p style="color:var(--text-sub);font-size:13px;margin-bottom:12px">
        여기 등록한 거래처가 매입 입력의 선택지로 나옵니다.</p>
      ${!list.length ? `<div style="background:var(--brand-light);border-radius:9px;padding:14px;font-size:13.5px">
        아직 거래처가 없습니다. <b>[＋ 거래처 등록]</b>으로 시작하세요 (상호만 넣어도 됩니다).
      </div>` : `
      <div class="table-wrap"><table>
        <thead><tr><th>거래처명</th><th>사업자번호</th><th>대표자</th><th>연락처</th>
          <th>담당자</th><th>결제조건</th><th>메모</th><th></th></tr></thead>
        <tbody>${list.map(s => `
          <tr ${s.active === false ? 'style="opacity:.5"' : ""}>
            <td><b>${esc(s.name)}</b>${s.active === false ? ' <span class="chip waiting">거래중단</span>' : ""}
              ${s.tax_type === "면세" ? ' <span class="chip waiting">면세</span>' : ""}</td>
            <td>${esc(s.biz_no) || "—"}</td>
            <td>${esc(s.ceo) || "—"}</td>
            <td>${s.phone ? `<a href="tel:${esc(s.phone)}" style="color:var(--brand)">${esc(s.phone)}</a>` : "—"}</td>
            <td>${esc(s.manager) || "—"}</td>
            <td>${esc(s.pay_terms) || "—"}</td>
            <td style="max-width:140px;overflow:hidden;text-overflow:ellipsis">${esc(s.memo)}</td>
            <td style="white-space:nowrap">
              <button class="btn sm secondary" onclick="openSupplierModal('${s.id}')">수정</button>
              <button class="btn sm danger" onclick="deleteSupplier('${s.id}')">삭제</button></td>
          </tr>`).join("")}
        </tbody>
      </table></div>`}
    </div>`;
}

function openSupplierModal(id) {
  const s = id ? supplierCache.find(x => x.id === id) : null;
  document.getElementById("modal-root").innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal" style="max-width:620px">
        <h3>${s ? "거래처 수정" : "거래처 등록"}</h3>
        <div class="form-grid">
          <div class="field full"><label>거래처명 *</label>
            <input id="sp-name" value="${esc(s?.name || "")}" placeholder="예) 한빛유통" maxlength="40"></div>
          <div class="field"><label>사업자등록번호</label>
            <input id="sp-biz" value="${esc(s?.biz_no || "")}" placeholder="000-00-00000" maxlength="20"></div>
          <div class="field"><label>대표자</label>
            <input id="sp-ceo" value="${esc(s?.ceo || "")}" maxlength="20"></div>
          <div class="field"><label>연락처</label>
            <input id="sp-phone" value="${esc(s?.phone || "")}" placeholder="02-000-0000" maxlength="20"></div>
          <div class="field"><label>이메일</label>
            <input id="sp-email" value="${esc(s?.email || "")}" maxlength="60"></div>
          <div class="field"><label>담당자</label>
            <input id="sp-manager" value="${esc(s?.manager || "")}" placeholder="예) 김과장" maxlength="20"></div>
          <div class="field"><label>결제조건</label>
            <input id="sp-terms" list="payterms-list" value="${esc(s?.pay_terms || "")}" placeholder="예) 월말 결제" maxlength="30">
            <datalist id="payterms-list">
              <option value="선입금"><option value="월말 결제"><option value="익월 10일 결제">
              <option value="익월 말일 결제"><option value="현금 결제"><option value="30일 후 결제">
            </datalist></div>
          <div class="field"><label>부가세</label>
            <select id="sp-tax">
              <option value="과세" ${(s?.tax_type || "과세") === "과세" ? "selected" : ""}>과세 (세금계산서)</option>
              <option value="면세" ${s?.tax_type === "면세" ? "selected" : ""}>면세 (계산서)</option>
            </select></div>
          <div class="field"><label>거래 상태</label>
            <select id="sp-active">
              <option value="1" ${s?.active !== false ? "selected" : ""}>거래 중</option>
              <option value="0" ${s?.active === false ? "selected" : ""}>거래 중단 (목록에서 숨김)</option>
            </select></div>
          <div class="field full"><label>주소</label>
            <input id="sp-addr" value="${esc(s?.address || "")}" maxlength="100"></div>
          <div class="field full"><label>메모</label>
            <textarea id="sp-memo" maxlength="200" placeholder="예) 최소 주문 50만원, 배송 3일 소요">${esc(s?.memo || "")}</textarea></div>
        </div>
        <div class="modal-actions">
          <button class="btn secondary" onclick="closeModal()">취소</button>
          <button class="btn" id="btn-sp-save" onclick="saveSupplier('${id || ""}')">저장</button>
        </div>
      </div>
    </div>`;
  document.getElementById("sp-name").focus();
}

// 배송 방식에 따라 관련 없는 입력칸을 흐리게 (헷갈림 방지)
function toggleShipType() {
  const full = document.getElementById("ch-type")?.value === "풀필먼트";
  const s = document.getElementById("fld-ship"), u = document.getElementById("fld-unit");
  if (s) s.style.opacity = full ? ".45" : "1";
  if (u) u.style.opacity = full ? "1" : ".45";
}

async function saveSupplier(id) {
  const name = document.getElementById("sp-name").value.trim();
  if (!name) return toast("거래처명을 입력해 주세요");
  const btn = document.getElementById("btn-sp-save");
  if (btn) btn.disabled = true;
  const data = {
    name,
    biz_no: document.getElementById("sp-biz").value.trim(),
    ceo: document.getElementById("sp-ceo").value.trim(),
    phone: document.getElementById("sp-phone").value.trim(),
    email: document.getElementById("sp-email").value.trim(),
    manager: document.getElementById("sp-manager").value.trim(),
    pay_terms: document.getElementById("sp-terms").value.trim(),
    tax_type: document.getElementById("sp-tax").value,
    active: document.getElementById("sp-active").value === "1",
    address: document.getElementById("sp-addr").value.trim(),
    memo: document.getElementById("sp-memo").value.trim(),
    updated_by: me.name,
  };
  const res = id
    ? await sb.from("suppliers").update(data).eq("id", id).select("id")
    : await sb.from("suppliers").insert(data).select("id");
  if (res.error) {
    if (btn) btn.disabled = false;
    return toast(res.error.code === "23505" ? "이미 등록된 거래처명입니다" : "저장에 실패했습니다");
  }
  if (!res.data?.length) { if (btn) btn.disabled = false; return toast("처리할 거래처를 찾지 못했습니다"); }
  toast(id ? "수정되었습니다" : "거래처가 등록되었습니다");
  closeModal();
  route();
}

async function deleteSupplier(id) {
  const s = supplierCache.find(x => x.id === id);
  if (!s) return;
  // 거래처명은 매입 기록에 문자열로 남으므로, 기록이 있으면 '거래 중단'을 권함
  const { count } = await sb.from("purchases").select("id", { count: "exact", head: true }).eq("supplier", s.name);
  if (count) {
    return alert(
      `'${s.name}'은(는) 삭제하지 않는 편이 좋습니다.\n\n`
      + `이 거래처로 기록된 매입이 ${count}건 있습니다.\n`
      + `삭제해도 매입 기록은 남지만, 거래처 정보(사업자번호·결제조건)를 잃게 됩니다.\n\n`
      + `더 이상 거래하지 않는다면 [수정] → 거래 상태를 '거래 중단'으로 바꿔 주세요.`);
  }
  if (!confirm(`'${s.name}' 거래처를 삭제할까요?`)) return;
  const { data, error } = await sb.from("suppliers").delete().eq("id", id).select("id");
  if (error || !data?.length) return toast("삭제에 실패했습니다");
  toast("삭제되었습니다");
  route();
}

/* ---------- 판매채널 · SCM 계정 ---------- */
async function viewChannels() {
  const { data } = await sb.from("sales_channels").select("*").order("created_at");
  channelCache = data || [];   // 삭제 확인창에서 채널명을 보여주려면 캐시가 채워져 있어야 함
  const list = channelCache;
  return `
    <div class="card">
      <div class="card-head"><h2>판매채널 · SCM 계정 (${list.length}개)</h2>
        <button class="btn sm" onclick="openChannelModal()">＋ 채널 추가</button></div>
      <p style="color:var(--text-sub);font-size:13px;margin-bottom:12px">
        여기 등록한 채널이 매출 입력의 선택지로 나옵니다. ⚠️ SCM 비밀번호는 전 직원에게 보입니다.
      </p>
      <div class="table-wrap"><table>
        <thead><tr><th>채널명</th><th>배송</th><th class="num">수수료</th><th class="num">배송비/물류비</th><th>사이트</th><th>아이디</th><th>비밀번호</th><th>메모</th><th></th></tr></thead>
        <tbody>${list.length ? list.map(c => `
          <tr>
            <td><b>${esc(c.name)}</b></td>
            <td>${c.ship_type === "풀필먼트"
              ? '<span class="chip mine">풀필먼트</span>' : '<span style="color:var(--text-sub)">직접배송</span>'}</td>
            <td class="num">${Number(c.fee_rate) ? Number(c.fee_rate).toFixed(1) + "%" : '<span style="color:#d9480f">미설정</span>'}</td>
            <td class="num">${c.ship_type === "풀필먼트"
              ? (Number(c.unit_fee) ? "개당 ₩" + fmt(c.unit_fee) : '<span style="color:#d9480f">미설정</span>')
              : (Number(c.ship_fee) ? "건당 ₩" + fmt(c.ship_fee) : '<span style="color:var(--text-sub)">—</span>')}</td>
            <td>${c.url ? `<a href="${esc(normUrl(c.url))}" target="_blank" rel="noopener" style="color:var(--brand)">바로가기 ↗</a>` : "—"}</td>
            <td>${c.login_id ? `${esc(c.login_id)} <button class="btn-ghost" style="font-size:12px" title="복사"
              data-copy="${esc(c.login_id)}" onclick="copyText(this.dataset.copy)">📋</button>` : "—"}</td>
            <td>${c.login_pw
              ? `<span id="pw-${c.id}" data-pw="${esc(c.login_pw)}">••••••</span>
                 <button class="btn-ghost" style="font-size:12px" title="보기" onclick="togglePw('${c.id}')">👁</button>
                 <button class="btn-ghost" style="font-size:12px" title="복사"
                   data-copy="${esc(c.login_pw)}" onclick="copyText(this.dataset.copy)">📋</button>`
              : "—"}</td>
            <td style="max-width:150px;overflow:hidden;text-overflow:ellipsis">${esc(c.memo)}</td>
            <td style="white-space:nowrap">
              <button class="btn sm secondary" onclick="openChannelModal('${c.id}')">수정</button>
              <button class="btn sm danger" onclick="deleteChannel('${c.id}')">삭제</button></td>
          </tr>`).join("") : `<tr><td colspan="9" class="empty">등록된 채널이 없습니다</td></tr>`}
        </tbody>
      </table></div>
    </div>`;
}

let channelCache = [];
// URL에 http(s):// 가 없으면 붙여줌 (없으면 상대경로로 깨짐)
function normUrl(u) {
  u = (u || "").trim();
  if (!u) return "";
  return /^https?:\/\//i.test(u) ? u : "https://" + u;
}
function togglePw(id) {
  const el = document.getElementById("pw-" + id);
  if (!el) return;
  const shown = el.textContent !== "••••••";
  el.textContent = shown ? "••••••" : el.dataset.pw;
}
function copyText(t) {
  const done = () => toast("복사되었습니다");
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(t).then(done).catch(() => fallbackCopy(t, done));
  } else {
    fallbackCopy(t, done);
  }
}
function fallbackCopy(t, done) {
  try {
    const ta = document.createElement("textarea");
    ta.value = t;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    done();
  } catch (e) {
    toast("복사 실패 — 길게 눌러 복사하세요");
  }
}

async function openChannelModal(id) {
  if (!channelCache.length || id) {
    const { data } = await sb.from("sales_channels").select("*");
    channelCache = data || [];
  }
  const c = id ? channelCache.find(x => x.id === id) : null;
  document.getElementById("modal-root").innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal">
        <h3>${c ? "채널 수정" : "채널 추가"}</h3>
        <div class="form-grid">
          <div class="field full"><label>채널명 *</label><input id="ch-name" value="${esc(c?.name || "")}" placeholder="예) 11번가" maxlength="30"></div>
          <div class="field full"><label>관리시스템(SCM) 주소</label><input id="ch-url" value="${esc(c?.url || "")}" placeholder="https://..." maxlength="200"></div>
          <div class="field"><label>아이디</label><input id="ch-id" value="${esc(c?.login_id || "")}" maxlength="60" autocomplete="off"></div>
          <div class="field"><label>비밀번호</label><input id="ch-pw" value="${esc(c?.login_pw || "")}" maxlength="60" autocomplete="off"></div>
          <div class="field"><label>판매수수료 (%)</label>
            <input id="ch-fee" type="number" min="0" max="100" step="0.1" value="${c?.fee_rate ?? ""}" placeholder="예) 10.8"></div>
          <div class="field full"><label>배송 방식</label>
            <select id="ch-type" onchange="toggleShipType()">
              <option value="직접배송" ${(c?.ship_type || "직접배송") === "직접배송" ? "selected" : ""}>직접 배송 — 우리가 택배로 보냄</option>
              <option value="풀필먼트" ${c?.ship_type === "풀필먼트" ? "selected" : ""}>풀필먼트 — 몰이 보관·배송 (쿠팡 로켓그로스 등)</option>
            </select></div>
          <div class="field" id="fld-ship"><label>출고배송비 (주문 1건당, 원)${vatTag("exp")}</label>
            <input id="ch-ship" type="text" inputmode="numeric" class="comma" value="${cfv(c?.ship_fee)}" placeholder="예) 3,300"></div>
          <div class="field" id="fld-unit"><label>물류비 (상품 1개당, 원)${vatTag("exp")}</label>
            <input id="ch-unit" type="text" inputmode="numeric" class="comma" value="${cfv(c?.unit_fee)}" placeholder="예) 1,800"></div>
          <div class="field full" style="font-size:12px;color:var(--text-sub);line-height:1.7">
            ※ <b>직접 배송</b>: 주문 1건마다 택배비가 나갑니다 → 위의 <b>출고배송비</b>만 넣으세요.<br>
            ※ <b>풀필먼트(로켓그로스 등)</b>: 택배비 대신 <b>개당 물류비(입출고비)</b>가 붙습니다 → <b>물류비</b>에 넣으세요.
            보관료처럼 월 단위로 나가는 비용은 공헌이익 화면의 <b>고정비</b>에 넣으시면 됩니다.<br>
            ※ 넣어두면 공헌이익 화면에서 채널별 실제 이익이 자동 계산됩니다.</div>
          <div class="field full"><label>메모</label><textarea id="ch-memo" maxlength="200">${esc(c?.memo || "")}</textarea></div>
        </div>
        <div class="modal-actions">
          <button class="btn secondary" onclick="closeModal()">취소</button>
          <button class="btn" onclick="saveChannel('${id || ""}')">저장</button>
        </div>
      </div>
    </div>`;
  toggleShipType();
}

async function saveChannel(id) {
  const name = document.getElementById("ch-name").value.trim();
  if (!name) return toast("채널명을 입력해 주세요");
  const fee = numOf(document.getElementById("ch-fee").value) || 0;
  if (fee < 0 || fee > 100) return toast("수수료율은 0~100 사이로 입력해 주세요");
  // 10.8%를 0.108로 넣는 실수가 잦아 수수료가 100배 작게 계산됨
  if (fee > 0 && fee < 1 && !confirm(
    `수수료율을 ${fee}%로 저장할까요?\n\n`
    + `10.8%처럼 퍼센트 숫자를 그대로 넣어야 합니다 (0.108이 아니라 10.8).\n`
    + `${fee}%가 맞다면 [확인]을 누르세요.`)) return;
  const data = {
    name,
    url: normUrl(document.getElementById("ch-url").value),
    login_id: document.getElementById("ch-id").value.trim(),
    login_pw: document.getElementById("ch-pw").value,
    fee_rate: fee,
    ship_type: document.getElementById("ch-type").value,
    // 배송 방식과 무관한 쪽 값은 0으로 저장 — 방식을 바꿨을 때 예전 값이 남아 이중 계산되는 것을 막는다
    ship_fee: document.getElementById("ch-type").value === "풀필먼트" ? 0 : (numOf(document.getElementById("ch-ship").value) || 0),
    unit_fee: document.getElementById("ch-type").value === "풀필먼트" ? (numOf(document.getElementById("ch-unit").value) || 0) : 0,
    memo: document.getElementById("ch-memo").value.trim(),
  };
  const res = id
    ? await sb.from("sales_channels").update(data).eq("id", id)
    : await sb.from("sales_channels").insert(data);
  if (res.error) return toast(res.error.code === "23505" ? "이미 있는 채널명입니다" : "저장에 실패했습니다");
  toast(id ? "수정되었습니다" : "채널이 추가되었습니다");
  closeModal();
  route();
}

async function deleteChannel(id) {
  const c = channelCache.find(x => x.id === id) || {};
  if (!confirm(
    `'${c.name || "이 채널"}' 채널을 삭제할까요?\n\n`
    + `매출 기록은 남지만, 이 채널의 수수료율·배송비 설정이 사라져\n`
    + `과거 달의 공헌이익이 실제보다 크게 표시됩니다.\n`
    + `채널을 더 안 쓰더라도 설정은 남겨두는 편이 정확합니다.`)) return;
  const { error } = await sb.from("sales_channels").delete().eq("id", id);
  if (error) return toast("삭제에 실패했습니다");
  toast("삭제되었습니다");
  route();
}

/* ---------- AI 리포트 ---------- */
async function viewAiReport() {
  const { data } = await sb.from("ai_reports").select("*").order("date", { ascending: false }).limit(14);
  const reports = data || [];
  if (!reports.length) {
    return `<div class="card">
      <h2>🤖 AI 리포트</h2>
      <p style="color:var(--text-sub);font-size:13.5px">
        아직 리포트가 없습니다. <b>매일 아침 8시</b>에 자동으로 올라옵니다.
      </p>
    </div>`;
  }
  return reports.map((r, i) => `
    <div class="card" ${i === 0 ? 'style="border:2px solid var(--brand)"' : ""}>
      <div class="card-head">
        <h2>${i === 0 ? "🤖 최신 리포트 · " : ""}${esc(r.date)}</h2>
        ${r.anomalies
          ? `<span class="chip rejected">이상징후 ${r.anomalies}건</span>`
          : '<span class="chip approved">이상 없음</span>'}
      </div>
      <div style="white-space:pre-wrap;font-size:14px;line-height:1.8">${esc(r.content)}</div>
    </div>`).join("") + `
    <p style="color:var(--text-sub);font-size:12px">※ 매일 아침 8시에 자동 생성됩니다. 최근 14일치가 보관됩니다.</p>`;
}

/* ---------- 업무 지시 ---------- */
async function viewTasks() {
  const { data } = await sb.from("tasks").select("*").order("created_at", { ascending: false }).limit(300);
  const list = data || [];
  const myOpen = list.filter(t => t.assignee_id === me.id && t.status === "open");
  const iAssigned = list.filter(t => t.creator_id === me.id);
  const others = USERS.filter(u => u.id !== me.id);

  const dday = d => {
    if (!d) return "";
    const diff = Math.round((new Date(d) - new Date(today())) / 86400000);
    const label = diff === 0 ? "오늘까지" : diff > 0 ? `D-${diff}` : `${-diff}일 지남`;
    const color = diff < 0 ? "var(--red)" : diff <= 1 ? "var(--amber)" : "var(--text-sub)";
    return `<span style="color:${color};font-weight:700">${label}</span> <small style="color:var(--text-sub)">(${esc(d)})</small>`;
  };

  return `
    <div class="card">
      <h2>업무 지시하기</h2>
      <div class="form-grid">
        <div class="field full"><label>지시 내용 *</label>
          <input id="t-title" placeholder="예) 쿠팡 발주서 오늘까지 넣어주세요" maxlength="100"></div>
        <div class="field"><label>담당자 *</label>
          <select id="t-assignee">${others.map(u => `<option value="${u.id}">${esc(u.name)} (${esc(u.role)})</option>`).join("")}</select></div>
        <div class="field"><label>기한 (선택)</label><input id="t-due" type="date"></div>
        <div class="field full"><label>상세 설명 (선택)</label>
          <textarea id="t-detail" placeholder="참고 링크, 세부 내용 등"></textarea></div>
      </div>
      <div class="modal-actions">
        <button class="btn" id="btn-create-task" onclick="createTask()">지시 보내기 (알림 발송)</button>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>🗡️ 내 퀘스트 (${myOpen.length}건)</h2></div>
      ${myOpen.length ? `<div class="quests">${myOpen.map(t => {
        const diff = t.due_date ? Math.round((new Date(t.due_date) - new Date(today())) / 86400000) : null;
        const ico = t.title.startsWith("[반복업무]") ? "🔁" : t.title.startsWith("[개선요청]") ? "💬"
          : diff != null && diff < 0 ? "🔥" : diff != null && diff <= 1 ? "⚡" : "📋";
        return `
        <div class="quest">
          <div class="quest-ico">${ico}</div>
          <div class="quest-body">
            <div class="quest-title">${esc(t.title)}</div>
            <div class="quest-desc">${userName(t.creator_id)}의 지시 · ${dday(t.due_date) || "기한 없음"}${
              t.detail ? `<br>${esc(t.detail)}` : ""}</div>
          </div>
          <button class="btn sm green" onclick="completeTask('${t.id}')">✔ 완료</button>
        </div>`;
      }).join("")}</div>` : `<p class="empty" style="padding:24px 0">퀘스트를 모두 클리어했습니다 🏆</p>`}
    </div>

    <div class="card">
      <div class="card-head"><h2>📤 내가 시킨 일 (${iAssigned.filter(t => t.status === "open").length}건 진행 중)</h2></div>
      <div class="table-wrap"><table>
        <thead><tr><th>내용</th><th>담당자</th><th>기한</th><th>상태</th><th></th></tr></thead>
        <tbody>${iAssigned.length ? iAssigned.map(t => `
          <tr>
            <td><b>${esc(t.title)}</b>${t.detail ? `<br><small style="color:var(--text-sub)">${esc(t.detail)}</small>` : ""}</td>
            <td>${userName(t.assignee_id)}</td>
            <td>${t.status === "done" ? "—" : (dday(t.due_date) || "—")}</td>
            <td>${t.status === "done"
              ? `<span class="chip approved">완료</span><br><small style="color:var(--text-sub)">${esc(localDT(t.done_at).slice(0, 10))}</small>`
              : '<span class="chip progress">진행 중</span>'}</td>
            <td><button class="btn sm danger" onclick="deleteTask('${t.id}')">삭제</button></td>
          </tr>`).join("") : `<tr><td colspan="5" class="empty">시킨 일이 없습니다</td></tr>`}
        </tbody>
      </table></div>
    </div>`;
}

async function createTask() {
  const title = document.getElementById("t-title").value.trim();
  if (!title) return toast("지시 내용을 입력해 주세요");
  const assignee = document.getElementById("t-assignee").value;
  if (!assignee) return toast("담당자를 선택해 주세요");
  const btn = document.getElementById("btn-create-task");
  btn.disabled = true; // 연타로 중복 등록 방지
  const { error } = await sb.from("tasks").insert({
    title,
    detail: document.getElementById("t-detail").value.trim(),
    assignee_id: assignee,
    creator_id: me.id,
    due_date: document.getElementById("t-due").value || null,
  });
  if (error) { btn.disabled = false; return toast("지시 등록에 실패했습니다"); }
  toast("지시를 보냈습니다 (알림 발송)");
  route();
}

async function completeTask(id) {
  const { error } = await sb.from("tasks").update({ status: "done", done_at: new Date().toISOString() }).eq("id", id);
  if (error) return toast("처리에 실패했습니다");
  toast("🎉 퀘스트 클리어! (지시자에게 알림)");
  route();
}

async function deleteTask(id) {
  if (!confirm("이 지시를 삭제할까요?")) return;
  const { error } = await sb.from("tasks").delete().eq("id", id);
  if (error) return toast("삭제에 실패했습니다");
  toast("삭제되었습니다");
  route();
}

/* ---------- 공용 일정 (회사 전체가 같이 보는 캘린더) ----------
   누가 등록하든 모든 직원에게 똑같이 보입니다. 표는 events (sql/calendar.sql). */

const CAL_CATS = {
  "회의":      { fg: "#3a46d4", bg: "#eef0fe" },
  "출장":      { fg: "#6d28d9", bg: "#f3ecff" },
  "휴가":      { fg: "#0f7a46", bg: "#e6f7ef" },
  "납품·입고": { fg: "#c2410c", bg: "#fff1e6" },
  "행사":      { fg: "#8a5d00", bg: "#fff6e0" },
  "기타":      { fg: "#4a5262", bg: "#eef0f6" },
};
const calCat = c => CAL_CATS[c] || CAL_CATS["기타"];

let calMonth = today().slice(0, 7);   // 보고 있는 달 "2026-08"
let calMonthCache = [];              // 지금 화면에 그린 일정 (하루 상세 모달이 다시 씀)

function calShift(n) {
  const [y, m] = calMonth.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  calMonth = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
  route();
}
function calToday() { calMonth = today().slice(0, 7); route(); }

// 그 날짜에 걸쳐 있는 일정 (여러 날 일정은 시작~종료 사이 모든 날에 보인다)
const calOnDay = (list, ds) => list.filter(e => ds >= e.start_date && ds <= (e.end_date || e.start_date));
const calTime = e => (e.start_time ? e.start_time.slice(0, 5) : "");
const calSpan = e => e.end_date && e.end_date !== e.start_date;

function calChip(e) {
  const c = calCat(e.category);
  const t = calTime(e);
  return `<button class="cal-ev" style="color:${c.fg};background:${c.bg}"
    onclick="event.stopPropagation();openEventModal('${e.id}')"
    title="${esc(e.title)}${e.place ? " · " + esc(e.place) : ""}">${
    calSpan(e) ? "▸ " : ""}${t ? `<b>${t}</b> ` : ""}${esc(e.title)}</button>`;
}

async function viewCalendar() {
  const [y, m] = calMonth.split("-").map(Number);
  const first = `${calMonth}-01`;
  const lastDom = new Date(y, m, 0).getDate();
  const firstDow = new Date(first + "T00:00:00").getDay();          // 0=일
  const gridStart = addDaysStr(first, -firstDow);
  const weeks = Math.ceil((firstDow + lastDom) / 7);
  const gridEnd = addDaysStr(gridStart, weeks * 7 - 1);

  // 여러 날 일정이 걸쳐 있을 수 있으므로 앞쪽을 넉넉히 잡아 불러온 뒤 겹치는 것만 남긴다
  const [gridRes, soonRes] = await Promise.all([
    sb.from("events").select("*")
      .gte("start_date", addDaysStr(gridStart, -180)).lte("start_date", gridEnd)
      .order("start_date").order("start_time"),
    sb.from("events").select("*")
      .gte("start_date", addDaysStr(today(), -180)).lte("start_date", addDaysStr(today(), 30))
      .order("start_date").order("start_time"),
  ]);
  if (gridRes.error) return `<div class="card"><h2>공용 일정을 불러오지 못했습니다</h2>
    <p style="color:var(--text-sub);font-size:13.5px;margin-top:8px">
      <b>events</b> 표가 아직 없을 수 있습니다. Supabase 대시보드 → SQL Editor에서
      저장소의 <code>sql/calendar.sql</code>을 한 번 실행해 주세요.</p>
    <p style="color:var(--text-sub);font-size:12.5px;margin-top:8px">(${esc(gridRes.error.message)})</p></div>`;

  const monthList = (gridRes.data || []).filter(e => (e.end_date || e.start_date) >= gridStart);
  calMonthCache = monthList;
  // 어제 시작해 오늘도 이어지는 일정(연휴·출장 등)이 목록에서 사라지지 않도록 종료일로 거른다
  const soon = (soonRes.data || []).filter(e => (e.end_date || e.start_date) >= today());

  let cells = "";
  for (let i = 0; i < weeks * 7; i++) {
    const ds = addDaysStr(gridStart, i);
    const dow = i % 7;
    const evs = calOnDay(monthList, ds);
    cells += `
      <div class="cal-cell${ds.slice(0, 7) === calMonth ? "" : " out"}${ds === today() ? " today" : ""}"
        onclick="openDayModal('${ds}')" title="${ds}${evs.length ? ` — 일정 ${evs.length}건` : " — 눌러서 일정 등록"}">
        <div class="cal-num${dow === 0 ? " sun" : dow === 6 ? " sat" : ""}">${Number(ds.slice(8))}</div>
        ${evs.slice(0, 3).map(calChip).join("")}
        ${evs.length > 3 ? `<div class="cal-more">+${evs.length - 3}건 더</div>` : ""}
        ${evs.length ? `<div class="cal-dots">${evs.slice(0, 6)
          .map(e => `<i style="background:${calCat(e.category).fg}"></i>`).join("")}</div>` : ""}
      </div>`;
  }

  const dLabel = ds => {
    const diff = Math.round((new Date(ds) - new Date(today())) / 86400000);
    return diff === 0 ? "오늘" : diff === 1 ? "내일" : `D-${diff}`;
  };

  return `
    <div class="card">
      <div class="card-head">
        <h2>${y}년 ${m}월</h2>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn sm secondary" onclick="calShift(-1)" title="지난달">‹</button>
          <button class="btn sm secondary" onclick="calToday()">오늘</button>
          <button class="btn sm secondary" onclick="calShift(1)" title="다음달">›</button>
          <button class="btn sm" onclick="openEventModal('', '${today()}')">＋ 일정 등록</button>
        </div>
      </div>
      <p style="font-size:13px;color:var(--text-sub);margin:-4px 0 12px">
        날짜를 누르면 그 날에 일정을 등록합니다. 등록한 일정은 전 직원에게 똑같이 보입니다.</p>
      <div class="cal-scroll">
        <div class="cal-head">${["일", "월", "화", "수", "목", "금", "토"]
          .map((d, i) => `<div class="${i === 0 ? "sun" : i === 6 ? "sat" : ""}">${d}</div>`).join("")}</div>
        <div class="cal-grid">${cells}</div>
      </div>
      <div class="cal-legend">${Object.keys(CAL_CATS).map(k =>
        `<span><i style="background:${calCat(k).fg}"></i>${k}</span>`).join("")}</div>
    </div>

    <div class="card">
      <div class="card-head"><h2>다가오는 일정 (30일 · ${soon.length}건)</h2></div>
      <div class="table-wrap"><table>
        <thead><tr><th>날짜</th><th>시각</th><th>분류</th><th>일정</th><th>장소</th><th>등록</th><th></th></tr></thead>
        <tbody>${soon.length ? soon.map(e => `
          <tr>
            <td style="white-space:nowrap"><b>${esc(e.start_date.slice(5))}</b>
              ${calSpan(e) ? `<small style="color:var(--text-sub)">~${esc(e.end_date.slice(5))}</small>` : ""}
              <br><small style="color:${e.start_date === today() ? "var(--red)" : "var(--text-sub)"};font-weight:700">${dLabel(e.start_date)}</small></td>
            <td style="white-space:nowrap">${calTime(e) || '<span style="color:var(--text-sub)">종일</span>'}</td>
            <td><span class="chip" style="color:${calCat(e.category).fg};background:${calCat(e.category).bg}">${esc(e.category)}</span></td>
            <td><b>${esc(e.title)}</b>${e.memo ? `<br><small style="color:var(--text-sub)">${esc(e.memo)}</small>` : ""}</td>
            <td>${esc(e.place) || "—"}</td>
            <td><small style="color:var(--text-sub)">${esc(e.created_by) || "—"}</small></td>
            <td><button class="btn sm secondary" onclick="openEventModal('${e.id}')">보기</button></td>
          </tr>`).join("") : `<tr><td colspan="7" class="empty">앞으로 30일 안에 등록된 일정이 없습니다</td></tr>`}
        </tbody>
      </table></div>
    </div>`;
}

// 날짜 칸을 눌렀을 때 — 일정이 있으면 그 날 목록을, 없으면 바로 등록 화면을 연다
function openDayModal(ds) {
  const evs = calOnDay(calMonthCache, ds);
  if (!evs.length) return openEventModal("", ds);
  const [y, m, d] = ds.split("-").map(Number);
  const dow = ["일", "월", "화", "수", "목", "금", "토"][new Date(ds + "T00:00:00").getDay()];
  document.getElementById("modal-root").innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal">
        <h3>${y}년 ${m}월 ${d}일 (${dow}) · ${evs.length}건</h3>
        <div class="day-list">${evs.map(e => `
          <button class="day-row" onclick="openEventModal('${e.id}')">
            <span class="day-bar" style="background:${calCat(e.category).fg}"></span>
            <span class="day-body">
              <span class="day-title">${esc(e.title)}</span>
              <span class="day-sub">${esc(e.category)} · ${calTime(e) || "종일"}${
                calSpan(e) ? ` · ${esc(e.start_date.slice(5))}~${esc(e.end_date.slice(5))}` : ""}${
                e.place ? ` · ${esc(e.place)}` : ""}</span>
            </span>
          </button>`).join("")}</div>
        <div class="modal-actions" style="justify-content:space-between">
          <button class="btn secondary" onclick="openEventModal('', '${ds}')">＋ 이 날에 일정 등록</button>
          <button class="btn secondary" onclick="closeModal()">닫기</button>
        </div>
      </div>
    </div>`;
}

async function openEventModal(id, presetDate) {
  let e = null;
  if (id) {
    const { data } = await sb.from("events").select("*").eq("id", id).maybeSingle();
    if (!data) return toast("일정을 찾지 못했습니다 (이미 삭제되었을 수 있습니다)");
    e = data;
  }
  const d = e?.start_date || presetDate || today();
  document.getElementById("modal-root").innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal">
        <h3>${e ? "일정 수정" : "일정 등록"}</h3>
        ${e ? `<p style="font-size:12.5px;color:var(--text-sub);margin:2px 0 12px">
          ${esc(e.created_by) || "?"} 등록 · ${esc(localDT(e.created_at))}</p>` : ""}
        <div class="form-grid">
          <div class="field full"><label>일정 이름 *</label>
            <input id="ev-title" value="${esc(e?.title || "")}" maxlength="60"
              placeholder="예) 한빛유통 미팅, 김대표 출장, 창고 실사"></div>
          <div class="field"><label>분류</label>
            <select id="ev-cat">${Object.keys(CAL_CATS).map(k =>
              `<option ${e?.category === k ? "selected" : ""}>${k}</option>`).join("")}</select></div>
          <div class="field"><label>장소 (선택)</label>
            <input id="ev-place" value="${esc(e?.place || "")}" maxlength="60" placeholder="예) 본사 회의실, 쿠팡 대구센터"></div>
          <div class="field"><label>시작일 *</label><input id="ev-start" type="date" value="${esc(d)}"></div>
          <div class="field"><label>종료일 <small style="color:var(--text-sub);font-weight:400">— 하루면 비워 두세요</small></label>
            <input id="ev-end" type="date" value="${esc(e?.end_date || "")}"></div>
          <div class="field"><label>시작 시각 <small style="color:var(--text-sub);font-weight:400">— 비우면 종일</small></label>
            <input id="ev-stime" type="time" value="${esc(e?.start_time ? e.start_time.slice(0, 5) : "")}"></div>
          <div class="field"><label>종료 시각 (선택)</label>
            <input id="ev-etime" type="time" value="${esc(e?.end_time ? e.end_time.slice(0, 5) : "")}"></div>
          <div class="field full"><label>메모 (선택)</label>
            <textarea id="ev-memo" maxlength="300" placeholder="준비물, 참석자, 참고 링크 등">${esc(e?.memo || "")}</textarea></div>
        </div>
        <div class="modal-actions" style="justify-content:space-between">
          <span>${e ? `<button class="btn danger" onclick="deleteEvent('${e.id}')">삭제</button>` : ""}</span>
          <span style="display:flex;gap:10px">
            <button class="btn secondary" onclick="closeModal()">취소</button>
            <button class="btn" id="btn-ev-save" onclick="saveEvent('${id || ""}')">${e ? "저장" : "등록"}</button>
          </span>
        </div>
      </div>
    </div>`;
  document.getElementById("ev-title").focus();
}

async function saveEvent(id) {
  const title = document.getElementById("ev-title").value.trim();
  if (!title) return toast("일정 이름을 입력해 주세요");
  const start_date = document.getElementById("ev-start").value;
  if (!start_date) return toast("시작일을 선택해 주세요");
  const end_date = document.getElementById("ev-end").value || null;
  if (end_date && end_date < start_date) return toast("종료일이 시작일보다 앞설 수 없습니다");
  const start_time = document.getElementById("ev-stime").value || null;
  const end_time = document.getElementById("ev-etime").value || null;
  if (end_time && !start_time) return toast("종료 시각만 넣을 수는 없습니다 — 시작 시각도 넣어 주세요");
  if (start_time && end_time && !end_date && end_time < start_time)
    return toast("종료 시각이 시작 시각보다 앞섭니다");

  const row = {
    title, start_date, end_date, start_time, end_time,
    category: document.getElementById("ev-cat").value,
    place: document.getElementById("ev-place").value.trim(),
    memo: document.getElementById("ev-memo").value.trim(),
  };
  const btn = document.getElementById("btn-ev-save");
  if (btn) btn.disabled = true;   // 연타로 같은 일정이 두 번 들어가지 않도록
  const res = id
    ? await sb.from("events").update({ ...row, updated_at: new Date().toISOString() }).eq("id", id).select("id")
    : await sb.from("events").insert({ ...row, creator_id: me.id, created_by: me.name }).select("id");
  if (res.error || !res.data?.length) {
    if (btn) btn.disabled = false;
    return toast(res.error ? "저장에 실패했습니다" : "저장할 일정을 찾지 못했습니다");
  }
  toast(id ? "일정을 수정했습니다" : "일정을 등록했습니다");
  closeModal();
  route();
}

async function deleteEvent(id) {
  if (!confirm("이 일정을 삭제할까요? 전 직원의 달력에서 사라집니다.")) return;
  const { data, error } = await sb.from("events").delete().eq("id", id).select("id");
  if (error) return toast("삭제에 실패했습니다");
  if (!data?.length) return toast("삭제할 일정을 찾지 못했습니다 (이미 삭제되었을 수 있습니다)");
  toast("일정을 삭제했습니다");
  closeModal();
  route();
}

/* ---------- 자금일보 ---------- */
const CASH_CATS_IN = ["판매대금", "정산금", "대표 입금", "기타 입금"];
const CASH_CATS_OUT = ["매입대금", "경비", "광고비", "급여", "세금·공과", "기타 출금"];
let cashDate = today();
let cashAccounts = [];
let cashTxns = [];
let cashPlans = [];

function addDaysStr(base, n) {
  const d = new Date(base + "T00:00:00");
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// 예정 입출금을 향후 days일 발생분으로 전개 (매월 반복 포함)
function planOccurrences(plans, startStr, days) {
  const endStr = addDaysStr(startStr, days);
  const occ = [];
  for (const p of plans) {
    if (p.repeat === "매월") {
      const dom = Number(p.date.slice(8, 10));
      const base = new Date(startStr + "T00:00:00");
      for (let m = 0; m <= 2; m++) {
        const y = base.getFullYear(), mo = base.getMonth() + m;
        const lastDay = new Date(y, mo + 1, 0).getDate();
        const dd = new Date(y, mo, Math.min(dom, lastDay));
        const ds = `${dd.getFullYear()}-${pad2(dd.getMonth() + 1)}-${pad2(dd.getDate())}`;
        if (ds >= startStr && ds <= endStr && ds >= p.date) occ.push({ ...p, occDate: ds });
      }
    } else if (p.date <= endStr) {
      // 예정일이 지났는데 아직 처리 안 된 건도 포함해야 함 (빠지면 자금이 여유 있어 보임)
      occ.push({ ...p, occDate: p.date, overdue: p.date < startStr });
    }
  }
  return occ.sort((a, b) => a.occDate.localeCompare(b.occDate) || (a.kind === "입금" ? -1 : 1));
}

async function viewCash() {
  const [accRes, txnRes, planRes] = await Promise.all([
    sb.from("cash_accounts").select("*").order("created_at"),
    sb.from("cash_txns").select("*").order("date").order("created_at"),
    sb.from("cash_plans").select("*").order("date"),
  ]);
  cashAccounts = accRes.data || [];
  cashTxns = txnRes.data || [];
  cashPlans = planRes.data || [];

  if (!cashAccounts.length) {
    return `
      <div class="card">
        <h2>자금일보 시작하기</h2>
        <p style="color:var(--text-sub);font-size:13.5px;margin-bottom:14px">
          계좌와 기초잔액을 등록하면, 이후 입출금만 입력해도 잔액이 자동 계산됩니다.
        </p>
        <button class="btn" onclick="openCashAccountModal()">＋ 계좌 등록</button>
      </div>`;
  }

  // 계좌별: 전일잔액 = 기초잔액 + (선택일 이전 입금-출금), 당일 입출금, 당일잔액
  const rows = cashAccounts.map(a => {
    const mine = cashTxns.filter(t => t.account_id === a.id);
    const before = mine.filter(t => t.date < cashDate)
      .reduce((s, t) => s + (t.kind === "입금" ? 1 : -1) * Number(t.amount), 0);
    const dayIn = mine.filter(t => t.date === cashDate && t.kind === "입금")
      .reduce((s, t) => s + Number(t.amount), 0);
    const dayOut = mine.filter(t => t.date === cashDate && t.kind === "출금")
      .reduce((s, t) => s + Number(t.amount), 0);
    const prev = Number(a.initial_balance) + before;
    return { a, prev, dayIn, dayOut, bal: prev + dayIn - dayOut };
  });
  const tot = rows.reduce((s, r) => ({ prev: s.prev + r.prev, dayIn: s.dayIn + r.dayIn, dayOut: s.dayOut + r.dayOut, bal: s.bal + r.bal }),
    { prev: 0, dayIn: 0, dayOut: 0, bal: 0 });
  const dayList = cashTxns.filter(t => t.date === cashDate)
    .sort((x, y) => (y.created_at || "").localeCompare(x.created_at || ""));
  const accName = id => { const a = cashAccounts.find(x => x.id === id); return a ? a.name : "?"; };

  // ===== 향후 30일 자금 예측 =====
  // 실제 잔액에는 '오늘까지 실제로 오간 돈'만 포함 (미래 날짜 거래는 아직 통장에 없음)
  const futureTxns = cashTxns.filter(t => t.date > today());
  const curBal = cashAccounts.reduce((s, a) =>
    s + Number(a.initial_balance) + cashTxns.filter(t => t.account_id === a.id && t.date <= today())
      .reduce((ss, t) => ss + (t.kind === "입금" ? 1 : -1) * Number(t.amount), 0), 0);
  const occ = planOccurrences(cashPlans, today(), 30);
  let runBal = curBal;
  const projRows = occ.map(o => {
    runBal += (o.kind === "입금" ? 1 : -1) * Number(o.amount);
    return { ...o, bal: runBal };
  });
  const planIn = occ.filter(o => o.kind === "입금").reduce((s, o) => s + Number(o.amount), 0);
  const planOut = occ.filter(o => o.kind === "출금").reduce((s, o) => s + Number(o.amount), 0);
  const minRow = projRows.reduce((m, r) => (m === null || r.bal < m.bal) ? r : m, null);

  return `
    <div class="grid-stats">
      <div class="stat"><div class="stat-label">${cashDate} 총 잔액 (실제)</div>
        <div class="stat-value blue">₩${fmt(tot.bal)}</div></div>
      <div class="stat"><div class="stat-label">당일 입금</div>
        <div class="stat-value green">₩${fmt(tot.dayIn)}</div></div>
      <div class="stat"><div class="stat-label">당일 출금</div>
        <div class="stat-value red">₩${fmt(tot.dayOut)}</div></div>
      <div class="stat"><div class="stat-label">들어올 돈 (30일)</div>
        <div class="stat-value green">+₩${fmt(planIn)}</div></div>
    </div>

    ${futureTxns.length ? `
    <div class="card" style="border:2px solid #d9480f">
      <h2 style="color:#d9480f">⚠️ 아직 들어오지 않은 돈이 '실제 거래'로 기록돼 있습니다</h2>
      <p style="font-size:13.5px;color:var(--text-sub);margin:6px 0 12px">
        아래 ${futureTxns.length}건은 <b>오늘(${today()}) 이후 날짜</b>인데 실제 입출금 내역에 들어가 있습니다.
        예정된 돈이라면 <b>[예정으로 옮기기]</b>를 눌러 주세요 — 실제 잔액에서 빠지고 '들어올 돈'으로 관리됩니다.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>날짜</th><th>구분</th><th class="num">금액</th><th>적요</th><th></th></tr></thead>
        <tbody>${futureTxns.map(t => `
          <tr>
            <td><b>${esc(t.date)}</b></td>
            <td>${t.kind === "입금" ? '<span class="chip approved">입금</span>' : '<span class="chip rejected">출금</span>'}</td>
            <td class="num"><b>${t.kind === "입금" ? "+" : "−"}₩${fmt(t.amount)}</b></td>
            <td>${esc(t.memo || t.category)}</td>
            <td style="white-space:nowrap">
              <button class="btn sm" onclick="convertTxnToPlan('${t.id}')">예정으로 옮기기</button>
              <button class="btn sm danger" onclick="deleteCashTxn('${t.id}')">삭제</button></td>
          </tr>`).join("")}
        </tbody>
      </table></div>
    </div>` : ""}

    <div class="card">
      <div class="card-head"><h2>계좌별 자금 현황</h2>
        <div style="display:flex;gap:8px;align-items:center">
          <input type="date" value="${cashDate}" style="border:1.5px solid var(--line);border-radius:9px;padding:8px 12px"
            onchange="if(this.value){cashDate=this.value;route()}else{this.value=cashDate}">
          <button class="btn sm secondary" onclick="openCashAccountModal()">＋ 계좌</button>
        </div></div>
      <div class="table-wrap"><table>
        <thead><tr><th>계좌</th><th class="num">전일잔액</th><th class="num">당일입금</th><th class="num">당일출금</th><th class="num">당일잔액</th></tr></thead>
        <tbody>
          ${rows.map(r => `
          <tr>
            <td><b>${esc(r.a.name)}</b>
              <button class="btn-ghost" title="계좌 수정" style="font-size:12px" onclick="openCashAccountModal('${r.a.id}')">✎</button>
              ${r.a.bank ? `<br><small style="color:var(--text-sub)">${esc(r.a.bank)}</small>` : ""}</td>
            <td class="num">₩${fmt(r.prev)}</td>
            <td class="num" style="color:var(--green)">${r.dayIn ? "+₩" + fmt(r.dayIn) : "—"}</td>
            <td class="num" style="color:var(--red)">${r.dayOut ? "−₩" + fmt(r.dayOut) : "—"}</td>
            <td class="num" style="font-weight:800">₩${fmt(r.bal)}</td>
          </tr>`).join("")}
          <tr style="background:var(--brand-light)">
            <td><b>합계</b></td>
            <td class="num"><b>₩${fmt(tot.prev)}</b></td>
            <td class="num" style="color:var(--green)"><b>+₩${fmt(tot.dayIn)}</b></td>
            <td class="num" style="color:var(--red)"><b>−₩${fmt(tot.dayOut)}</b></td>
            <td class="num" style="font-weight:800"><b>₩${fmt(tot.bal)}</b></td>
          </tr>
        </tbody>
      </table></div>
    </div>

    <div class="card" ${minRow && minRow.bal < 0 ? 'style="border:2px solid var(--red)"' : ""}>
      <div class="card-head"><h2>📅 들어올 돈 · 나갈 돈 (향후 30일)</h2>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <button class="btn sm" onclick="openPlanModal('입금')">＋ 들어올 돈</button>
          <button class="btn sm secondary" onclick="openPlanModal('출금')">＋ 나갈 돈</button>
          ${minRow && minRow.bal < 0
            ? `<span class="chip rejected">⚠️ ${esc(minRow.occDate.slice(5))} 자금 부족 예상</span>`
            : '<span class="chip approved">30일 내 이상 없음</span>'}
        </div></div>
      <p style="font-size:13px;color:var(--text-sub);margin:-4px 0 12px">
        들어올 돈·나갈 돈의 <b>예정</b>을 등록하면, 자금이 언제 부족해질지 미리 보여줍니다.</p>
      <div class="grid-stats">
        <div class="stat"><div class="stat-label">현재 잔액</div>
          <div class="stat-value blue">₩${fmt(curBal)}</div></div>
        <div class="stat"><div class="stat-label">30일 내 예정 입금</div>
          <div class="stat-value green">+₩${fmt(planIn)}</div></div>
        <div class="stat"><div class="stat-label">30일 내 예정 출금</div>
          <div class="stat-value red">−₩${fmt(planOut)}</div></div>
        <div class="stat"><div class="stat-label">30일 후 예상 잔액</div>
          <div class="stat-value ${curBal + planIn - planOut < 0 ? "red" : ""}">₩${fmt(curBal + planIn - planOut)}</div></div>
      </div>

      <h2 style="font-size:14.5px;margin:16px 0 10px">잔액 흐름 (예정 반영)</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>예정일</th><th>내용</th><th class="num">금액</th><th class="num">예상 잔액</th><th></th></tr></thead>
        <tbody>${projRows.length ? projRows.map(r => `
          <tr>
            <td>${esc(r.occDate)}</td>
            <td><b>${esc(r.title)}</b>${r.repeat === "매월" ? ' <span class="chip mine">매월</span>' : ""}
              ${r.overdue ? ' <span class="chip rejected">예정일 지남</span>' : ""}</td>
            <td class="num" style="color:${r.kind === "입금" ? "var(--green)" : "var(--red)"}">${r.kind === "입금" ? "+" : "−"}₩${fmt(r.amount)}</td>
            <td class="num" style="font-weight:800;color:${r.bal < 0 ? "var(--red)" : "var(--text)"}">₩${fmt(r.bal)}</td>
            <td><button class="btn sm danger" onclick="deleteErpRow('cash_plans','${r.id}')">삭제</button></td>
          </tr>`).join("") : `<tr><td colspan="5" class="empty">향후 30일 예정된 입출금이 없습니다 — 결제 예정·정산 예정을 등록해 두세요</td></tr>`}
        </tbody>
      </table></div>
      <p style="color:var(--text-sub);font-size:12px;margin-top:10px">
        ※ 예상 잔액 = 현재 잔액 + 예정 입금 − 예정 출금 (날짜순 누적). 실제 입출금이 일어나면 위의 '입출금 입력'에 기록하고, 여기 계획은 삭제하세요.<br>
        ※ '매월 반복' 계획은 삭제하면 반복 전체가 삭제됩니다.
      </p>
    </div>

    <div class="card">
      <h2>입출금 입력</h2>
      <div class="form-grid">
        <div class="field"><label>일자</label><input id="c-date" type="date" value="${cashDate}"></div>
        <div class="field"><label>계좌 *</label>
          <select id="c-account">
            ${cashAccounts.length > 1 ? '<option value="">계좌를 선택하세요</option>' : ""}
            ${cashAccounts.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join("")}</select></div>
        <div class="field"><label>구분 *</label>
          <select id="c-kind" onchange="refreshCashCats()">
            <option value="입금">입금 (+)</option>
            <option value="출금">출금 (−)</option>
          </select></div>
        <div class="field"><label>분류</label>
          <select id="c-cat">${CASH_CATS_IN.map(c => `<option>${c}</option>`).join("")}</select></div>
        <div class="field"><label>금액(원) *${vatTagCash()}</label><input id="c-amount" type="text" inputmode="numeric" class="comma" placeholder="0"></div>
        <div class="field"><label>적요</label><input id="c-memo" placeholder="예) 쿠팡 정산, OO상사 대금" maxlength="100"></div>
      </div>
      <p style="font-size:12px;color:var(--text-sub);margin:-4px 0 8px">
        ※ 자금일보는 <b>통장에 실제로 오간 금액</b>을 그대로 적습니다. 부가세를 따로 계산하지 마세요.
        (부가세 신고용 계산은 🧾 부가세 화면에서 자동으로 합니다)</p>
      <div class="modal-actions"><button class="btn" id="btn-save-txn" onclick="saveCashTxn()">저장</button></div>
    </div>

    <div class="card">
      <h2>${cashDate} 입출금 내역 (${dayList.length}건)</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>계좌</th><th>구분</th><th>분류</th><th class="num">금액</th><th>적요</th><th>입력자</th><th></th></tr></thead>
        <tbody>${dayList.length ? dayList.map(t => `
          <tr>
            <td>${esc(accName(t.account_id))}</td>
            <td>${t.kind === "입금" ? '<span class="chip approved">입금</span>' : '<span class="chip rejected">출금</span>'}</td>
            <td>${esc(t.category)}</td>
            <td class="num" style="font-weight:700;color:${t.kind === "입금" ? "var(--green)" : "var(--red)"}">
              ${t.kind === "입금" ? "+" : "−"}₩${fmt(t.amount)}</td>
            <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis">${esc(t.memo)}</td>
            <td>${esc(t.created_by)}</td>
            <td><button class="btn sm danger" onclick="deleteCashTxn('${t.id}')">삭제</button></td>
          </tr>`).join("") : `<tr><td colspan="7" class="empty">해당 일자 입출금이 없습니다</td></tr>`}
        </tbody>
      </table></div>
    </div>`;
}

function refreshCashCats() {
  const kind = document.getElementById("c-kind").value;
  const cats = kind === "입금" ? CASH_CATS_IN : CASH_CATS_OUT;
  document.getElementById("c-cat").innerHTML = cats.map(c => `<option>${c}</option>`).join("");
}

function openCashAccountModal(id) {
  const a = id ? cashAccounts.find(x => x.id === id) : null;
  const root = document.getElementById("modal-root");
  root.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal">
        <h3>${a ? "계좌 수정" : "계좌 등록"}</h3>
        <div class="form-grid">
          <div class="field"><label>계좌명 *</label><input id="a-name" value="${esc(a?.name || "")}" placeholder="예) 기업은행 주거래" maxlength="30"></div>
          <div class="field"><label>은행/비고</label><input id="a-bank" value="${esc(a?.bank || "")}" placeholder="예) 기업은행 123-456" maxlength="40"></div>
          <div class="field full"><label>기초잔액(원) *</label><input id="a-balance" type="text" inputmode="numeric" class="comma" value="${a ? fmt(a.initial_balance) : ""}" placeholder="자금일보 시작 시점의 잔액">
            <p style="color:var(--text-sub);font-size:12px;margin-top:4px">자금일보 시작 시점의 통장 잔액입니다. 수정하면 모든 날짜의 잔액이 다시 계산됩니다.</p></div>
        </div>
        <div class="modal-actions" style="justify-content:space-between">
          <span>${a ? `<button class="btn danger" onclick="deleteCashAccount('${a.id}')">계좌 삭제</button>` : ""}</span>
          <span style="display:flex;gap:10px">
            <button class="btn secondary" onclick="closeModal()">취소</button>
            <button class="btn" id="btn-save-acc" onclick="saveCashAccount('${id || ""}')">${a ? "저장" : "등록"}</button>
          </span>
        </div>
      </div>
    </div>`;
}

async function saveCashAccount(id) {
  const name = document.getElementById("a-name").value.trim();
  if (!name) return toast("계좌명을 입력해 주세요");
  const balRaw = document.getElementById("a-balance").value.trim();
  // 비워두면 0으로 저장되어 이후 모든 잔액이 틀어짐
  if (balRaw === "") return toast("기초잔액을 입력해 주세요 (없으면 0을 입력)");
  const data = {
    name,
    bank: document.getElementById("a-bank").value.trim(),
    initial_balance: numOf(balRaw),
  };
  const btn = document.getElementById("btn-save-acc");
  if (btn) btn.disabled = true; // 계좌가 두 번 등록되면 기초잔액이 이중 계상됨
  const res = id
    ? await sb.from("cash_accounts").update(data).eq("id", id).select("id")
    : await sb.from("cash_accounts").insert(data).select("id");
  if (res.error) { if (btn) btn.disabled = false; return toast("저장에 실패했습니다"); }
  if (!res.data?.length) { if (btn) btn.disabled = false; return toast("처리할 계좌를 찾지 못했습니다"); }
  toast(id ? "계좌가 수정되었습니다" : "계좌가 등록되었습니다");
  closeModal();
  route();
}

async function deleteCashAccount(id) {
  const cnt = cashTxns.filter(t => t.account_id === id).length;
  if (!confirm(`이 계좌를 삭제할까요?${cnt ? `\n입출금 내역 ${cnt}건도 함께 삭제됩니다.` : ""}`)) return;
  const { error } = await sb.from("cash_accounts").delete().eq("id", id);
  if (error) return toast("삭제에 실패했습니다");
  toast("계좌가 삭제되었습니다");
  closeModal();
  route();
}

async function saveCashTxn() {
  const amount = numOf(document.getElementById("c-amount").value) || 0;
  if (amount <= 0) return toast("금액을 입력해 주세요");
  const date = document.getElementById("c-date").value;
  if (!date) return toast("일자를 선택해 주세요");
  const kind = document.getElementById("c-kind").value;
  // 아직 오지 않은 날짜 = 실제 거래가 아니라 '예정' — 잔액에 섞이지 않게 계획으로 유도
  if (date > today()) {
    // '취소'가 저장으로 이어지면 안 됨 — 취소는 항상 아무 일도 일어나지 않아야 함
    alert(
      `${date}는 아직 오지 않은 날짜입니다.\n\n`
      + `실제 입출금은 통장에 돈이 오간 뒤에 기록하는 곳입니다.\n`
      + `아직 ${kind === "입금" ? "들어오지" : "나가지"} 않은 돈은 '들어올 돈·나갈 돈(예정)'으로 등록해 주세요.\n\n`
      + `[확인]을 누르면 예정 등록 창이 열립니다.`);
    openPlanModal(kind, {
      date, amount,
      title: document.getElementById("c-memo").value.trim()
        || document.getElementById("c-cat").value
        || (kind === "입금" ? "입금 예정" : "출금 예정"),
    });
    return;
  }
  const accountId = document.getElementById("c-account").value;
  if (!accountId) return toast("계좌를 선택해 주세요");
  const btn = document.getElementById("btn-save-txn");
  if (btn) btn.disabled = true; // 연타로 같은 입출금이 두 번 기록되는 것 방지
  const { error } = await sb.from("cash_txns").insert({
    date,
    account_id: accountId,
    kind,
    category: document.getElementById("c-cat").value,
    amount,
    memo: document.getElementById("c-memo").value.trim(),
    created_by: me.name,
  });
  if (error) { if (btn) btn.disabled = false; return toast("저장에 실패했습니다"); }
  toast("저장되었습니다");
  cashDate = date;
  route();
}

function openPlanModal(kind, preset) {
  const isIn = kind === "입금";
  document.getElementById("modal-root").innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal">
        <h3>${isIn ? "💵 들어올 돈 등록" : "💸 나갈 돈 등록"}</h3>
        <p style="font-size:13px;color:var(--text-sub);margin:4px 0 12px">
          ${isIn
            ? "들어올 예정인 돈 (자본금·정산금 등)"
            : "나갈 예정인 돈 (매입대금·급여·세금 등)"} — 예정 흐름에만 반영됩니다.</p>
        <div class="form-grid">
          <div class="field"><label>${isIn ? "입금" : "출금"} 예정일 *</label>
            <input id="cp-date" type="date" value="${esc(preset?.date || addDaysStr(today(), 7))}"></div>
          <div class="field"><label>금액(원) *</label>
            <input id="cp-amount" type="text" inputmode="numeric" class="comma" value="${cfv(preset?.amount)}" placeholder="0"></div>
          <div class="field full"><label>내용 *</label>
            <input id="cp-title" value="${esc(preset?.title || "")}" maxlength="60"
              placeholder="${isIn ? "예) 자본금 추가 입금" : "예) 한빛유통 매입대금"}"></div>
          <div class="field full"><label>반복</label>
            <select id="cp-repeat">
              <option value="없음">한 번만</option>
              <option value="매월">매월 반복 (급여·임대료 등)</option>
            </select></div>
        </div>
        <div class="modal-actions">
          <button class="btn secondary" onclick="closeModal()">취소</button>
          <button class="btn" id="btn-cp-save" onclick="saveCashPlan('${kind}'${preset?.fromTxnId ? `,'${preset.fromTxnId}'` : ""})">등록</button>
        </div>
      </div>
    </div>`;
  document.getElementById("cp-title").focus();
}

async function saveCashPlan(kind, fromTxnId) {
  const title = document.getElementById("cp-title").value.trim();
  const amount = numOf(document.getElementById("cp-amount").value) || 0;
  const date = document.getElementById("cp-date").value;
  if (!title) return toast("내용을 입력해 주세요");
  if (amount <= 0) return toast("금액을 입력해 주세요");
  if (!date) return toast("예정일을 선택해 주세요");
  const btn = document.getElementById("btn-cp-save");
  if (btn) btn.disabled = true;
  const { error } = await sb.from("cash_plans").insert({
    date, title, amount,
    kind: kind || document.getElementById("cp-kind")?.value || "출금",
    repeat: document.getElementById("cp-repeat").value,
    created_by: me.name,
  });
  if (error) { if (btn) btn.disabled = false; return toast("저장에 실패했습니다"); }
  // 실제 거래에서 옮겨온 경우, 원래 거래는 삭제 (잔액 이중 계산 방지)
  if (fromTxnId) {
    const del = await sb.from("cash_txns").delete().eq("id", fromTxnId).select("id");
    if (del.error || !del.data?.length) {
      closeModal(); route();
      return toast("예정은 등록됐지만 원래 거래가 지워지지 않았습니다 — 실제 거래에서 직접 삭제해 주세요");
    }
  }
  toast(fromTxnId ? "예정으로 옮겼습니다" : "등록되었습니다");
  closeModal();
  route();
}

// 미래 날짜로 잘못 기록된 실제 거래 → 예정으로 이동
function convertTxnToPlan(id) {
  const t = cashTxns.find(x => x.id === id);
  if (!t) return;
  openPlanModal(t.kind, {
    date: t.date, amount: Number(t.amount),
    title: t.memo || t.category || (t.kind === "입금" ? "입금 예정" : "출금 예정"),
    fromTxnId: id,
  });
}

async function deleteCashTxn(id) {
  if (!confirm("이 내역을 삭제할까요?")) return;
  const { error } = await sb.from("cash_txns").delete().eq("id", id);
  if (error) return toast("삭제에 실패했습니다");
  toast("삭제되었습니다");
  route();
}

/* ---------- 화면: 설정 ---------- */
async function viewSettings() {
  const pushSupported = "serviceWorker" in navigator && "PushManager" in window && typeof Notification !== "undefined";
  const perm = pushSupported ? Notification.permission : "unsupported";
  const pushStatus =
    perm === "granted" ? '<span class="chip approved">켜짐</span>' :
    perm === "denied" ? '<span class="chip rejected">차단됨 (브라우저 설정에서 허용 필요)</span>' :
    perm === "unsupported" ? '<span class="chip waiting">미지원</span>' :
    '<span class="chip waiting">꺼짐</span>';
  return `
    <div class="card">
      <h2>비밀번호 변경</h2>
      <p style="color:var(--text-sub);font-size:13px;margin-bottom:12px">
        새 비밀번호는 다음 로그인부터 적용됩니다.
      </p>
      <div class="form-grid">
        <div class="field"><label>새 비밀번호 (6자 이상) *</label>
          <input id="pw-new" type="password" autocomplete="new-password" placeholder="새 비밀번호"></div>
        <div class="field"><label>새 비밀번호 확인 *</label>
          <input id="pw-new2" type="password" autocomplete="new-password" placeholder="한 번 더 입력"></div>
      </div>
      <div class="modal-actions"><button class="btn" id="btn-pw" onclick="changePassword()">비밀번호 변경</button></div>
    </div>

    <div class="card">
      <div class="card-head"><h2>결재 알림</h2>${pushStatus}</div>
      <p style="color:var(--text-sub);font-size:13.5px;margin-bottom:12px">
        결재·승인 알림을 이 기기로 받습니다. 기기마다 한 번 켜 주세요.
        (아이폰: <b>홈 화면에 추가</b> 후)
      </p>
      <button class="btn" onclick="ensurePushSubscribed(true).then(()=>route())">🔔 이 기기에서 알림 켜기</button>
    </div>

    <div class="card">
      <h2>🏢 회사 정보</h2>
      <p style="color:var(--text-sub);font-size:13px;margin-bottom:12px">
        발주서에 찍히는 회사 정보입니다.</p>
      <div class="form-grid">
        <div class="field"><label>상호 *</label><input id="co-name" value="${esc(companyCfg.name)}" maxlength="40"></div>
        <div class="field"><label>사업자등록번호</label><input id="co-biz" value="${esc(companyCfg.biz_no)}" placeholder="000-00-00000" maxlength="20"></div>
        <div class="field"><label>대표자</label><input id="co-ceo" value="${esc(companyCfg.ceo)}" maxlength="20"></div>
        <div class="field"><label>연락처</label><input id="co-phone" value="${esc(companyCfg.phone)}" placeholder="02-000-0000" maxlength="20"></div>
        <div class="field full"><label>주소</label><input id="co-addr" value="${esc(companyCfg.addr)}" maxlength="100"></div>
        <div class="field full"><label>이메일</label><input id="co-email" value="${esc(companyCfg.email)}" maxlength="60"></div>
        <div class="field"><label>광고비율 경보 기준(%) <small style="color:var(--text-sub);font-weight:400">— 매출 대비 광고비</small></label>
          <input id="co-adlimit" type="number" step="0.5" min="0" value="${companyCfg.ad_ratio_limit ?? 15}" placeholder="15"></div>
      </div>
      <div class="modal-actions"><button class="btn" id="btn-co-save" onclick="saveCompanyCfg()">저장</button></div>
    </div>

    <div class="card">
      <h2>🧾 부가세 기준</h2>
      <p style="color:var(--text-sub);font-size:13px;margin-bottom:12px">
        입력 금액에 부가세가 <b>포함되는지</b> 정합니다 — 이익 계산의 기준이 됩니다.</p>
      <div class="form-grid">
        <div class="field"><label>부가세 계산</label>
          <select id="vat-enabled">
            <option value="1" ${vatCfg.enabled ? "selected" : ""}>사용 (일반과세자)</option>
            <option value="0" ${!vatCfg.enabled ? "selected" : ""}>사용 안 함 (간이과세자·면세사업자)</option>
          </select></div>
        <div class="field"><label>제품 마스터의 <b>판매가</b></label>
          <select id="vat-sale">
            <option value="1" ${vatCfg.salePriceIncludesVat ? "selected" : ""}>부가세 포함 (쿠팡·스마트스토어 판매가)</option>
            <option value="0" ${!vatCfg.salePriceIncludesVat ? "selected" : ""}>부가세 별도</option>
          </select></div>
        <div class="field"><label>제품 마스터의 <b>원가</b> · 매입 단가</label>
          <select id="vat-buy">
            <option value="0" ${!vatCfg.purchaseCostIncludesVat ? "selected" : ""}>부가세 별도 (세금계산서 공급가액)</option>
            <option value="1" ${vatCfg.purchaseCostIncludesVat ? "selected" : ""}>부가세 포함</option>
          </select></div>
        <div class="field"><label>수수료 · 배송비 · 광고비</label>
          <select id="vat-exp">
            <option value="1" ${vatCfg.expenseIncludesVat ? "selected" : ""}>부가세 포함 (청구된 금액 그대로)</option>
            <option value="0" ${!vatCfg.expenseIncludesVat ? "selected" : ""}>부가세 별도</option>
          </select></div>
      </div>
      <div style="background:var(--brand-light);border-radius:9px;padding:12px;margin-top:12px;font-size:13px;line-height:1.7">
        <b>예시</b> — 판매가 11,900원(부가세 포함), 원가 5,500원(부가세 별도)일 때<br>
        · 실제 매출(공급가액) = 11,900 ÷ 1.1 = <b>10,818원</b> · 부가세 1,082원은 나중에 납부<br>
        · 이익 = 10,818 − 5,500 = <b>5,318원</b> (부가세를 안 빼면 6,400원으로 <b style="color:#d9480f">1,082원 부풀려짐</b>)
      </div>
      <div class="modal-actions"><button class="btn" id="btn-vat-save" onclick="saveVatCfg()">저장</button></div>
    </div>

    <div class="card">
      <h2>데이터 저장 방식</h2>
      <p style="color:var(--text-sub);font-size:13.5px">
        모든 데이터는 클라우드에 저장되어 전 직원이 공유합니다.
        새로고침하면 최신 내용을 불러옵니다.
      </p>
    </div>

    <div class="card">
      <h2>사용자</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>이름</th><th>부서</th><th>직급</th><th>결재 권한</th></tr></thead>
        <tbody>${USERS.map(u => `
          <tr><td><b>${esc(u.name)}</b>${u.id === me.id ? ' <span class="chip mine">나</span>' : ""}</td>
          <td>${esc(u.dept)}</td><td>${esc(u.role)}</td><td>${u.approver ? "✔" : "—"}</td></tr>`).join("")}
        </tbody>
      </table></div>
      <p style="color:var(--text-sub);font-size:12px;margin-top:10px">
        ※ 본인 비밀번호는 이 화면 위쪽에서 직접 변경할 수 있습니다. 직원 추가·삭제는 관리자에게 요청하세요.
      </p>
    </div>

    <div class="card">
      <h2>데이터 백업</h2>
      <p style="color:var(--text-sub);font-size:13px;margin-bottom:12px">
        모든 데이터를 JSON 파일 하나로 내려받습니다.</p>
      <button class="btn" id="btn-export" onclick="exportJSON()">📤 전체 데이터 내보내기 (JSON)</button>
    </div>`;
}

async function saveCompanyCfg() {
  const name = document.getElementById("co-name").value.trim();
  if (!name) return toast("상호를 입력해 주세요");
  const btn = document.getElementById("btn-co-save");
  if (btn) btn.disabled = true;
  const value = { name,
    biz_no: document.getElementById("co-biz").value.trim(),
    ceo: document.getElementById("co-ceo").value.trim(),
    phone: document.getElementById("co-phone").value.trim(),
    addr: document.getElementById("co-addr").value.trim(),
    email: document.getElementById("co-email").value.trim(),
    ad_ratio_limit: Number(document.getElementById("co-adlimit").value) || 15 };
  const { data, error } = await sb.from("settings")
    .upsert({ key: "company", value, updated_at: new Date().toISOString(), updated_by: me.name },
            { onConflict: "key" }).select("key");
  if (error || !data?.length) { if (btn) btn.disabled = false; return toast("저장에 실패했습니다"); }
  companyCfg = { ...companyCfg, ...value };
  toast("회사 정보가 저장되었습니다");
  route();
}

async function saveVatCfg() {
  const btn = document.getElementById("btn-vat-save");
  if (btn) btn.disabled = true;
  const value = {
    enabled: document.getElementById("vat-enabled").value === "1",
    salePriceIncludesVat: document.getElementById("vat-sale").value === "1",
    purchaseCostIncludesVat: document.getElementById("vat-buy").value === "1",
    expenseIncludesVat: document.getElementById("vat-exp").value === "1",
  };
  const { data, error } = await sb.from("settings")
    .upsert({ key: "vat", value, updated_at: new Date().toISOString(), updated_by: me.name },
            { onConflict: "key" }).select("key");
  if (error || !data?.length) { if (btn) btn.disabled = false; return toast("저장에 실패했습니다"); }
  vatCfg = { ...vatCfg, ...value };
  toast("부가세 기준이 저장되었습니다 — 이익 계산에 바로 반영됩니다");
  route();
}

const BACKUP_TABLES = ["documents", "products", "sales", "purchases", "purchase_costs", "settings",
  "sales_channels", "suppliers", "stock_transfers", "cash_accounts", "cash_txns", "cash_plans",
  "ad_costs", "fixed_costs", "tasks", "ai_reports", "profiles",
  "team_goals", "team_milestones", "purchase_orders", "purchase_order_items", "events"];

async function exportJSON() {
  const btn = document.getElementById("btn-export");
  if (btn) { btn.disabled = true; btn.textContent = "내보내는 중…"; }
  const results = await Promise.all(BACKUP_TABLES.map(t => sb.from(t).select("*")));
  const failed = [];
  const dump = { exportedAt: nowStr() };
  BACKUP_TABLES.forEach((t, i) => {
    if (results[i].error) failed.push(t);
    dump[t] = results[i].data || [];
  });
  if (btn) { btn.disabled = false; btn.textContent = "📤 전체 데이터 내보내기 (JSON)"; }
  // 일부라도 못 읽었으면 '백업했다'고 안심시키면 안 됨
  if (failed.length) {
    return alert(`백업을 만들지 못했습니다.\n\n다음 항목을 읽지 못했습니다: ${failed.join(", ")}\n`
      + `잠시 후 다시 시도해 주세요.`);
  }
  const counts = BACKUP_TABLES.map(t => `${t} ${dump[t].length}`).join(", ");
  downloadFile(JSON.stringify(dump, null, 2), `리버스_전체백업_${today()}.json`, "application/json");
  toast(`백업 완료 (${BACKUP_TABLES.length}개 항목)`);
  console.log("백업 내용:", counts);
}

function downloadFile(content, filename, mime) {
  const blob = new Blob([content], { type: mime + ";charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------- 모바일 사이드바 ---------- */
function closeSidebar() {
  document.getElementById("sidebar").classList.remove("open");
  document.querySelector(".sidebar-backdrop")?.remove();
}
document.getElementById("menu-toggle").addEventListener("click", () => {
  const sb2 = document.getElementById("sidebar");
  sb2.classList.add("open");
  const bd = document.createElement("div");
  bd.className = "sidebar-backdrop";
  bd.onclick = closeSidebar;
  document.body.appendChild(bd);
});

/* ---------- 시작 ---------- */
document.getElementById("btn-logout").addEventListener("click", logout);
window.addEventListener("hashchange", route);
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => { /* 미지원 환경 무시 */ });
}
boot();
