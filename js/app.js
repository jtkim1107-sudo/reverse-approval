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

const VAPID_PUBLIC_KEY = "BDGjrHCi-tBEuRwLkJ5HGtuB32VcQNwF69x1T0XJZy4QyUsO7D9RlWEfbVaXL-qQXI9S9JgRGJikX4DkdBFqbf4";

const ACCOUNTS = ["복리후생비", "여비교통비", "접대비", "소모품비", "지급수수료", "광고선전비", "통신비", "차량유지비", "교육훈련비", "기타"];
const PAY_METHODS = ["법인카드", "개인카드(환급)", "계좌이체", "현금"];

/* ---------- 전역 상태 ---------- */
let me = null;      // 내 프로필 {id, name, dept, role, approver}
let USERS = [];     // 전체 프로필
let loginTarget = null;

/* ---------- 유틸 ---------- */
const fmt = n => (Number(n) || 0).toLocaleString("ko-KR");
const pad2 = n => String(n).padStart(2, "0");
// 한국 시간 기준 날짜 (toISOString은 UTC라 오전 9시 이전에 전날로 기록되는 문제가 있음)
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
const nowStr = () => {
  const d = new Date();
  return `${today()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const localDT = ts => {
  const d = new Date(ts);
  if (isNaN(d)) return "";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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

async function showLogin() {
  document.getElementById("app").classList.add("hidden");
  const { data: profiles, error } = await sb.from("profiles").select("*").order("name");
  const box = document.getElementById("login-users");
  if (error || !profiles?.length) {
    box.innerHTML = `<p style="color:var(--red);font-size:13px">서버 연결에 실패했습니다. 잠시 후 새로고침 해주세요.</p>`;
  } else {
    USERS = profiles;
    box.innerHTML = profiles.map(u => `
      <button class="login-user-btn" onclick="pickUser('${u.id}')">
        <span class="avatar">${esc(u.name[0])}</span>
        <span><b>${esc(u.name)}</b><small>${esc(u.dept)} · ${esc(u.role)}</small></span>
      </button>`).join("");
  }
  document.getElementById("login-screen").classList.remove("hidden");
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
  sales: { title: "매출 입력·조회", render: viewSales, after: () => addSaleRow() },
  purchases: { title: "매입 입력·조회", render: viewPurchases, after: () => addBuyRow() },
  inventory: { title: "재고 현황", render: viewInventory },
  report: { title: "월별 리포트", render: viewReport },
  cash: { title: "자금일보", render: viewCash },
  tasks: { title: "업무 지시", render: viewTasks },
  aireport: { title: "AI 리포트", render: viewAiReport },
  settings: { title: "설정 · 알림", render: viewSettings },
  doc: { title: "문서 상세", render: viewDocDetail },
};

let routeSeq = 0;
async function route() {
  if (!me) return;
  const seq = ++routeSeq;
  const hash = location.hash.replace(/^#\//, "") || "dashboard";
  const [name, param] = hash.split("/");
  const r = routes[name] || routes.dashboard;
  document.getElementById("page-title").textContent = r.title;
  document.querySelectorAll(".nav-item").forEach(el =>
    el.classList.toggle("active", el.dataset.route === name));
  const content = document.getElementById("content");
  content.innerHTML = `<div class="card" style="color:var(--text-sub)">불러오는 중…</div>`;
  const html = await r.render(param);
  if (seq !== routeSeq) return; // 다른 페이지로 이동한 경우 무시
  content.innerHTML = html;
  if (r.after) r.after(param);
  updateBadge();
  closeSidebar();
  window.scrollTo(0, 0);
}

/* ---------- 화면: 대시보드 ---------- */
async function viewDashboard() {
  const [docs, prodRes, saleRes, buyRes, taskRes, costRes] = await Promise.all([
    fetchDocs(),
    sb.from("products").select("*").order("updated_at", { ascending: false }).limit(5),
    sb.from("sales").select("amount,date"),
    sb.from("purchases").select("amount,date"),
    sb.from("tasks").select("assignee_id,status"),
    sb.from("purchase_costs").select("amount,date"),
  ]);
  const myTasks = (taskRes.data || []).filter(t => t.assignee_id === me.id && t.status === "open").length;
  const products = prodRes.data || [];
  const nowMonth = today().slice(0, 7);
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
        조직도상 상위 결재자가 없으므로 <b>상신 즉시 전결(자동 승인)</b> 처리됩니다.
      </p>` : `
      <p style="color:var(--text-sub);font-size:13px;margin-bottom:10px">조직도상 윗사람에게 순서대로 결재가 진행됩니다.</p>
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
    <td><input class="i-amt amount" type="number" min="0" step="1" placeholder="0" oninput="calcTotal()"></td>
    <td><button class="btn-row-del" title="삭제" onclick="this.closest('tr').remove();calcTotal()">✕</button></td>`;
  tbody.appendChild(tr);
}
function calcTotal() {
  const total = [...document.querySelectorAll(".i-amt")].reduce((s, el) => s + (Number(el.value) || 0), 0);
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
    amount: Number(tr.querySelector(".i-amt").value) || 0,
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
    <thead><tr><th>제품코드</th><th>제품명</th><th>구분</th><th>분류</th><th>규격</th><th>단위</th><th class="num">단가</th><th>메모</th><th>최종수정</th><th></th></tr></thead>
    <tbody>${list.map(p => `
      <tr>
        <td>${esc(p.code)}</td>
        <td><b>${esc(p.name)}</b></td>
        <td>${(p.trade_type || "사입") === "위탁"
          ? '<span class="chip waiting">위탁</span>'
          : '<span class="chip mine">사입</span>'}</td>
        <td>${esc(p.category)}</td>
        <td>${esc(p.spec)}</td>
        <td>${esc(p.unit)}</td>
        <td class="num">₩${fmt(p.price)}</td>
        <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis">${esc(p.memo)}</td>
        <td>${esc(p.updated_at)}<br><small style="color:var(--text-sub)">${esc(p.updated_by || "")}</small></td>
        <td>
          <button class="btn sm secondary" onclick="openProductModal('${p.id}')">수정</button>
          <button class="btn sm danger" onclick="deleteProduct('${p.id}')">삭제</button>
        </td>
      </tr>`).join("")}
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
            <select id="p-type">
              <option value="사입" ${(p?.trade_type || "사입") === "사입" ? "selected" : ""}>사입 (직접 재고 보유)</option>
              <option value="위탁" ${p?.trade_type === "위탁" ? "selected" : ""}>위탁 (공급처 직배송)</option>
            </select></div>
          <div class="field full"><label>제품명 *</label><input id="p-name" value="${esc(p?.name || "")}" maxlength="60"></div>
          <div class="field"><label>분류</label><input id="p-cat" value="${esc(p?.category || "")}" placeholder="예) 건강식품" maxlength="30"></div>
          <div class="field"><label>규격</label><input id="p-spec" value="${esc(p?.spec || "")}" placeholder="예) 30g x 10입" maxlength="40"></div>
          <div class="field"><label>단위</label><input id="p-unit" value="${esc(p?.unit || "")}" placeholder="BOX / EA / 병" maxlength="10"></div>
          <div class="field"><label>단가(원)</label><input id="p-price" type="number" min="0" value="${p?.price ?? ""}"></div>
          <div class="field full"><label>메모</label><textarea id="p-memo">${esc(p?.memo || "")}</textarea></div>
        </div>
        <div class="modal-actions">
          <button class="btn secondary" onclick="closeModal()">취소</button>
          <button class="btn" onclick="saveProduct('${id || ""}')">저장</button>
        </div>
      </div>
    </div>`;
}
function closeModal() { document.getElementById("modal-root").innerHTML = ""; }

async function saveProduct(id) {
  const code = document.getElementById("p-code").value.trim();
  const name = document.getElementById("p-name").value.trim();
  if (!code || !name) return toast("제품코드와 제품명은 필수입니다");

  const data = {
    code, name,
    trade_type: document.getElementById("p-type").value,
    category: document.getElementById("p-cat").value.trim(),
    spec: document.getElementById("p-spec").value.trim(),
    unit: document.getElementById("p-unit").value.trim(),
    price: Number(document.getElementById("p-price").value) || 0,
    memo: document.getElementById("p-memo").value.trim(),
    updated_at: today(),
    updated_by: me.name,
  };
  const res = id
    ? await sb.from("products").update(data).eq("id", id)
    : await sb.from("products").insert(data);
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
  if (!confirm(`'${p.name}' 제품을 삭제할까요?`)) return;
  const { error } = await sb.from("products").delete().eq("id", id);
  if (error) return toast("삭제에 실패했습니다");
  prodCache = prodCache.filter(x => x.id !== id);
  refreshProductTable();
  toast("삭제되었습니다");
}

function exportProductsCSV() {
  const head = ["제품코드", "제품명", "분류", "규격", "단위", "단가", "메모", "최종수정일", "수정자"];
  const rows = prodCache.map(p =>
    [p.code, p.name, p.category, p.spec, p.unit, p.price, p.memo, p.updated_at, p.updated_by || ""]);
  const csv = "﻿" + [head, ...rows]
    .map(r => r.map(c => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
  downloadFile(csv, `리버스_제품마스터_${today()}.csv`, "text/csv");
}

/* ==================== ERP: 매출 / 매입 / 재고 / 리포트 ==================== */
const CHANNELS = ["스마트스토어", "쿠팡", "자사몰", "오픈마켓", "기타"];
let erpChannelList = [];  // sales_channels 테이블
let erpMonth = today().slice(0, 7);
let erpProducts = [];
let erpStock = {};      // product_id → {stock, lastCost}
let erpRowsCache = [];  // 현재 목록 캐시 (수정 모달용)
let erpCostsCache = []; // 부대비용(택배·운송) 캐시
let erpSuppliers = [];
let erpChannels = [];

const prodName = id => (erpProducts.find(p => p.id === id) || {}).name || "?";
const monthOf = r => (r.date || "").slice(0, 7);

/* 제품·재고·거래처·채널 공통 로드 */
async function loadErpBase() {
  const [prodRes, buyRes, saleRes, costRes, chRes] = await Promise.all([
    sb.from("products").select("*").order("name"),
    sb.from("purchases").select("*").order("date", { ascending: false }).order("created_at", { ascending: false }),
    sb.from("sales").select("*").order("date", { ascending: false }).order("created_at", { ascending: false }),
    sb.from("purchase_costs").select("*").order("date", { ascending: false }).order("created_at", { ascending: false }),
    sb.from("sales_channels").select("*").order("created_at"),
  ]);
  erpProducts = prodRes.data || [];
  const buys = buyRes.data || [];
  const sales = saleRes.data || [];
  const costs = costRes.data || [];
  erpChannelList = chRes.data || [];
  erpStock = {};
  erpProducts.forEach(p => {
    const myBuys = buys.filter(b => b.product_id === p.id);
    const bought = myBuys.reduce((s, b) => s + Number(b.qty), 0);
    const sold = sales.filter(x => x.product_id === p.id).reduce((s, x) => s + Number(x.qty), 0);
    erpStock[p.id] = { stock: bought - sold, lastCost: myBuys.length ? Number(myBuys[0].unit_cost) : 0 };
  });
  erpSuppliers = [...new Set([...buys.map(b => b.supplier), ...costs.map(c => c.supplier)].filter(Boolean))];
  // 채널 목록: 등록된 채널 + 과거 매출에 쓰인 채널
  erpChannels = [...new Set([...erpChannelList.map(c => c.name), ...sales.map(s => s.channel).filter(Boolean)])];
  return { buys, sales, costs };
}

const tradeTypeOf = p => (p?.trade_type || "사입");
const tradeTypeOfId = id => tradeTypeOf(erpProducts.find(p => p.id === id));

function productOptions(sel, mode) {
  // 매입은 사입 상품만 대상 (위탁은 우리가 사입하지 않음)
  const list = mode === "buy" ? erpProducts.filter(p => tradeTypeOf(p) === "사입") : erpProducts;
  return `<option value="">품목 선택</option>` + list.map(p => {
    const tag = tradeTypeOf(p) === "위탁" ? "위탁" : `재고 ${fmt(erpStock[p.id]?.stock || 0)}`;
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
        <button class="btn sm secondary" onclick="addSaleRow()">＋ 품목 추가</button></div>
      <div class="form-grid" style="margin-bottom:10px">
        <div class="field"><label>판매일 *</label><input id="s-date" type="date" value="${today()}"></div>
        <div class="field"><label>판매 채널
          <a onclick="location.hash='#/channels'" style="color:var(--brand);font-size:12px;cursor:pointer;font-weight:400">＋채널 관리</a></label>
          <select id="s-channel">
            ${erpChannels.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join("")}
            <option value="기타">기타</option>
          </select></div>
      </div>
      <div class="table-wrap"><table class="items-table">
        <thead><tr><th style="min-width:190px">품목 (현재 재고)</th><th style="width:85px" class="num">수량</th><th style="width:115px" class="num">단가(원)</th><th style="width:110px" class="num">금액</th><th>적요</th><th style="width:40px"></th></tr></thead>
        <tbody id="sale-rows"></tbody>
      </table></div>
      <div class="total-line">합계 <b id="s-total">₩0</b></div>
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
    <td><select class="sr-prod" onchange="onSaleRowProduct(this)">${productOptions()}</select></td>
    <td><input class="sr-qty" type="number" min="1" value="1" oninput="calcSalesTotal()"></td>
    <td><input class="sr-price" type="number" min="0" placeholder="0" oninput="calcSalesTotal()"></td>
    <td class="num sr-amt" style="font-weight:700">₩0</td>
    <td><input class="sr-memo" placeholder="주문번호 등" maxlength="100"></td>
    <td><button class="btn-row-del" title="삭제" onclick="this.closest('tr').remove();calcSalesTotal()">✕</button></td>`;
  tbody.appendChild(tr);
}
function onSaleRowProduct(sel) {
  const p = erpProducts.find(x => x.id === sel.value);
  if (p) sel.closest("tr").querySelector(".sr-price").value = p.price || "";
  calcSalesTotal();
}
function calcSalesTotal() {
  let total = 0;
  document.querySelectorAll("#sale-rows tr").forEach(tr => {
    const amt = (Number(tr.querySelector(".sr-qty").value) || 0) * (Number(tr.querySelector(".sr-price").value) || 0);
    tr.querySelector(".sr-amt").textContent = "₩" + fmt(amt);
    total += amt;
  });
  const el = document.getElementById("s-total");
  if (el) el.textContent = "₩" + fmt(total);
}

