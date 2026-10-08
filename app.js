'use strict';

// ---------- 定数 ----------
// 三井住友カード「あとから分割」で選べる回数（学生は手数料がポイント還元されるので手数料0で計算）
const SPLIT_COUNTS = [3, 4, 5, 6, 10, 12, 15, 18, 20, 24, 30, 36, 40, 42, 48, 50, 54, 60];
const DEFAULT_CATEGORIES = ['食費', '日用品', '交通費', '交際費', '趣味', '衣服', '通信費', '家賃', '光熱費', '学費・書籍', 'その他'];
const LS_DATA = 'kakeibo.data';
const LS_GH = 'kakeibo.github';
const LS_SHA = 'kakeibo.sha';
const COLLECTIONS = ['incomes', 'expenses', 'shifts', 'plans'];

// ---------- ユーティリティ ----------
const $ = (s, r = document) => r.querySelector(s);
const yen = n => (n < 0 ? '-¥' : '¥') + Math.abs(Math.round(n)).toLocaleString('ja-JP');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const now = () => Date.now();
const pad = n => String(n).padStart(2, '0');
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const monthOf = date => date.slice(0, 7);
function addMonths(ym, k) {
  const [y, m] = ym.split('-').map(Number);
  const t = y * 12 + (m - 1) + k;
  return `${Math.floor(t / 12)}-${pad(t % 12 + 1)}`;
}
const monthLabel = ym => { const [y, m] = ym.split('-'); return `${y}年${Number(m)}月`; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// action を渡すと「元に戻す」などのボタン付きで表示する
function toast(msg, action) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>`;
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.label;
    b.addEventListener('click', () => { t.classList.remove('show'); action.fn(); });
    t.append(b);
  }
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), action ? 5000 : 2500);
}

function lsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* 容量超過など */ }
}

// ---------- データ ----------
function emptyData() {
  return {
    v: 1,
    settings: { wage: 1100, payOffset: 1, initialBalance: 0, categories: DEFAULT_CATEGORIES, u: 0 },
    incomes: [], expenses: [], shifts: [], plans: [],
    deleted: {},
  };
}
function normalize(d) {
  const base = emptyData();
  d = d && typeof d === 'object' ? d : {};
  for (const c of COLLECTIONS) if (!Array.isArray(d[c])) d[c] = [];
  d.settings = { ...base.settings, ...(d.settings || {}) };
  d.deleted = d.deleted || {};
  d.v = 1;
  return d;
}

let data = normalize(lsGet(LS_DATA, null));
let currentMonth = monthOf(todayStr());

function upsert(coll, item) {
  item.u = now();
  const arr = data[coll];
  const i = arr.findIndex(x => x.id === item.id);
  if (i >= 0) arr[i] = item; else arr.push(item);
  commit();
}
function remove(coll, id) {
  data[coll] = data[coll].filter(x => x.id !== id);
  data.deleted[id] = now();
  commit();
}
function commit() {
  lsSet(LS_DATA, data);
  render();
  scheduleSync();
}

// 2つのデータをIDごとに新しい方を採用して統合（スマホとPCの同時編集対策）
function merge(a, b) {
  a = normalize(structuredClone(a));
  b = normalize(structuredClone(b));
  const out = emptyData();
  out.deleted = { ...a.deleted };
  for (const [id, t] of Object.entries(b.deleted)) out.deleted[id] = Math.max(out.deleted[id] || 0, t);
  out.settings = (b.settings.u || 0) > (a.settings.u || 0) ? b.settings : a.settings;
  for (const c of COLLECTIONS) {
    const map = new Map();
    for (const x of [...a[c], ...b[c]]) {
      const cur = map.get(x.id);
      if (!cur || (x.u || 0) > (cur.u || 0)) map.set(x.id, x);
    }
    out[c] = [...map.values()].filter(x => !(out.deleted[x.id] >= (x.u || 0)));
  }
  return out;
}

// ---------- 計算 ----------
// total: 利用金額, amount: そのうち分割に回す金額（残りは初回の月に1回払い）
// 月々の端数は初回に加算（三井住友カードの計算方法）
function planSchedule(p) {
  const total = p.total ?? p.amount;
  const lump = total - p.amount;
  const monthly = Math.floor(p.amount / p.count);
  const first = p.amount - monthly * (p.count - 1);
  const rows = [];
  for (let i = 0; i < p.count; i++) {
    rows.push({ n: i + 1, month: addMonths(p.startMonth, i), amount: i === 0 ? first + lump : monthly });
  }
  return { total, lump, monthly, first, rows };
}

function shiftPay(s) { return s.hours * s.wage; }

function monthSummary(ym) {
  const incomes = data.incomes.filter(x => x.month === ym);
  const workMonth = addMonths(ym, -Number(data.settings.payOffset));
  const workShifts = data.shifts.filter(s => monthOf(s.date) === workMonth);
  const workPay = Math.floor(workShifts.reduce((a, s) => a + shiftPay(s), 0));
  const expenses = data.expenses.filter(x => monthOf(x.date) === ym);
  const planPays = [];
  for (const p of data.plans) {
    const r = planSchedule(p).rows.find(r => r.month === ym);
    if (r) planPays.push({ plan: p, ...r });
  }
  const income = incomes.reduce((a, x) => a + x.amount, 0) + workPay;
  const expense = expenses.filter(x => !x.splitId).reduce((a, x) => a + x.amount, 0);
  const plan = planPays.reduce((a, x) => a + x.amount, 0);
  return { incomes, workMonth, workShifts, workPay, expenses, planPays, income, expense, plan, balance: income - expense - plan };
}

function allMonths() {
  const ms = new Set();
  data.incomes.forEach(x => ms.add(x.month));
  data.expenses.forEach(x => ms.add(monthOf(x.date)));
  data.shifts.forEach(x => ms.add(addMonths(monthOf(x.date), Number(data.settings.payOffset))));
  data.plans.forEach(p => planSchedule(p).rows.forEach(r => ms.add(r.month)));
  return [...ms].sort();
}

function cumulative(ym) {
  let total = Number(data.settings.initialBalance) || 0;
  for (const m of allMonths()) if (m <= ym) total += monthSummary(m).balance;
  return total;
}

// ---------- 描画 ----------
function render() {
  $('#monthLabel').textContent = monthLabel(currentMonth);
  renderMonth();
  renderWork();
  renderPlans();
  renderSim();
}

function setAmount(el, v) {
  el.textContent = yen(v);
  el.classList.toggle('neg', v < 0);
  el.classList.toggle('pos', v > 0);
}

function renderMonth() {
  const s = monthSummary(currentMonth);
  $('#sumIncome').textContent = yen(s.income);
  $('#sumExpense').textContent = yen(s.expense);
  $('#sumPlan').textContent = yen(s.plan);
  setAmount($('#sumBalance'), s.balance);
  setAmount($('#sumCumulative'), cumulative(currentMonth));

  // 収入
  let html = '';
  if (s.workShifts.length) {
    html += `<li><div class="main">アルバイト代<small>${monthLabel(s.workMonth)}勤務分・自動計算</small></div><span class="amt">${yen(s.workPay)}</span><span class="auto">自動</span></li>`;
  }
  for (const x of s.incomes) {
    html += `<li><div class="main">${esc(x.name)}</div><span class="amt">${yen(x.amount)}</span>
      <button class="row-btn" data-edit-income="${x.id}">編集</button><button class="row-btn" data-del="incomes:${x.id}">×</button></li>`;
  }
  $('#incomeList').innerHTML = html || '<li class="empty">まだありません</li>';
  const names = [...new Set(data.incomes.map(x => x.name))];
  $('#incomeNames').innerHTML = names.map(n => `<option value="${esc(n)}">`).join('');

  // 支出
  const exps = [...s.expenses].sort((a, b) => b.date.localeCompare(a.date) || b.u - a.u);
  $('#expenseList').innerHTML = exps.map(x => {
    const split = x.splitId ? ' split' : '';
    // 分割済みでもボタンは残し、押すと分割内容の編集になる
    const splitBtn = `<button class="row-btn${x.splitId ? ' on' : ''}" data-split="${x.id}">分割</button>`;
    return `<li class="${split}"><div class="main">${esc(x.category)}${x.memo ? '：' + esc(x.memo) : ''}<small>${Number(x.date.slice(5, 7))}/${Number(x.date.slice(8))}</small></div>
      <span class="amt">${yen(x.amount)}</span>${splitBtn}
      <button class="row-btn" data-edit-expense="${x.id}">編集</button><button class="row-btn" data-del="expenses:${x.id}">×</button></li>`;
  }).join('') || '<li class="empty">まだありません</li>';

  const sel = $('#expenseForm [name=category]');
  const cur = sel.value;
  sel.innerHTML = data.settings.categories.map(c => `<option>${esc(c)}</option>`).join('');
  if (data.settings.categories.includes(cur)) sel.value = cur;

  // カテゴリ別
  const byCat = {};
  for (const x of s.expenses) if (!x.splitId) byCat[x.category] = (byCat[x.category] || 0) + x.amount;
  for (const p of s.planPays) byCat['分割払い'] = (byCat['分割払い'] || 0) + p.amount;
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const max = cats.length ? cats[0][1] : 1;
  $('#categoryBreakdown').innerHTML = cats.map(([c, v]) =>
    `<div class="cat"><span>${esc(c)}</span><div class="bar" style="width:${Math.max(2, v / max * 100)}%"></div><span>${yen(v)}</span></div>`).join('');

  // 分割払い
  $('#planPaymentsCard').classList.toggle('hidden', !s.planPays.length);
  $('#planPaymentList').innerHTML = s.planPays.map(p =>
    `<li><div class="main">${esc(p.plan.name || '分割払い')}<small>${p.n}/${p.plan.count}回目${p.n === 1 && planSchedule(p.plan).lump ? `（1回払い分 ${yen(planSchedule(p.plan).lump)} を含む）` : ''}</small></div><span class="amt">${yen(p.amount)}</span></li>`).join('');
}

function renderWork() {
  const payMonth = addMonths(currentMonth, Number(data.settings.payOffset));
  $('#workPayMonth').textContent = monthLabel(payMonth);
  const shifts = data.shifts.filter(s => monthOf(s.date) === currentMonth).sort((a, b) => a.date.localeCompare(b.date));
  $('#shiftList').innerHTML = shifts.map(s =>
    `<li><div class="main">${Number(s.date.slice(5, 7))}/${Number(s.date.slice(8))}<small>${s.hours}時間 × ${yen(s.wage)}</small></div>
      <span class="amt">${yen(shiftPay(s))}</span>
      <button class="row-btn" data-edit-shift="${s.id}">編集</button><button class="row-btn" data-del="shifts:${s.id}">×</button></li>`).join('')
    || '<li class="empty">まだありません</li>';
  const hours = shifts.reduce((a, s) => a + s.hours, 0);
  $('#workHours').textContent = `${Math.round(hours * 100) / 100}時間`;
  $('#workPay').textContent = yen(Math.floor(shifts.reduce((a, s) => a + shiftPay(s), 0)));
  const wageInput = $('#shiftForm [name=wage]');
  if (!wageInput.value) wageInput.value = data.settings.wage;
}

function renderPlans() {
  const plans = [...data.plans].sort((a, b) => a.startMonth.localeCompare(b.startMonth));
  $('#planList').innerHTML = plans.map(p => {
    const sc = planSchedule(p);
    const last = sc.rows[sc.rows.length - 1].month;
    const part = sc.lump ? `${yen(sc.total)}のうち${yen(p.amount)}` : yen(p.amount);
    return `<li><div class="main">${esc(p.name || '分割払い')}<small>${part} / ${p.count}回 / ${monthLabel(p.startMonth)}〜${monthLabel(last)}</small></div>
      <span class="amt">月${yen(sc.monthly)}</span><button class="row-btn" data-edit-plan="${p.id}">編集</button><button class="row-btn" data-del="plans:${p.id}">×</button></li>`;
  }).join('') || '<li class="empty">まだありません</li>';
}

function simInput() {
  const f = $('#simForm');
  return {
    name: f.name.value.trim(),
    total: Math.floor(Number(f.amount.value)),
    // 未入力なら全額を分割
    amount: f.splitAmount.value === '' ? Math.floor(Number(f.amount.value)) : Math.floor(Number(f.splitAmount.value)),
    count: Number(f.count.value),
    startMonth: f.startMonth.value,
    expenseId: f.expenseId.value,
    planId: f.planId.value,
  };
}

// 分割フォームを新規入力／既存の分割の編集モードにする
function setPlanEditing(planId) {
  $('#simForm').planId.value = planId || '';
  $('#registerPlan').textContent = planId ? '分割内容を更新' : 'この内容で家計簿に登録';
  $('#cancelPlanEdit').classList.toggle('hidden', !planId);
  $('#unsplitPlan').classList.toggle('hidden', !planId);
}

function loadPlanIntoSim(p) {
  const f = $('#simForm');
  const total = p.total ?? p.amount;
  f.name.value = p.name || '';
  f.amount.value = total;
  f.splitAmount.value = p.amount === total ? '' : p.amount;
  f.count.value = String(p.count);
  f.startMonth.value = p.startMonth;
  f.expenseId.value = p.expenseId || '';
  setPlanEditing(p.id);
  showTab('split');
  renderSim();
}

function resetSim() {
  clearFields($('#simForm'), ['count', 'startMonth']);
  setPlanEditing(null);
  renderSim();
}

function renderSim() {
  const f = $('#simForm');
  if (!f.count.options.length) {
    f.count.innerHTML = SPLIT_COUNTS.map(n => `<option value="${n}">${n}回</option>`).join('');
    f.count.value = '12';
  }
  if (!f.startMonth.value) f.startMonth.value = addMonths(monthOf(todayStr()), 1);
  const inp = simInput();
  let msg = '';
  if (!inp.total || inp.total < 1 || !inp.startMonth) msg = '利用金額を入力すると結果が表示されます。';
  else if (!(inp.amount >= inp.count)) msg = `分割に回す金額は${inp.count}円以上にしてください。`;
  else if (inp.amount > inp.total) msg = '分割に回す金額が利用金額を超えています。';
  if (msg) {
    $('#simResult').innerHTML = `<p class="note">${msg}</p>`;
    $('#simCompare').innerHTML = '';
    $('#registerPlan').disabled = true;
    return;
  }
  $('#registerPlan').disabled = false;
  const sc = planSchedule(inp);
  $('#simResult').innerHTML = `
    <div class="sim-head">
      <div><small>1回払い分（初回月）</small><b>${yen(sc.lump)}</b></div>
      <div><small>分割分</small><b>${yen(inp.amount)}</b></div>
      <div><small>初回の支払額</small><b>${yen(sc.rows[0].amount)}</b></div>
      <div><small>2回目以降（月々）</small><b>${yen(sc.monthly)}</b></div>
    </div>
    <details><summary>支払スケジュール</summary><div class="table-wrap"><table>
      <tr><th>回</th><th>支払月</th><th>金額</th><th>その月の残金（登録後）</th></tr>
      ${sc.rows.map(r => {
        // 支出から分割に切り替える場合、元の支出は差し引かれなくなる
        const src = inp.expenseId && expenseById(inp.expenseId);
        let back = src && !src.splitId && monthOf(src.date) === r.month ? src.amount : 0;
        // 編集中の分割は、今の登録内容の支払いを差し戻してから比べる
        const old = inp.planId && data.plans.find(p => p.id === inp.planId);
        if (old) back += planSchedule(old).rows.find(o => o.month === r.month)?.amount || 0;
        const after = monthSummary(r.month).balance + back - r.amount;
        return `<tr><td>${r.n}</td><td>${monthLabel(r.month)}</td><td>${yen(r.amount)}</td><td class="${after < 0 ? 'neg' : ''}">${yen(after)}</td></tr>`;
      }).join('')}
    </table></div></details>`;
  $('#simCompare').innerHTML = `<div class="table-wrap"><table>
    <tr><th>回数</th><th>初回</th><th>月々</th><th>最終支払月</th></tr>
    ${SPLIT_COUNTS.filter(n => n <= inp.amount).map(n => {
      const s = planSchedule({ ...inp, count: n });
      return `<tr class="${n === inp.count ? 'hl' : ''}"><td>${n}回</td><td>${yen(s.rows[0].amount)}</td><td>${yen(s.monthly)}</td><td>${monthLabel(s.rows[n - 1].month)}</td></tr>`;
    }).join('')}
  </table></div>`;
}

const expenseById = id => data.expenses.find(x => x.id === id);

// ---------- 入力フォーム ----------
function setupForm(form, onSubmit) {
  const cancel = form.querySelector('.cancel');
  form.endEdit = () => {
    form.dataset.editId = '';
    form.querySelector('[type=submit]').textContent = '追加';
    cancel.classList.add('hidden');
  };
  form.beginEdit = id => {
    form.dataset.editId = id;
    form.querySelector('[type=submit]').textContent = '更新';
    cancel.classList.remove('hidden');
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  cancel.addEventListener('click', () => { clearFields(form); form.endEdit(); });
  form.addEventListener('submit', e => {
    e.preventDefault();
    onSubmit(form.dataset.editId || uid());
    form.endEdit();
  });
}
function clearFields(form, keep = []) {
  for (const el of form.elements) if (el.name && !keep.includes(el.name)) el.value = '';
}
function defaultDate() {
  // 表示中の月が今月なら今日、それ以外はその月の1日
  return currentMonth === monthOf(todayStr()) ? todayStr() : `${currentMonth}-01`;
}

function initForms() {
  const inc = $('#incomeForm');
  setupForm(inc, id => {
    const old = data.incomes.find(x => x.id === id);
    upsert('incomes', { id, month: old ? old.month : currentMonth, name: inc.name.value.trim(), amount: Math.floor(Number(inc.amount.value)) });
    clearFields(inc);
  });

  const exp = $('#expenseForm');
  exp.date.value = defaultDate();
  setupForm(exp, id => {
    const old = expenseById(id);
    const amount = Math.floor(Number(exp.amount.value));
    upsert('expenses', { ...(old || {}), id, date: exp.date.value, category: exp.category.value, memo: exp.memo.value.trim(), amount });
    // 分割済みの支出の金額を変えたら、分割の利用金額も合わせる
    const plan = old && old.splitId && data.plans.find(p => p.id === old.splitId);
    if (plan && (plan.total ?? plan.amount) !== amount) {
      const keepAll = plan.amount === (plan.total ?? plan.amount);
      upsert('plans', { ...plan, total: amount, amount: keepAll ? amount : Math.min(plan.amount, amount) });
    }
    clearFields(exp, ['date', 'category']);
    if (monthOf(exp.date.value) !== currentMonth) toast(`${monthLabel(monthOf(exp.date.value))}に記録しました`);
  });

  const sh = $('#shiftForm');
  sh.date.value = defaultDate();
  setupForm(sh, id => {
    upsert('shifts', { id, date: sh.date.value, hours: Number(sh.hours.value), wage: Number(sh.wage.value) });
    clearFields(sh, ['date', 'wage']);
  });

  $('#simForm').addEventListener('input', renderSim);
  $('#registerPlan').addEventListener('click', () => {
    const inp = simInput();
    const editing = !!(inp.planId && data.plans.some(p => p.id === inp.planId));
    const id = editing ? inp.planId : uid();
    upsert('plans', { id, name: inp.name, total: inp.total, amount: inp.amount, count: inp.count, startMonth: inp.startMonth, expenseId: inp.expenseId || undefined });
    if (inp.expenseId) {
      const x = expenseById(inp.expenseId);
      if (x && x.splitId !== id) upsert('expenses', { ...x, splitId: id });
    }
    resetSim();
    toast(editing ? '分割内容を更新しました' : '分割払いを登録しました');
  });
  $('#cancelPlanEdit').addEventListener('click', resetSim);
  $('#unsplitPlan').addEventListener('click', () => {
    const id = $('#simForm').planId.value;
    resetSim();
    deleteWithUndo('plans', id);
  });

  // 一覧のボタン（委譲）
  document.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    const d = b.dataset;
    if (d.del) {
      const [coll, id] = d.del.split(':');
      deleteWithUndo(coll, id);
    } else if (d.editIncome) {
      const x = data.incomes.find(i => i.id === d.editIncome);
      inc.name.value = x.name; inc.amount.value = x.amount; inc.beginEdit(x.id);
    } else if (d.editExpense) {
      const x = expenseById(d.editExpense);
      exp.date.value = x.date; exp.category.value = x.category; exp.memo.value = x.memo || ''; exp.amount.value = x.amount; exp.beginEdit(x.id);
    } else if (d.editShift) {
      const x = data.shifts.find(i => i.id === d.editShift);
      sh.date.value = x.date; sh.hours.value = x.hours; sh.wage.value = x.wage; sh.beginEdit(x.id);
    } else if (d.split) {
      const x = expenseById(d.split);
      const plan = x.splitId && data.plans.find(p => p.id === x.splitId);
      if (plan) { loadPlanIntoSim(plan); return; }
      const f = $('#simForm');
      f.name.value = `${x.category}${x.memo ? '：' + x.memo : ''}`;
      f.amount.value = x.amount;
      f.splitAmount.value = '';
      f.startMonth.value = addMonths(monthOf(x.date), 1);
      f.expenseId.value = x.id;
      setPlanEditing(null);
      showTab('split');
      renderSim();
    } else if (d.editPlan) {
      loadPlanIntoSim(data.plans.find(p => p.id === d.editPlan));
    } else if (d.tab) {
      showTab(d.tab);
    }
  });

  $('#prevMonth').addEventListener('click', () => changeMonth(-1));
  $('#nextMonth').addEventListener('click', () => changeMonth(1));

  // 設定
  const sf = $('#settingsForm');
  const fillSettings = () => {
    sf.wage.value = data.settings.wage;
    sf.payOffset.value = String(data.settings.payOffset);
    sf.initialBalance.value = data.settings.initialBalance;
    sf.categories.value = data.settings.categories.join(', ');
  };
  fillSettings();
  sf.addEventListener('submit', e => {
    e.preventDefault();
    const cats = sf.categories.value.split(/[,、，\n]/).map(s => s.trim()).filter(Boolean);
    data.settings = {
      wage: Number(sf.wage.value) || 0,
      payOffset: Number(sf.payOffset.value),
      initialBalance: Number(sf.initialBalance.value) || 0,
      categories: cats.length ? cats : DEFAULT_CATEGORIES,
      u: now(),
    };
    $('#shiftForm [name=wage]').value = data.settings.wage;
    commit();
    toast('保存しました');
  });
  initForms.fillSettings = fillSettings;

  $('#exportBtn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `kakeibo-${todayStr()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $('#importFile').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const imported = normalize(JSON.parse(await file.text()));
      data = merge(data, imported);
      fillSettings();
      commit();
      toast('読み込みました');
    } catch {
      toast('読み込みに失敗しました');
    }
    e.target.value = '';
  });
}

