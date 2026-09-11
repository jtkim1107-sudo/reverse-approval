/* 쿠팡 입고 요청 승인·거절 - 2026-09-11
   화면 판단(버튼을 보여줄지·무엇을 표시할지)만 여기서 해요. 실제 권한·상태 판정은 DB
   fn_decide_inbound_plan()과 트리거가 최종으로 해요(deploy/sql/2026-09-11_inbound_plan_rejection.sql).
   - 승인·거절 버튼: profiles.approver 인 사람에게만. 일반 사용자는 상태·거절 사유만 봐요.
   - 거절: 사유 필수. 승인 대기뿐 아니라 "승인됐지만 아직 WING 미제출" 요청도 거절 가능.
   - WING에 제출(시도 포함)된 요청: "WING 제출 완료 · 거절 불가" 표시, 거절 버튼 없음.
   - 적재 기준(2026-09-11 확정, 차량 종류와 무관): TRUCK 전체 PLT 합계가 1PLT면 "승인 불가 · 1PLT 단독 입고",
     1PLT 미만이면 "승인 불가 · 1PLT 미만 불완전 적재", PLT 정보가 없거나 불확실하면 DATA_CHECK.
     승인 버튼 잠금, 거절 사유 기본값도 같은 문구. 판정표는 DB·파이썬(inbound_load_rule.py)과 같아요.
   - 거절은 끝 상태. 수정은 [수정 후 재요청] → 새 승인 요청(원본과 연결). WING 취소 API는 부르지 않아요. */