async function saveSales() {
  const date = document.getElementById("s-date").value;
  const channel = document.getElementById("s-channel").value.trim() || "기타";
  if (!date) return toast("판매일을 선택해 주세요");
  const recs = [];
  let stockWarn = "";
  for (const tr of document.querySelectorAll("#sale-rows tr")) {
    const pid = tr.querySelector(".sr-prod").value;
    const qty = Number(tr.querySelector(".sr-qty").value) || 0;
    const price = Number(tr.querySelector(".sr-price").value) || 0;
    if (!pid && !price) continue; // 빈 줄은 건너뜀
    if (!pid) return toast("품목을 선택해 주세요");
    if (qty <= 0) return toast("수량은 1 이상이어야 합니다");
    const st = erpStock[pid]?.stock ?? 0;
    if (tradeTypeOfId(pid) === "사입" && qty > st) stockWarn = `'${prodName(pid)}' 재고(${fmt(st)})보다 많은 수량(${fmt(qty)})입니다.`;
    recs.push({ date, channel, product_id: pid, qty, unit_price: price, amount: qty * price,
      memo: tr.querySelector(".sr-memo").value.trim(), created_by: me.name });
  }
  if (!recs.length) return toast("품목을 1개 이상 입력해 주세요");
  if (stockWarn && !confirm(stockWarn + "\n그래도 저장할까요?")) return;
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
        <button class="btn sm secondary" onclick="addBuyRow()">＋ 품목 추가</button></div>
      <div class="form-grid" style="margin-bottom:10px">
        <div class="field"><label>매입일 *</label><input id="b-date" type="date" value="${today()}"></div>
        <div class="field"><label>거래처</label>
          <input id="b-supplier" list="supplier-list" placeholder="거래처 입력 또는 선택" maxlength="40">
          <datalist id="supplier-list">${erpSuppliers.map(s => `<option value="${esc(s)}">`).join("")}</datalist></div>
        <div class="field"><label>택배비(원) — 상품값과 별도</label><input id="b-ship" type="number" min="0" placeholder="0"></div>
        <div class="field"><label>운송비(원) — 상품값과 별도</label><input id="b-freight" type="number" min="0" placeholder="0"></div>
      </div>
      <div class="table-wrap"><table class="items-table">
        <thead><tr><th style="min-width:190px">품목 (현재 재고)</th><th style="width:85px" class="num">수량</th><th style="width:115px" class="num">단가(원)</th><th style="width:110px" class="num">금액</th><th>적요</th><th style="width:40px"></th></tr></thead>
        <tbody id="buy-rows"></tbody>
      </table></div>
      <div class="total-line">상품 합계 <b id="b-total">₩0</b></div>
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
        <thead><tr><th>매입일</th><th>품목</th><th>거래처</th><th class="num">수량</th><th class="num">단가</th><th class="num">금액</th><th>적요</th><th>입력자</th><th></th></tr></thead>
        <tbody>${rows.length ? rows.map(r => `
          <tr>
            <td>${esc(r.date)}</td>
            <td><b>${esc(prodName(r.product_id))}</b></td>
            <td>${esc(r.supplier)}</td>
            <td class="num">${fmt(r.qty)}</td>
            <td class="num">₩${fmt(r.unit_cost)}</td>
            <td class="num"><b>₩${fmt(r.amount)}</b></td>
            <td style="max-width:140px;overflow:hidden;text-overflow:ellipsis">${esc(r.memo)}</td>
            <td>${esc(r.created_by)}</td>
            <td style="white-space:nowrap">
              <button class="btn sm secondary" onclick="openErpEditModal('purchases','${r.id}')">수정</button>
              <button class="btn sm danger" onclick="deleteErpRow('purchases','${r.id}')">삭제</button></td>
          </tr>`).join("") : `<tr><td colspan="9" class="empty">${erpMonth}월 매입이 없습니다</td></tr>`}
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
    <td><select class="br-prod" onchange="onBuyRowProduct(this)">${productOptions("", "buy")}</select></td>
    <td><input class="br-qty" type="number" min="1" value="1" oninput="calcBuysTotal()"></td>
    <td><input class="br-cost" type="number" min="0" placeholder="0" oninput="calcBuysTotal()"></td>
    <td class="num br-amt" style="font-weight:700">₩0</td>
    <td><input class="br-memo" placeholder="발주번호 등" maxlength="100"></td>
    <td><button class="btn-row-del" title="삭제" onclick="this.closest('tr').remove();calcBuysTotal()">✕</button></td>`;
  tbody.appendChild(tr);
}
function onBuyRowProduct(sel) {
  // 해당 품목의 최근 매입단가 자동 입력
  const st = erpStock[sel.value];
  if (st?.lastCost) sel.closest("tr").querySelector(".br-cost").value = st.lastCost;
  calcBuysTotal();
}
function calcBuysTotal() {
  let total = 0;
  document.querySelectorAll("#buy-rows tr").forEach(tr => {
    const amt = (Number(tr.querySelector(".br-qty").value) || 0) * (Number(tr.querySelector(".br-cost").value) || 0);
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
  const ship = Number(document.getElementById("b-ship").value) || 0;
  const freight = Number(document.getElementById("b-freight").value) || 0;
  const recs = [];
  for (const tr of document.querySelectorAll("#buy-rows tr")) {
    const pid = tr.querySelector(".br-prod").value;
    const qty = Number(tr.querySelector(".br-qty").value) || 0;
    const cost = Number(tr.querySelector(".br-cost").value) || 0;
    if (!pid && !cost) continue;
    if (!pid) return toast("품목을 선택해 주세요");
    if (qty <= 0) return toast("수량은 1 이상이어야 합니다");
    recs.push({ date, supplier, product_id: pid, qty, unit_cost: cost, amount: qty * cost,
      memo: tr.querySelector(".br-memo").value.trim(), created_by: me.name });
  }
  if (!recs.length && !ship && !freight) return toast("품목 또는 부대비용을 입력해 주세요");
  const btn = document.getElementById("btn-save-buys");
  btn.disabled = true;
  if (recs.length) {
    const { error } = await sb.from("purchases").insert(recs);
    if (error) { btn.disabled = false; return toast("저장에 실패했습니다"); }
  }
  // 택배비·운송비는 별도 테이블에 분리 저장
  const costRecs = [];
  if (ship > 0) costRecs.push({ date, kind: "택배비", amount: ship, supplier, created_by: me.name });
  if (freight > 0) costRecs.push({ date, kind: "운송비", amount: freight, supplier, created_by: me.name });
  if (costRecs.length) {
    const { error: e2 } = await sb.from("purchase_costs").insert(costRecs);
    if (e2) { btn.disabled = false; return toast("부대비용 저장에 실패했습니다"); }
  }
  toast(`저장되었습니다 (상품 ${recs.length}건${costRecs.length ? ", 부대비용 " + costRecs.length + "건" : ""})`);
  erpMonth = date.slice(0, 7);
  route();
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
              : `<input id="e-party" list="supplier-list" value="${esc(r.supplier)}">`}</div>
          <div class="field full"><label>품목</label><select id="e-prod">${productOptions(r.product_id, isSale ? "" : "buy")}</select></div>
          <div class="field"><label>수량</label><input id="e-qty" type="number" min="1" value="${r.qty}"></div>
          <div class="field"><label>단가(원)</label><input id="e-price" type="number" min="0" value="${isSale ? r.unit_price : r.unit_cost}"></div>
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
  const pid = document.getElementById("e-prod").value;
  const qty = Number(document.getElementById("e-qty").value) || 0;
  const price = Number(document.getElementById("e-price").value) || 0;
  if (!pid) return toast("품목을 선택해 주세요");
  if (qty <= 0) return toast("수량은 1 이상이어야 합니다");
  const patch = {
    date: document.getElementById("e-date").value,
    product_id: pid, qty, amount: qty * price,
    memo: document.getElementById("e-memo").value.trim(),
  };
  const party = document.getElementById("e-party").value.trim();
  if (isSale) { patch.unit_price = price; patch.channel = party || "기타"; }
  else { patch.unit_cost = price; patch.supplier = party; }
  const { error } = await sb.from(table).update(patch).eq("id", id);
  if (error) return toast("수정에 실패했습니다");
  toast("수정되었습니다");
  closeModal();
  route();
}

async function deleteErpRow(table, id) {
  if (!confirm("이 내역을 삭제할까요?")) return;
  const { error } = await sb.from(table).delete().eq("id", id);
  if (error) return toast("삭제에 실패했습니다");
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

/* ---------- 재고 현황 ---------- */
async function viewInventory() {
  const { buys, sales } = await loadErpBase();

  // 재고 관리는 사입 상품만 (위탁은 공급처 재고)
  const stockProducts = erpProducts.filter(p => tradeTypeOf(p) === "사입");
  const consignCount = erpProducts.length - stockProducts.length;
  const inv = stockProducts.map(p => {
    const bought = buys.filter(b => b.product_id === p.id).reduce((s, b) => s + Number(b.qty), 0);
    const sold = sales.filter(x => x.product_id === p.id).reduce((s, x) => s + Number(x.qty), 0);
    const st = erpStock[p.id] || { stock: 0, lastCost: 0 };
    return { p, bought, sold, stock: st.stock, lastCost: st.lastCost, value: st.stock * st.lastCost };
  });
  const totalValue = inv.reduce((s, r) => s + r.value, 0);

  return `
    <div class="grid-stats">
      <div class="stat"><div class="stat-label">재고 평가액 (최근 매입가 기준)</div>
        <div class="stat-value blue">₩${fmt(totalValue)}</div></div>
      <div class="stat"><div class="stat-label">사입 제품</div>
        <div class="stat-value">${stockProducts.length}종</div></div>
      <div class="stat" onclick="location.hash='#/products'"><div class="stat-label">위탁 제품 (재고 관리 제외)</div>
        <div class="stat-value amber">${consignCount}종</div></div>
    </div>
    <div class="card">
      <div class="card-head"><h2>제품별 재고</h2>
        <button class="btn sm secondary" onclick="location.hash='#/purchases'">＋ 매입 입력</button></div>
      <div class="table-wrap"><table>
        <thead><tr><th>제품</th><th class="num">총 매입</th><th class="num">총 판매</th><th class="num">현재 재고</th><th class="num">최근 매입단가</th><th class="num">재고 금액</th></tr></thead>
        <tbody>${inv.length ? inv.map(r => `
          <tr>
            <td><b>${esc(r.p.name)}</b><br><small style="color:var(--text-sub)">${esc(r.p.code)} · ${esc(r.p.spec)}</small></td>
            <td class="num">${fmt(r.bought)}</td>
            <td class="num">${fmt(r.sold)}</td>
            <td class="num" style="font-weight:800;color:${r.stock < 0 ? "var(--red)" : r.stock <= 5 ? "var(--amber)" : "var(--text)"}">${fmt(r.stock)}</td>
            <td class="num">₩${fmt(r.lastCost)}</td>
            <td class="num">₩${fmt(r.value)}</td>
          </tr>`).join("") : `<tr><td colspan="6" class="empty">제품이 없습니다</td></tr>`}
        </tbody>
      </table></div>
      <p style="color:var(--text-sub);font-size:12px;margin-top:10px">
        ※ 재고 = 매입 수량 − 판매 수량. 재고가 음수면 매입 입력이 누락된 것입니다.<br>
        ※ 위탁 상품은 공급처가 재고·배송을 관리하므로 이 화면에 표시되지 않습니다.
      </p>
    </div>`;
}

/* ---------- 월별 리포트 ---------- */
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

/* ---------- 판매채널 · SCM 계정 ---------- */
async function viewChannels() {
  const { data } = await sb.from("sales_channels").select("*").order("created_at");
  const list = data || [];
  return `
    <div class="card">
      <div class="card-head"><h2>판매채널 · SCM 계정 (${list.length}개)</h2>
        <button class="btn sm" onclick="openChannelModal()">＋ 채널 추가</button></div>
      <p style="color:var(--text-sub);font-size:13px;margin-bottom:12px">
        판매 채널과 각 채널 관리시스템(SCM)의 접속 정보를 관리합니다. 여기 등록한 채널이 매출 입력 시 선택지로 나옵니다.<br>
        ⚠️ 비밀번호는 로그인한 직원이 볼 수 있으니, 이 앱의 로그인 비밀번호를 잘 관리하세요.
      </p>
      <div class="table-wrap"><table>
        <thead><tr><th>채널명</th><th>사이트</th><th>아이디</th><th>비밀번호</th><th>메모</th><th></th></tr></thead>
        <tbody>${list.length ? list.map(c => `
          <tr>
            <td><b>${esc(c.name)}</b></td>
            <td>${c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener" style="color:var(--brand)">바로가기 ↗</a>` : "—"}</td>
            <td>${c.login_id ? `${esc(c.login_id)} <button class="btn-ghost" style="font-size:12px" title="복사" onclick="copyText('${esc(c.login_id)}')">📋</button>` : "—"}</td>
            <td>${c.login_pw
              ? `<span id="pw-${c.id}" data-pw="${esc(c.login_pw)}">••••••</span>
                 <button class="btn-ghost" style="font-size:12px" title="보기" onclick="togglePw('${c.id}')">👁</button>
                 <button class="btn-ghost" style="font-size:12px" title="복사" onclick="copyText('${esc(c.login_pw)}')">📋</button>`
              : "—"}</td>
            <td style="max-width:150px;overflow:hidden;text-overflow:ellipsis">${esc(c.memo)}</td>
            <td style="white-space:nowrap">
              <button class="btn sm secondary" onclick="openChannelModal('${c.id}')">수정</button>
              <button class="btn sm danger" onclick="deleteChannel('${c.id}')">삭제</button></td>
          </tr>`).join("") : `<tr><td colspan="6" class="empty">등록된 채널이 없습니다</td></tr>`}
        </tbody>
      </table></div>
    </div>`;
}

let channelCache = [];
function togglePw(id) {
  const el = document.getElementById("pw-" + id);
  if (!el) return;
  const shown = el.textContent !== "••••••";
  el.textContent = shown ? "••••••" : el.dataset.pw;
}
function copyText(t) {
  navigator.clipboard.writeText(t).then(() => toast("복사되었습니다")).catch(() => toast("복사 실패"));
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
          <div class="field full"><label>메모</label><textarea id="ch-memo" maxlength="200">${esc(c?.memo || "")}</textarea></div>
        </div>
        <div class="modal-actions">
          <button class="btn secondary" onclick="closeModal()">취소</button>
          <button class="btn" onclick="saveChannel('${id || ""}')">저장</button>
        </div>
      </div>
    </div>`;
}

async function saveChannel(id) {
  const name = document.getElementById("ch-name").value.trim();
  if (!name) return toast("채널명을 입력해 주세요");
  const data = {
    name,
    url: document.getElementById("ch-url").value.trim(),
    login_id: document.getElementById("ch-id").value.trim(),
    login_pw: document.getElementById("ch-pw").value,
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
  if (!confirm("이 채널을 삭제할까요? (기존 매출 기록은 그대로 유지됩니다)")) return;
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
        아직 생성된 리포트가 없습니다. <b>매일 아침 8시</b>에 어제 매출·재고·결재·업무·자금을 자동 분석해서
        이상징후와 함께 리포트를 만들어 알림으로 보내드립니다.
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
      <div class="card-head"><h2>📥 내가 받은 지시 (${myOpen.length}건)</h2></div>
      <div class="table-wrap"><table>
        <thead><tr><th>내용</th><th>지시자</th><th>기한</th><th>받은 날</th><th></th></tr></thead>
        <tbody>${myOpen.length ? myOpen.map(t => `
          <tr>
            <td><b>${esc(t.title)}</b>${t.detail ? `<br><small style="color:var(--text-sub)">${esc(t.detail)}</small>` : ""}</td>
            <td>${userName(t.creator_id)}</td>
            <td>${dday(t.due_date) || "—"}</td>
            <td>${esc(localDT(t.created_at).slice(0, 10))}</td>
            <td><button class="btn sm green" onclick="completeTask('${t.id}')">✔ 완료</button></td>
          </tr>`).join("") : `<tr><td colspan="5" class="empty">받은 지시가 없습니다 👍</td></tr>`}
        </tbody>
      </table></div>
    </div>

    <div class="card">
      <div class="card-head"><h2>📤 내가 시킨 일 (${iAssigned.filter(t => t.status === "open").length}건 진행 중)</h2></div>
      <div class="table-wrap"><table>
        <thead><tr><th>내용</th><th>담당자</th><th>기한</th><th>상태</th><th></th></tr></thead>
        <tbody>${iAssigned.length ? iAssigned.map(t => `
          <tr>
            <td><b>${esc(t.title)}</b>${t.detail ? `<br><small style="color:var(--text-sub)">${esc(t.detail)}</small>` : ""}</td>
            <td>${userName(t.assignee_id)}</td>
            <td>${dday(t.due_date) || "—"}</td>
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
  toast("완료 처리되었습니다 (지시자에게 알림)");
  route();
}

async function deleteTask(id) {
  if (!confirm("이 지시를 삭제할까요?")) return;
  const { error } = await sb.from("tasks").delete().eq("id", id);
  if (error) return toast("삭제에 실패했습니다");
  toast("삭제되었습니다");
  route();
}

/* ---------- 자금일보 ---------- */
const CASH_CATS_IN = ["판매대금", "정산금", "대표 입금", "기타 입금"];
const CASH_CATS_OUT = ["매입대금", "경비", "광고비", "급여", "세금·공과", "기타 출금"];
let cashDate = today();
let cashAccounts = [];
let cashTxns = [];

async function viewCash() {
  const [accRes, txnRes] = await Promise.all([
    sb.from("cash_accounts").select("*").order("created_at"),
    sb.from("cash_txns").select("*").order("date").order("created_at"),
  ]);
  cashAccounts = accRes.data || [];
  cashTxns = txnRes.data || [];

  if (!cashAccounts.length) {
    return `
      <div class="card">
        <h2>자금일보 시작하기</h2>
        <p style="color:var(--text-sub);font-size:13.5px;margin-bottom:14px">
          먼저 관리할 계좌를 등록하세요. <b>기초잔액</b>은 자금일보를 시작하는 시점의 계좌 잔액입니다.<br>
          이후 매일 입금·출금만 입력하면 잔액이 자동 계산됩니다.
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

  return `
    <div class="grid-stats">
      <div class="stat"><div class="stat-label">${cashDate} 총 잔액</div>
        <div class="stat-value blue">₩${fmt(tot.bal)}</div></div>
      <div class="stat"><div class="stat-label">당일 입금</div>
        <div class="stat-value green">₩${fmt(tot.dayIn)}</div></div>
      <div class="stat"><div class="stat-label">당일 출금</div>
        <div class="stat-value red">₩${fmt(tot.dayOut)}</div></div>
    </div>

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

    <div class="card">
      <h2>입출금 입력</h2>
      <div class="form-grid">
        <div class="field"><label>일자</label><input id="c-date" type="date" value="${cashDate}"></div>
        <div class="field"><label>계좌 *</label>
          <select id="c-account">${cashAccounts.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join("")}</select></div>
        <div class="field"><label>구분 *</label>
          <select id="c-kind" onchange="refreshCashCats()">
            <option value="입금">입금 (+)</option>
            <option value="출금">출금 (−)</option>
          </select></div>
        <div class="field"><label>분류</label>
          <select id="c-cat">${CASH_CATS_IN.map(c => `<option>${c}</option>`).join("")}</select></div>
        <div class="field"><label>금액(원) *</label><input id="c-amount" type="number" min="1" placeholder="0"></div>
        <div class="field"><label>적요</label><input id="c-memo" placeholder="예) 쿠팡 정산, OO상사 대금" maxlength="100"></div>
      </div>
      <div class="modal-actions"><button class="btn" onclick="saveCashTxn()">저장</button></div>
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
          <div class="field full"><label>기초잔액(원) *</label><input id="a-balance" type="number" value="${a ? Number(a.initial_balance) : ""}" placeholder="자금일보 시작 시점의 잔액">
            <p style="color:var(--text-sub);font-size:12px;margin-top:4px">자금일보 시작 시점의 통장 잔액입니다. 수정하면 모든 날짜의 잔액이 다시 계산됩니다.</p></div>
        </div>
        <div class="modal-actions" style="justify-content:space-between">
          <span>${a ? `<button class="btn danger" onclick="deleteCashAccount('${a.id}')">계좌 삭제</button>` : ""}</span>
          <span style="display:flex;gap:10px">
            <button class="btn secondary" onclick="closeModal()">취소</button>
            <button class="btn" onclick="saveCashAccount('${id || ""}')">${a ? "저장" : "등록"}</button>
          </span>
        </div>
      </div>
    </div>`;
}

async function saveCashAccount(id) {
  const name = document.getElementById("a-name").value.trim();
  if (!name) return toast("계좌명을 입력해 주세요");
  const data = {
    name,
    bank: document.getElementById("a-bank").value.trim(),
    initial_balance: Number(document.getElementById("a-balance").value) || 0,
  };
  const res = id
    ? await sb.from("cash_accounts").update(data).eq("id", id)
    : await sb.from("cash_accounts").insert(data);
  if (res.error) return toast("저장에 실패했습니다");
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
  const amount = Number(document.getElementById("c-amount").value) || 0;
  if (amount <= 0) return toast("금액을 입력해 주세요");
  const date = document.getElementById("c-date").value;
  if (!date) return toast("일자를 선택해 주세요");
  const { error } = await sb.from("cash_txns").insert({
    date,
    account_id: document.getElementById("c-account").value,
    kind: document.getElementById("c-kind").value,
    category: document.getElementById("c-cat").value,
    amount,
    memo: document.getElementById("c-memo").value.trim(),
    created_by: me.name,
  });
  if (error) return toast("저장에 실패했습니다");
  toast("저장되었습니다");
  cashDate = date;
  route();
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
        <b>${esc(me.name)}</b>님의 로그인 비밀번호를 변경합니다. 변경 후 다음 로그인부터 새 비밀번호를 사용하세요.
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
        내 결재 차례가 오거나, 내가 올린 문서가 승인/반려되면 이 기기로 알림이 옵니다.<br>
        기기마다 한 번씩 켜주세요. (아이폰은 Safari에서 <b>홈 화면에 추가</b> 후 앱을 열어 켜야 합니다)
      </p>
      <button class="btn" onclick="ensurePushSubscribed(true).then(()=>route())">🔔 이 기기에서 알림 켜기</button>
    </div>

    <div class="card">
      <h2>데이터 저장 방식</h2>
      <p style="color:var(--text-sub);font-size:13.5px">
        모든 문서와 제품 정보는 <b>Supabase 클라우드 데이터베이스</b>에 저장되며,<br>
        전 직원이 같은 데이터를 실시간으로 공유합니다. PC·핸드폰 어디서 접속해도 동일합니다.
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
        ※ 직원 추가/삭제, 비밀번호 변경이 필요하면 관리자에게 요청하세요.
      </p>
    </div>

    <div class="card">
      <h2>문서 백업</h2>
      <p style="color:var(--text-sub);font-size:13px;margin-bottom:12px">전체 문서·제품 데이터를 JSON 파일로 내려받습니다.</p>
      <button class="btn" onclick="exportJSON()">📤 전체 데이터 내보내기 (JSON)</button>
    </div>`;
}

async function exportJSON() {
  const [docs, prods] = await Promise.all([
    sb.from("documents").select("*"),
    sb.from("products").select("*"),
  ]);
  const dump = { exportedAt: nowStr(), documents: docs.data || [], products: prods.data || [] };
  downloadFile(JSON.stringify(dump, null, 2), `리버스_전자결재_백업_${today()}.json`, "application/json");
  toast("JSON 파일로 내보냈습니다");
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