// 確認ダイアログ（confirm）は環境によって表示されず常にキャンセル扱いになるため、
// すぐ削除して「元に戻す」を出す方式にしている
function deleteWithUndo(coll, id) {
  const item = data[coll].find(x => x.id === id);
  if (!item) return;
  const restore = [{ coll, item: structuredClone(item) }];
  if (coll === 'plans' && item.expenseId) {
    // 元の支出の「分割済」を解除
    const x = expenseById(item.expenseId);
    if (x) {
      restore.push({ coll: 'expenses', item: structuredClone(x) });
      const { splitId, ...rest } = x;
      upsert('expenses', rest);
    }
  }
  if (coll === 'expenses' && item.splitId) {
    // 分割済みの支出なら紐づく分割払いも削除
    const p = data.plans.find(x => x.id === item.splitId);
    if (p) { restore.push({ coll: 'plans', item: structuredClone(p) }); remove('plans', p.id); }
  }
  remove(coll, id);
  toast('削除しました', {
    label: '元に戻す',
    fn: () => {
      for (const r of restore) { delete data.deleted[r.item.id]; upsert(r.coll, r.item); }
    },
  });
}

function changeMonth(k) {
  currentMonth = addMonths(currentMonth, k);
  for (const f of [$('#expenseForm'), $('#shiftForm')]) if (!f.dataset.editId) f.date.value = defaultDate();
  render();
}

function showTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === `tab-${name}`));
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  window.scrollTo(0, 0);
}

// ---------- GitHub 同期 ----------
let gh = lsGet(LS_GH, null);
let remoteSha = lsGet(LS_SHA, null);
let syncTimer = null;
let syncing = false;
let syncAgain = false;

function setStatus(text) { $('#syncStatus').textContent = text; }

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64decode(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}

function apiUrl() {
  return `https://api.github.com/repos/${encodeURIComponent(gh.owner)}/${encodeURIComponent(gh.repo)}/contents/${gh.path.split('/').map(encodeURIComponent).join('/')}`;
}
function apiHeaders() {
  return { Authorization: `Bearer ${gh.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
}

async function fetchRemote() {
  const res = await fetch(apiUrl(), { headers: apiHeaders(), cache: 'no-store' });
  if (res.status === 404) return { data: null, sha: null };
  if (!res.ok) throw new Error(`読込失敗 (${res.status})`);
  const j = await res.json();
  return { data: normalize(JSON.parse(b64decode(j.content))), sha: j.sha };
}

async function putRemote(d, sha) {
  const body = { message: `update ${new Date().toISOString()}`, content: b64encode(JSON.stringify(d)) };
  if (sha) body.sha = sha;
  const res = await fetch(apiUrl(), { method: 'PUT', headers: apiHeaders(), body: JSON.stringify(body) });
  if (res.status === 409 || res.status === 422) return null; // 他の端末が先に更新した
  if (!res.ok) throw new Error(`保存失敗 (${res.status})`);
  return (await res.json()).content.sha;
}

function scheduleSync() {
  if (!gh) return;
  setStatus('未保存');
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, 1500);
}

// リモートを読み込み→手元と統合→差があれば書き込み
async function sync() {
  if (!gh) { setStatus('未設定'); return; }
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  setStatus('同期中…');
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const remote = await fetchRemote();
      const merged = remote.data ? merge(remote.data, data) : data;
      const changed = !remote.data || JSON.stringify(merged) !== JSON.stringify(remote.data);
      let sha = remote.sha;
      if (changed) {
        sha = await putRemote(merged, remote.sha);
        if (!sha) continue; // 競合 → やり直し
      }
      // 通信中に手元で編集された分を取りこぼさないよう、もう一度統合する
      const latest = merge(merged, data);
      const localChanged = JSON.stringify(latest) !== JSON.stringify(data);
      if (JSON.stringify(latest) !== JSON.stringify(merged)) syncAgain = true;
      data = latest;
      remoteSha = sha;
      lsSet(LS_DATA, data);
      lsSet(LS_SHA, remoteSha);
      if (localChanged) { initForms.fillSettings(); render(); }
      const t = new Date();
      setStatus(`同期済 ${pad(t.getHours())}:${pad(t.getMinutes())}`);
      return;
    }
    throw new Error('競合が解消できません');
  } catch (err) {
    setStatus('同期エラー');
    toast(err.message.includes('401') ? 'トークンが無効です（設定を確認）' : err.message);
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; sync(); }
  }
}

function initSync() {
  const f = $('#ghForm');
  if (gh) { f.owner.value = gh.owner; f.repo.value = gh.repo; f.path.value = gh.path; f.token.value = gh.token; }
  f.addEventListener('submit', e => {
    e.preventDefault();
    gh = {
      owner: f.owner.value.trim(),
      repo: f.repo.value.trim() || 'kakeibo-data',
      path: f.path.value.trim() || 'data.json',
      token: f.token.value.trim(),
    };
    if (!gh.owner || !gh.token) { toast('ユーザー名とトークンを入力してください'); gh = null; return; }
    lsSet(LS_GH, gh);
    sync();
  });
  $('#ghForget').addEventListener('click', () => {
    gh = null;
    try { localStorage.removeItem(LS_GH); localStorage.removeItem(LS_SHA); } catch { /* noop */ }
    f.reset();
    setStatus('未設定');
    toast('この端末の同期設定を削除しました（家計簿データは残っています）');
  });
  $('#syncStatus').addEventListener('click', () => (gh ? sync() : showTab('settings')));
  // アプリに戻ってきたとき最新を取得
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && gh) sync(); });
  if (gh) sync();
}

// ---------- 起動 ----------
initForms();
initSync();
render();