(function (root) {
  "use strict";

  const LOAD_LABELS = {
    SINGLE_PLT: "승인 불가 · 1PLT 단독 입고",
    UNDER_ONE_PLT: "승인 불가 · 1PLT 미만 불완전 적재",
    PLT_DATA_CHECK: "승인 불가 · PLT 계산정보 확인 필요(DATA_CHECK)",
  };
  const SINGLE_PLT_REASON = LOAD_LABELS.SINGLE_PLT;
  const SINGLE_PLT_CODE = "SINGLE_PLT";
  const WING_DONE_LABEL = "WING 제출 완료 · 거절 불가";
  const WING_TRIED_LABEL = "WING 제출 시도됨 · 거절 불가";

  const escHtml = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const short = id => String(id || "").slice(0, 8);
  const centers = () => root.CoupangCenters;

  function fmtKst(ts) {
    if (!ts) return "-";
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return String(ts);
    return d.toLocaleString("sv-SE", { timeZone: "Asia/Seoul", hour12: false }).slice(0, 16);
  }

  const isWingSubmitted = p => (p.submit_status && p.submit_status !== "NOT_SUBMITTED") || !!p.coupang_shipment_id;

  function wingSubmittedLabel(p) {
    if (!isWingSubmitted(p)) return null;
    const done = !!p.coupang_shipment_id || ["SUBMITTED", "PROCESSING", "SUCCEEDED"].includes(p.internal_status);
    return done ? WING_DONE_LABEL : WING_TRIED_LABEL;
  }

  const palletSum = items => (items || []).reduce((s, it) => s + (Number(it.pallet_count) || 0), 0);

  const toNum = v => (v === null || v === undefined || v === "" || typeof v === "boolean" || Number.isNaN(Number(v))) ? null : Number(v);

  // 적재 기준 - DB fn_inbound_plan_load_block_code()·inbound_load_rule.evaluate() 와 같은 표.
  // 차량 종류는 입력으로 받지도 않아요. 반환: null(허용) | { code, label, total }
  function loadBlock(p, items) {
    if (p.transport_type === "PARCEL") return null;
    const list = items || [];
    const mk = (code, total) => ({ code, label: LOAD_LABELS[code], total });
    if (!list.length) return mk("PLT_DATA_CHECK", null);
    const vals = list.map(it => toNum(it.pallet_count));
    if (vals.some(v => v === null || v < 0)) return mk("PLT_DATA_CHECK", null);
    const total = vals.reduce((a, b) => a + b, 0);
    if (p.total_plt !== null && p.total_plt !== undefined && toNum(p.total_plt) !== total) return mk("PLT_DATA_CHECK", total);
    if (total < 1) return mk("UNDER_ONE_PLT", total);
    if (total === 1) return mk("SINGLE_PLT", total);
    if (total < 2) return mk("PLT_DATA_CHECK", total);
    return null;
  }
  const singlePltBlocked = (p, items) => !!loadBlock(p, items);

  const isSuperseded = (p, supersededIds) => !!supersededIds && supersededIds.has(p.id);

  function canApprove(p, ctx = {}) {
    return p.approval_status === "PENDING_APPROVAL" && p.preflight_status === "PASSED"
      && p.submit_status === "NOT_SUBMITTED" && p.internal_status !== "CANCELLED"
      && !isSuperseded(p, ctx.supersededIds)
      && (p.transport_type !== "PARCEL" || p.automation_state === "PENDING_HUMAN_APPROVAL");
  }

  function canReject(p, ctx = {}) {
    return ["PENDING_APPROVAL", "APPROVED"].includes(p.approval_status)
      && p.submit_status === "NOT_SUBMITTED" && !p.coupang_shipment_id
      && p.internal_status !== "CANCELLED" && ["PASSED", "FAILED"].includes(p.preflight_status)
      && !isSuperseded(p, ctx.supersededIds);
  }

  function canResubmit(p, ctx = {}) {
    const me = ctx.me || {};
    const drafter = ctx.poDrafterId || null;
    // 2026-09-11 [수정 후 재요청]은 상품 1종 요청만(수량 한 칸) - 다품목 요청은 서버 재요청 경로가 없어 버튼을 내지 않아요.
    return p.approval_status === "REJECTED" && (p.transport_type || "TRUCK") === "TRUCK"
      && (ctx.items || []).length <= 1
      && !isWingSubmitted(p) && !isSuperseded(p, ctx.supersededIds)
      && (me.approver === true || (!!me.id && me.id === drafter));
  }

  const defaultRejectReason = ctx => (ctx && ctx.loadBlock ? ctx.loadBlock.label : "");
  const defaultRejectCode = ctx => (ctx && ctx.loadBlock ? ctx.loadBlock.code : null);

  function rejectionInfoHtml(p) {
    if (p.approval_status !== "REJECTED") return "";
    const reason = p.rejection_reason
      ? escHtml(p.rejection_reason)
      : `<span style="opacity:.75">사유 기록 없음(거절 기능 도입 전 처리)</span>`;
    const who = [p.rejected_by_name, p.rejected_at ? fmtKst(p.rejected_at) : null].filter(Boolean).map(escHtml).join(" · ");
    return `<div class="rg-reject-info"><b>거절 사유</b> ${reason}${who ? `<br><small>${who}</small>` : ""}</div>`;
  }

  // 승인 칸: 상태 칩 + (거절이면) 사유·거절자·시각 + (1PLT 규칙이면) 승인 불가 사유 + 연결 이력
  function approvalCellHtml(p, ctx = {}) {
    const chipMap = { PENDING_APPROVAL: ["progress", "승인대기"], APPROVED: ["approved", "승인됨"], REJECTED: ["rejected", "거절됨"] };
    let [cls, label] = chipMap[p.approval_status] || ["waiting", p.approval_status || "-"];
    // 2026-09-11 취소된 요청(실패 이력·대체된 요청)은 승인 대기처럼 보이지 않게
    if (p.internal_status === "CANCELLED" && p.approval_status === "PENDING_APPROVAL") [cls, label] = ["waiting", "취소됨 · 이력"];
    let html = `<span class="chip ${cls}">${label}</span>`;
    html += rejectionInfoHtml(p);
    if (ctx.loadBlock && p.approval_status !== "REJECTED" && !isWingSubmitted(p) && p.internal_status !== "CANCELLED") {
      html += `<br><small class="rg-block">${escHtml(ctx.loadBlock.label)}</small>`;
    }
    if (p.resubmission_of_plan_id) {
      html += `<br><small class="rg-link">↩ 거절된 요청 ${escHtml(short(p.resubmission_of_plan_id))}의 재요청</small>`;
    }
    if (ctx.child && p.approval_status === "REJECTED") {
      html += `<br><small class="rg-link">→ 새 요청 ${escHtml(short(ctx.child.id))} (${escHtml(chipMap[ctx.child.approval_status]?.[1] || ctx.child.approval_status || "-")})</small>`;
    }
    return html;
  }

  // 승인·거절 영역(행 끝 버튼 칸에 붙어요). onclick 함수는 app.js 에 있어요.
  function decisionHtml(p, ctx = {}) {
    const me = ctx.me || {};
    const id = escHtml(p.id);
    const out = [];
    const wing = wingSubmittedLabel(p);
    if (wing) {
      out.push(`<small class="rg-note">${wing}</small>`);
    } else if (p.approval_status !== "REJECTED" && me.approver === true) {
      const gate = ctx.migrated === false
        ? ` disabled title="DB 적용 전 - 관리자가 거절 기능 마이그레이션을 실행하면 사용할 수 있어요"` : "";
      if (canApprove(p, ctx)) {
        out.push(ctx.loadBlock
          ? `<button class="btn sm" disabled title="${escHtml(ctx.loadBlock.label)} - 차량 종류와 관계없이 전체 2PLT 이상만 승인">승인</button>`
          : `<button class="btn sm green" onclick="decideRgInbound('${id}','APPROVED')"${gate}>승인</button>`);
      }
      if (canReject(p, ctx)) {
        out.push(`<button class="btn sm danger" onclick="openRgRejectModal('${id}')"${gate}>거절</button>`);
      }
    }
    if (canResubmit(p, ctx)) {
      out.push(`<button class="btn sm secondary" onclick="openRgResubmitModal('${id}')">✏️ 수정 후 재요청</button>`);
    }
    out.push(`<button class="btn sm secondary" onclick="openRgPlanDetail('${id}')">상세</button>`);
    return out.join(" ");
  }

  const EVENT_LABEL = {
    PREFLIGHT_STARTED: "PRE-FLIGHT 시작", PREFLIGHT_PASSED: "PRE-FLIGHT 통과", PREFLIGHT_FAILED: "PRE-FLIGHT 실패",
    HUMAN_APPROVED: "승인", HUMAN_REJECTED: "거절", SUBMIT_ATTEMPTED: "WING 제출 시도",
    SUBMIT_SUCCEEDED: "WING 제출 성공", SUBMIT_FAILED: "WING 제출 실패", STATUS_POLLED: "WING 상태 확인",
    RECOVERY_CHECK: "복구·재계획 확인", INBOUND_MAIL_SENT: "입고 메일 발송", INBOUND_MAIL_FAILED: "입고 메일 실패",
    SHIPMENT_CANCELLED_AFTER_SUCCESS: "WING 입고 취소 확인", PLAN_SUPERSEDED: "새 요청으로 대체(이력)",
  };

  function eventLine(e) {
    const d = e.detail || {};
    let note = "";
    if (e.event_type === "HUMAN_REJECTED") {
      note = [d.reason ? `사유: ${d.reason}` : null, d.rejected_by_name || d.decided_by].filter(Boolean).join(" · ");
    } else if (e.event_type === "HUMAN_APPROVED") {
      note = d.approved_by_name || d.decided_by || d.approved_by || "";
    } else if (e.event_type === "PREFLIGHT_STARTED" && d.resubmission) {
      note = `거절된 요청 ${short(d.resubmission.of_plan_id)}의 수정 후 재요청`;
    } else if (e.event_type === "PLAN_SUPERSEDED") {
      note = d.reason || "";
    } else if (d.replan_proposal && d.replan_proposal.kind) {
      note = `재계획 ${d.replan_proposal.kind}`;
    }
    return `<li><span class="rg-ev-time">${escHtml(fmtKst(e.created_at))}</span> <b>${escHtml(EVENT_LABEL[e.event_type] || e.event_type)}</b>`
      + (note ? ` <span class="rg-ev-note">${escHtml(note)}</span>` : "") + `</li>`;
  }

  // 상세 모달 본문
  // 2026-09-11 [사용자 확정 - 합배송] 운송 묶음(inbound_shipment_groups 1행 = 트럭 1대)에 연결된 요청들.
  // group = { id, vehicle_type, total_pallet_count, total_transport_cost, slot_date, slot_time,
  //           members: [{ planId, name, qty, plt }] } - 실패 이력(CANCELLED)·거절 요청은 호출부가 members 에서 빼요.
  // 운송비는 묶음 전체에 한 번만: 요청별 개별 제안 운송비는 합산하지 않아요(각각 승인해도 한 번).
  const won = v => `₩${Number(v || 0).toLocaleString("ko-KR")}`;
  // 2026-09-11 묶음 상태: ACTIVE(사용 중) / VOID_PENDING_REBUILD(무효·재작성 대기) / SUPERSEDED(새 입고로 대체됨).
  // 무효·대체된 묶음의 운송비는 어디에도 더하지 않아요(이력으로만 표시).
  const GROUP_STATUS_LABEL = { VOID_PENDING_REBUILD: "무효 · 재작성 대기", SUPERSEDED: "대체됨" };
  function shipmentGroupSummary(group) {
    if (!group) return null;
    const members = group.members || [];
    const status = group.status || "ACTIVE";
    return {
      id: group.id, short: short(group.id), itemCount: members.length,
      planCount: new Set(members.map(m => m.planId)).size,
      plt: Number(group.total_pallet_count) || members.reduce((a, m) => a + (Number(m.plt) || 0), 0),
      vehicle: group.vehicle_type || "-", vehicleCount: Number(group.vehicle_count) || 1,
      cost: Number(group.total_transport_cost) || 0, members,
      status, active: status === "ACTIVE", statusLabel: GROUP_STATUS_LABEL[status] || "",
      supersededBy: group.superseded_by_group_id ? short(group.superseded_by_group_id) : null,
    };
  }
  function shipmentGroupChipHtml(group) {
    const g = shipmentGroupSummary(group);
    if (!g) return "";
    if (!g.active) {
      return `<small class="rg-group rg-group-void" title="이 운송 묶음은 더 이상 쓰지 않아요 - 운송비는 합산하지 않아요">`
        + `🚚 운송 묶음 ${escHtml(g.short)} · ${escHtml(g.statusLabel)}${g.supersededBy ? ` → 새 묶음 ${escHtml(g.supersededBy)}` : ""} · 운송비 합산 안 함</small>`;
    }
    if (g.planCount <= 1) {
      return `<small class="rg-group" title="입고 요청 1건(WING 입고 1개)에 여러 상품 - 트럭 한 대, 운송비 한 번">`
        + `🚚 단일 입고 ${escHtml(g.short)} · 포함 상품 ${g.itemCount}개 · 총 ${g.plt}PLT · ${escHtml(g.vehicle)} ${g.vehicleCount}대 · 운송비 ${won(g.cost)} 한 번</small>`;
    }
    return `<small class="rg-group" title="같은 트럭 한 대로 가는 요청 묶음 - 운송비는 묶음 전체에 한 번만 반영">`
      + `🚚 합배송 그룹 ${escHtml(g.short)} · 포함 상품 ${g.itemCount}개 · 총 ${g.plt}PLT · 대표 운송비 ${won(g.cost)} · 운송비 중복 반영 없음</small>`;
  }
  function shipmentGroupDetailHtml(group, p) {
    const g = shipmentGroupSummary(group);
    if (!g) return "";
    if (!g.active) {
      return `<b>운송 묶음 <code>${escHtml(g.short)}</code> · ${escHtml(g.statusLabel)}</b>`
        + (g.supersededBy ? ` → 새 묶음 <code>${escHtml(g.supersededBy)}</code>` : "")
        + `<br><span class="rg-muted">${escHtml(group.status_reason || "")}</span>`
        + `<br>이 묶음의 운송비 ${won(g.cost)}는 합산하지 않아요(이력).`;
    }
    const lines = g.members.map(m => `${escHtml(m.name || "-")} ${Number(m.qty || 0).toLocaleString("ko-KR")}개 · ${Number(m.plt) || 0}PLT`
      + (g.planCount > 1 ? ` <small class="rg-muted">요청 ${escHtml(short(m.planId))}${p && m.planId === p.id ? " (이 요청)" : ""}</small>` : ""));
    const head = g.planCount <= 1 ? `단일 입고 <code>${escHtml(g.short)}</code>` : `합배송 그룹 <code>${escHtml(g.short)}</code>`;
    return `<b>${head}</b> · ${escHtml(g.vehicle)} ${g.vehicleCount}대 · 총 ${g.plt}PLT`
      + `<br>포함 상품 ${g.itemCount}개: ${lines.join(" / ")}`
      + `<br>${g.planCount <= 1 ? "운송비" : "대표 운송비"} <b>${won(g.cost)}</b> - 트럭 한 대분 한 번만 반영(운송비 중복 반영 없음)`;
  }
  // 요청 한 건의 상품 표시(다품목이면 "첫 상품 외 N종")
  function itemsLabel(items) {
    const list = items || [];
    if (!list.length) return "-";
    const first = [list[0].inventory_name, list[0].option_name].filter(Boolean).join(" / ") || "-";
    return list.length > 1 ? `${first} 외 ${list.length - 1}종` : first;
  }
  const qtySum = items => (items || []).reduce((s, it) => s + (Number(it.coupang_inbound_qty) || 0), 0);

  function detailHtml(p, ctx = {}) {
    const items = ctx.items || [];
    const c = centers();
    const centerHtml = c ? c.html({ id: p.destination_center_id, code: p.destination_center_raw }) : escHtml(p.destination_center_raw || "-");
    const prefChip = { NOT_RUN: "미실행", RUNNING: "실행중", PASSED: "통과", FAILED: "실패" }[p.preflight_status] || p.preflight_status || "-";
    const wing = wingSubmittedLabel(p);
    const rows = [
      ["요청 번호", `<code>${escHtml(short(p.id))}</code>${ctx.poNo ? ` · 발주서 ${escHtml(ctx.poNo)}` : ""}`],
      ["상품", items.map(it => `${escHtml(it.inventory_name || "-")}${it.option_name ? ` <small>${escHtml(it.option_name)}</small>` : ""}`).join("<br>") || "-"],
      ["최종 입고수량", items.map(it => `${Number(it.coupang_inbound_qty || 0).toLocaleString("ko-KR")}개`).join(", ") || "-"],
      ["PLT", `전체 ${palletSum(items)}PLT${ctx.loadBlock ? ` · <span class="rg-block">${escHtml(ctx.loadBlock.label)}</span>` : ""}`
        + (ctx.shipmentGroup && (ctx.shipmentGroup.status || "ACTIVE") === "ACTIVE"
          ? `<br><small class="rg-muted">차량 ${escHtml(ctx.shipmentGroup.vehicle_type || "-")} ${Number(ctx.shipmentGroup.vehicle_count) || 1}대(운송 묶음 기준${ctx.vehicleType ? ` · 이 요청 단독 제안 ${escHtml(ctx.vehicleType)}은 쓰지 않음` : ""}) - 승인 판단은 차량과 무관</small>`
          : (ctx.vehicleType ? `<br><small class="rg-muted">차량 ${escHtml(ctx.vehicleType)} (참고용 - 승인 판단은 차량과 무관)</small>` : ""))],
      ["쿠팡센터", centerHtml],
      ["입고 예정", `${escHtml(p.inbound_date || "-")} ${escHtml(String(p.inbound_time || "").slice(0, 5))}`],
      ["운송", escHtml(p.transport_type === "PARCEL" ? "택배(PARCEL)" : "트럭(TRUCK)")],
      ["PRE-FLIGHT", escHtml(prefChip)],
      ["승인", approvalCellHtml(p, ctx)],
      ["WING 제출", wing ? escHtml(wing) : "미제출"],
      ["WING 초안 id", p.coupang_inbound_plan_id ? `<code>${escHtml(p.coupang_inbound_plan_id)}</code>` : "-"],
    ];
    if (ctx.shipmentGroup) rows.splice(6, 0, ["운송 묶음", shipmentGroupDetailHtml(ctx.shipmentGroup, p)]);
    if (p.coupang_shipment_id) rows.push(["shipmentId", `<code>${escHtml(p.coupang_shipment_id)}</code>`]);
    if (p.approved_by_name) rows.push(["승인자", `${escHtml(p.approved_by_name)} · ${escHtml(fmtKst(p.approved_at))}`]);
    if (p.approval_status === "REJECTED") {
      rows.push(["거절자", `${escHtml(p.rejected_by_name || "-")} · ${escHtml(fmtKst(p.rejected_at))}`]);
      if (p.coupang_inbound_plan_id) {
        rows.push(["WING 초안", "WING 쪽 초안(미제출)은 그대로 남아 있어요. 취소 API가 확인되지 않아 자동 취소하지 않았습니다."]);
      }
    }
    if (ctx.original) rows.push(["원본 요청", `<code>${escHtml(short(ctx.original.id))}</code> · ${escHtml(ctx.original.rejection_reason || ctx.original.approval_status || "")}`]);
    if (ctx.child) rows.push(["새 요청", `<code>${escHtml(short(ctx.child.id))}</code> · ${escHtml(ctx.child.approval_status || "")}`]);

    const events = (ctx.events || []).slice().sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    return `<table class="rg-detail"><tbody>${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join("")}</tbody></table>
      <h4 class="rg-detail-h">처리 이력</h4>
      ${events.length ? `<ol class="rg-events">${events.map(eventLine).join("")}</ol>` : `<p class="rg-muted">기록된 이력이 없어요.</p>`}`;
  }

  const CSV_HEADER = ["요청번호", "발주서", "상품", "옵션", "공급처", "최종 입고수량", "PLT", "쿠팡센터", "센터코드",
    "입고예정일", "입고시간", "PRE-FLIGHT", "승인상태", "승인불가 사유", "거절 사유", "거절자", "거절시각",
    "WING 제출", "WING 초안 id", "shipmentId", "원본 요청"];

  function csvRows(plans, ctxFor) {
    const approvalText = { PENDING_APPROVAL: "승인대기", APPROVED: "승인됨", REJECTED: "거절됨" };
    const c = centers();
    const out = [];
    for (const p of plans) {
      const ctx = ctxFor(p) || {};
      const items = ctx.items && ctx.items.length ? ctx.items : [{}];
      const ref = { id: p.destination_center_id, code: p.destination_center_raw };
      for (const it of items) {
        out.push([
          short(p.id), ctx.poNo || "", it.inventory_name || "", it.option_name || "", p.supplier || "",
          it.coupang_inbound_qty ?? "", it.pallet_count ?? "",
          c ? c.text(ref) : (p.destination_center_raw || ""), c ? c.code(ref) : (p.destination_center_raw || ""),
          p.inbound_date || "", String(p.inbound_time || "").slice(0, 5), p.preflight_status || "",
          approvalText[p.approval_status] || p.approval_status || "",
          ctx.loadBlock && p.approval_status !== "REJECTED" && !isWingSubmitted(p) ? ctx.loadBlock.label : "",
          p.rejection_reason || "", p.rejected_by_name || "", p.rejected_at ? fmtKst(p.rejected_at) : "",
          wingSubmittedLabel(p) ? (p.coupang_shipment_id ? "제출완료" : "제출시도") : "미제출",
          p.coupang_inbound_plan_id || "", p.coupang_shipment_id || "",
          p.resubmission_of_plan_id ? short(p.resubmission_of_plan_id) : "",
        ]);
      }
    }
    return out;
  }

  function toCsv(rows) {
    const cell = v => {
      const s = String(v ?? "");
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return "﻿" + [CSV_HEADER, ...rows].map(r => r.map(cell).join(",")).join("\r\n");
  }

  root.InboundApproval = {
    SINGLE_PLT_REASON, SINGLE_PLT_CODE, LOAD_LABELS, loadBlock, WING_DONE_LABEL, WING_TRIED_LABEL, CSV_HEADER,
    isWingSubmitted, wingSubmittedLabel, singlePltBlocked, canApprove, canReject, canResubmit,
    defaultRejectReason, defaultRejectCode, approvalCellHtml, decisionHtml, detailHtml, rejectionInfoHtml,
    csvRows, toCsv, fmtKst, palletSum,
    shipmentGroupSummary, shipmentGroupChipHtml, shipmentGroupDetailHtml, itemsLabel, qtySum,
  };
})(typeof window !== "undefined" ? window : globalThis);
