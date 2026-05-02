/**
 * options.dmrml.cn 前端逻辑
 * ================================
 * 复用主站(dmrml.cn)的:
 *   loader 启停(window.DMRLoader, 6 秒动画)
 *   侧栏开合(toggleSidebar 加 body.sidebar-open)
 *   主滚动吸附 + 五段 section
 *   点线导航(IntersectionObserver 联动)
 *   滚动到末段循环
 *   主题切换(dark-mode-toggle, localStorage 'dmr-dark-mode')
 *   tab-bar 切换(.tab-btn / .tab-pane)
 * 业务侧:
 *   多腿组合构造 + 19 套预设
 *   Plotly 渲染 P&L / 时间切片 / 希腊字母 / 三维曲面
 *   关键指标卡片(主站 metric-card 同款,红涨蓝跌)
 *   登录注册模态框 + SQLite 保存策略
 */

// ============================================================
// 状态
// ============================================================
const state = {
    market: { S0: 100, T: 0.5, r: 0.03, q: 0.0, sigma: 0.25 },
    legs: [],
    presets: [],
    presetMeta: null,
    activeTab: 'expiry',
};

// 无贴现模式:r、q 视作 0(教科书首讲期权时的常见简化);σ 仍参与定价
// 首次访问默认开启(localStorage 无值时回落到 true)
// 内部仍叫 IdealMode / opt-ideal-mode,保留命名兼容,UI 文案是"无贴现模式"
const IdealMode = {
    get on() {
        const stored = localStorage.getItem('opt-ideal-mode');
        if (stored === null) return true;   // 首次访问:默认理想化
        return stored === 'true';
    },
    set: function (v) { localStorage.setItem('opt-ideal-mode', String(!!v)); },
    apply: function () { document.body.classList.toggle('ideal-mode', this.on); },
};
// 取当前生效的 r、q(理想模式下强制 0)
function effectiveR() { return IdealMode.on ? 0 : state.market.r; }
function effectiveQ() { return IdealMode.on ? 0 : state.market.q; }
let user = window.OPT_USER || null;
let lastCompute = null;
let surfaceCache = null;
let computeTimer = null;
let computeInflight = null;

// ============================================================
// 工具
// ============================================================
function pct(v, d = 2) { return (v == null || !isFinite(v)) ? '—' : (v * 100).toFixed(d) + '%'; }
function num(v, d = 2) { return (v == null || !isFinite(v)) ? '—' : v.toFixed(d); }
function money(v) { return (v == null || !isFinite(v)) ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2); }
function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
}

// —— 客户端 BS 定价 / 标准正态 CDF。仅用于在 leg 卡片里把"默认权利金"显示成数值,
//    与服务端 (app/pricing.py 的 bs_price) 保持一致 —— //
function _normCdf(x) {
    // Abramowitz & Stegun 26.2.17 近似,绝对误差 < 7.5e-8
    const a1 =  0.254829592, a2 = -0.284496736, a3 =  1.421413741;
    const a4 = -1.453152027, a5 =  1.061405429, p  =  0.3275911;
    const sign = x < 0 ? -1 : 1;
    const ax = Math.abs(x) / Math.SQRT2;
    const t = 1.0 / (1.0 + p * ax);
    const y = 1.0 - (((((a5*t + a4)*t) + a3)*t + a2)*t + a1)*t * Math.exp(-ax*ax);
    return 0.5 * (1.0 + sign * y);
}
function bsPriceClient(S, K, T, r, q, sigma, kind) {
    if (!(S > 0) || !(K > 0)) return null;
    if (T <= 1e-9 || sigma <= 0) {
        return kind === 'call' ? Math.max(0, S - K) : Math.max(0, K - S);
    }
    const sqrtT = Math.sqrt(T);
    const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
    const d2 = d1 - sigma * sqrtT;
    if (kind === 'call') {
        return S * Math.exp(-q * T) * _normCdf(d1) - K * Math.exp(-r * T) * _normCdf(d2);
    }
    return K * Math.exp(-r * T) * _normCdf(-d2) - S * Math.exp(-q * T) * _normCdf(-d1);
}

async function api(path, opts = {}) {
    const resp = await fetch(path, { credentials: 'same-origin', ...opts });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
        const e = new Error(data.detail || ('HTTP ' + resp.status));
        e.status = resp.status;
        throw e;
    }
    return data;
}

function showToast(msg, kind = '') {
    const host = document.getElementById('toast-host');
    if (!host) return;
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 0.4s'; }, 2400);
    setTimeout(() => el.remove(), 2900);
}

// ============================================================
// 主题切换
// ============================================================
function bindDarkModeToggle() {
    const tog = document.getElementById('dark-mode-toggle');
    if (!tog) return;
    tog.checked = document.body.classList.contains('dark-mode');
    tog.addEventListener('change', () => {
        document.body.classList.toggle('dark-mode', tog.checked);
        localStorage.setItem('dmr-dark-mode', String(tog.checked));
        if (lastCompute) renderActiveChart();  // 让图表跟着重画
    });
}

// 理想化模式开关:开启时 r、q 视作 0,关闭时按 r、q 真实贴现
function bindIdealModeToggle() {
    const tog = document.getElementById('ideal-mode-toggle');
    if (!tog) return;
    tog.checked = IdealMode.on;
    IdealMode.apply();
    tog.addEventListener('change', () => {
        IdealMode.set(tog.checked);
        IdealMode.apply();
        renderLegs();          // BS 默认权利金 placeholder 跟着变
        if (state.legs.length) scheduleCompute();
        else renderEmptyExpiry();
    });
}

// ============================================================
// 侧栏(用主站 body.sidebar-open 切换)
// ============================================================
function toggleSidebar() {
    document.body.classList.toggle('sidebar-open');
}

// ============================================================
// 滑块填充
// ============================================================
function updateSliderFill(slider) {
    const min = +slider.min, max = +slider.max, val = +slider.value;
    const pct = (val - min) / (max - min) * 100;
    slider.style.setProperty('--fill', pct + '%');
}

// ============================================================
// 市场参数
// ============================================================
function readMarketFromInputs() {
    state.market.S0    = parseFloat(document.getElementById('m-S0').value) || 100;
    state.market.T     = Math.max(0, parseFloat(document.getElementById('m-T').value) || 0);
    state.market.r     = (parseFloat(document.getElementById('m-r').value) || 0) / 100;
    state.market.q     = (parseFloat(document.getElementById('m-q').value) || 0) / 100;
    state.market.sigma = Math.max(0.001, (parseFloat(document.getElementById('m-sigma').value) || 0) / 100);
}
function refreshMarketDisplay() {
    document.getElementById('v-S0').textContent    = num(state.market.S0, 2);
    document.getElementById('v-T').textContent     = state.market.T.toFixed(2);
    document.getElementById('v-r').textContent     = pct(state.market.r, 2);
    document.getElementById('v-q').textContent     = pct(state.market.q, 2);
    document.getElementById('v-sigma').textContent = pct(state.market.sigma, 1);
    ['m-r', 'm-q', 'm-sigma'].forEach(id => updateSliderFill(document.getElementById(id)));
}
function bindMarketInputs() {
    ['m-S0', 'm-T', 'm-r', 'm-q', 'm-sigma'].forEach(id => {
        const el = document.getElementById(id);
        el.addEventListener('input', () => {
            readMarketFromInputs();
            refreshMarketDisplay();
            scheduleCompute();
        });
    });
}

// ============================================================
// Legs 构造
// ============================================================
function legHasStrike(kind) { return kind === 'call' || kind === 'put'; }
function legHasSigma(kind)  { return kind === 'call' || kind === 'put'; }

function renderLegs() {
    const strip = document.getElementById('legs-strip');
    if (!strip) return;
    if (!state.legs.length) {
        strip.innerHTML = '';
        return;
    }
    strip.innerHTML = state.legs.map((leg, i) => {
        const sideCls = leg.qty > 0 ? 'long' : 'short';
        const sideTxt = leg.qty > 0 ? `+${leg.qty}` : `${leg.qty}`;
        const kindLabel = ({ call: 'Call', put: 'Put', underlying: '现货', forward: '远期' })[leg.kind];

        // 价 / 行权价 / 交割价 行
        let priceRow;
        if (legHasStrike(leg.kind)) {
            priceRow = `<div class="leg-row"><span class="lk">K</span>
                <input type="number" step="any" data-i="${i}" data-f="K" value="${leg.K ?? ''}" placeholder="行权价"></div>`;
        } else if (leg.kind === 'forward') {
            priceRow = `<div class="leg-row"><span class="lk">F</span>
                <input type="number" step="any" data-i="${i}" data-f="forward_price" value="${leg.forward_price ?? ''}" placeholder="交割价"></div>`;
        } else {
            priceRow = `<div class="leg-row"><span class="lk">买入价</span>
                <input type="number" step="any" data-i="${i}" data-f="premium" value="${leg.premium ?? ''}" placeholder="买入价"></div>`;
        }
        // σ(仅 Call/Put):placeholder 显示全局 σ 实际百分比,留空就是默认用这个值
        // 无贴现模式只影响 r、q,σ 始终正常参与定价,所以这一行无论开关与否都渲染
        const sigmaPctDefault = (state.market.sigma * 100).toFixed(2);
        const sigmaRow = legHasSigma(leg.kind)
            ? `<div class="leg-row"><span class="lk">σ</span>
                <input type="number" step="any" min="0.01" max="500" data-i="${i}" data-f="sigma_pct"
                    value="${leg.sigma != null ? (leg.sigma * 100).toFixed(2) : ''}" placeholder="${sigmaPctDefault}" title="留空时使用侧栏的全局隐含波动率;填入则覆盖,只对这条 leg 生效">
                <span class="lsuffix">%</span></div>`
            : '';
        // 权利金(仅 Call/Put):placeholder 显示 BS 公式自算的理论价(2 位小数,不藏精度)
        // 理想化模式下用 r=q=0 算,这样 placeholder 跟服务端实际定价一致
        let premPlaceholder = '';
        if (leg.kind === 'call' || leg.kind === 'put') {
            const sig = leg.sigma != null ? leg.sigma : state.market.sigma;
            const bsP = bsPriceClient(state.market.S0, leg.K, state.market.T, effectiveR(), effectiveQ(), sig, leg.kind);
            premPlaceholder = (bsP != null && isFinite(bsP)) ? bsP.toFixed(2) : '';
        }
        const premRow = (leg.kind === 'call' || leg.kind === 'put')
            ? `<div class="leg-row"><span class="lk">权利金</span>
                <input type="number" step="any" data-i="${i}" data-f="premium" value="${leg.premium ?? ''}" placeholder="${premPlaceholder}" title="留空时按 Black-Scholes 模型自动定价;填入则按你输入的成交价计算盈亏"></div>`
            : '';
        // 数量
        const qtyRow = `<div class="leg-row"><span class="lk">数量</span>
            <input type="number" step="1" data-i="${i}" data-f="qty" value="${Math.abs(leg.qty)}" class="${sideCls}"></div>`;
        // 备注(全宽,放最末)
        const noteRow = `<div class="leg-row full"><span class="lk">备注</span>
            <input type="text" maxlength="40" data-i="${i}" data-f="label" value="${escapeHTML(leg.label || '')}" placeholder="${kindLabel}"></div>`;

        // 网格排布:
        //   Call/Put:(K,σ) (权利金,数量) (备注 全宽) → 3 行
        //   Forward / 现货:(price,数量) (备注 全宽) → 2 行
        let gridInner;
        if (leg.kind === 'call' || leg.kind === 'put') {
            gridInner = priceRow + sigmaRow + premRow + qtyRow + noteRow;
        } else {
            gridInner = priceRow + qtyRow + noteRow;
        }

        return `<div class="leg-card">
            <button class="leg-card-x" onclick="removeLeg(${i})" title="删除">×</button>
            <div class="leg-card-head">
                <span class="leg-card-kind">${kindLabel}</span>
                <span class="leg-card-side ${sideCls}" onclick="flipLegSide(${i})" title="点击切换多空">${sideTxt}</span>
            </div>
            <div class="leg-card-grid">${gridInner}</div>
        </div>`;
    }).join('');
    strip.querySelectorAll('input').forEach(inp => inp.addEventListener('input', onLegFieldChange));
}

function flipLegSide(i) {
    const leg = state.legs[i];
    if (!leg) return;
    leg.qty = -leg.qty || 1;
    state.presetMeta = null;
    renderLegs();
    scheduleCompute();
}

function onLegFieldChange(e) {
    const i = +e.target.dataset.i, f = e.target.dataset.f, v = e.target.value;
    const leg = state.legs[i];
    if (!leg) return;
    if (f === 'qty') {
        const newAbs = Math.abs(parseFloat(v) || 0);
        // 保留原方向(多/空)
        leg.qty = leg.qty < 0 ? -newAbs : newAbs;
        if (newAbs === 0) leg.qty = 0;
    }
    else if (f === 'K')            leg.K = v === '' ? null : parseFloat(v);
    else if (f === 'sigma_pct')    leg.sigma = (v === '' || isNaN(parseFloat(v))) ? null : parseFloat(v) / 100;
    else if (f === 'premium')      leg.premium = v === '' ? null : parseFloat(v);
    else if (f === 'forward_price') leg.forward_price = v === '' ? null : parseFloat(v);
    else if (f === 'label')        leg.label = v;
    state.presetMeta = null;
    scheduleCompute();
}

function addLeg(kind) {
    const S0 = state.market.S0;
    const newLeg = { kind, qty: 1, label: '' };
    if (kind === 'call' || kind === 'put') newLeg.K = +S0.toFixed(2);
    if (kind === 'underlying') newLeg.premium = +S0.toFixed(2);
    if (kind === 'forward') newLeg.forward_price = +S0.toFixed(2);
    state.legs.push(newLeg);
    state.presetMeta = null;
    renderLegs();
    scheduleCompute();
}
function clearMetrics() {
    ['metrics-hero', 'metrics-greeks', 'metrics-bottom-left'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = '';
    });
    const edu = document.getElementById('edu-card');
    if (edu) edu.style.display = 'none';
}

function removeLeg(i) {
    state.legs.splice(i, 1);
    state.presetMeta = null;
    renderLegs();
    if (!state.legs.length) {
        lastCompute = null;
        clearMetrics();
        renderEmptyExpiry();
    }
    scheduleCompute();
}
function clearLegs() {
    state.legs = [];
    state.presetMeta = null;
    lastCompute = null;
    renderLegs();
    clearMetrics();
    renderEmptyExpiry();
}

// ============================================================
// 预设
// ============================================================
const CAT_LABELS = {
    directional: '方向性',
    vol:         '波动率多空',
    neutral:     '区间中性',
    spot_combo:  '组合现货',
    synthetic:   '合成与套利',
};

async function loadPresets() {
    try {
        const data = await api('/api/presets');
        state.presets = data.presets;
        renderPresets();
    } catch (e) {
        ['directional', 'vol', 'neutral', 'spot_combo', 'synthetic'].forEach(c => {
            const el = document.getElementById('preset-list-' + c);
            if (el) el.textContent = '加载失败';
        });
    }
}
function renderPresets() {
    // 渲染到侧栏的 5 个分类容器(主站 sidebar-details 默认收起)
    const groups = {};
    state.presets.forEach(p => { (groups[p.category] = groups[p.category] || []).push(p); });
    Object.keys(groups).forEach(cat => {
        const target = document.getElementById('preset-list-' + cat);
        if (!target) return;
        target.innerHTML = groups[cat].map(p => `
            <button class="preset-item" onclick="applyPreset('${p.key}')">
                <span class="name">${escapeHTML(p.label)}</span>
                <span class="view">${escapeHTML(p.view)}</span>
            </button>`).join('');
    });
}
async function applyPreset(key) {
    const meta = state.presets.find(p => p.key === key);
    try {
        const data = await api(`/api/presets/${encodeURIComponent(key)}/build`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ S0: state.market.S0, sigma: state.market.sigma }),
        });
        state.legs = data.legs.map(l => ({
            kind: l.kind, qty: l.qty, K: l.K ?? null, sigma: l.sigma ?? null,
            premium: l.premium ?? null, forward_price: l.forward_price ?? null,
            label: l.label || '',
        }));
        state.presetMeta = meta || null;
        renderLegs();
        scheduleCompute();
    } catch (e) { showToast('预设加载失败 ' + e.message, 'error'); }
}

// ============================================================
// 计算
// ============================================================
function scheduleCompute() {
    if (computeTimer) clearTimeout(computeTimer);
    computeTimer = setTimeout(runCompute, 220);
}
function buildPayload() {
    // 理想化模式开启时,服务端拿到 r=q=0 进行定价
    const market = { ...state.market };
    if (IdealMode.on) { market.r = 0; market.q = 0; }
    return {
        market,
        legs: state.legs.map(l => {
            const out = { kind: l.kind, qty: l.qty };
            if (l.K != null) out.K = l.K;
            if (l.sigma != null) out.sigma = l.sigma;
            if (l.premium != null) out.premium = l.premium;
            if (l.forward_price != null) out.forward_price = l.forward_price;
            if (l.label) out.label = l.label;
            return out;
        }),
    };
}
async function runCompute() {
    if (!state.legs.length) return;
    for (const l of state.legs) {
        if ((l.kind === 'call' || l.kind === 'put') && (l.K == null || isNaN(l.K))) return;
        if (l.qty == null || isNaN(l.qty) || l.qty === 0) return;
    }
    if (computeInflight) computeInflight.abort = true;
    const tag = { abort: false };
    computeInflight = tag;
    try {
        const data = await api('/api/compute', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(buildPayload()),
        });
        if (tag.abort) return;
        lastCompute = data;
        renderSummary(data);
        renderEduCard();
        surfaceCache = null;
        renderActiveChart();
    } catch (e) {
        if (!tag.abort) showToast('计算失败 ' + e.message, 'error');
    }
}

// ============================================================
// 关键指标(主站 metric-card 同款,红涨蓝跌)
// ============================================================
function renderSummary(data) {
    const s = data.summary;

    // —— Hero 三张大卡(红涨蓝跌)——
    const heroCells = [
        { label: '最大盈利',
          value: s.max_profit == null ? '∞' : money(s.max_profit),
          cls: (s.max_profit != null && s.max_profit > 0) ? 'pos' : '' },
        { label: '最大亏损',
          value: s.max_loss == null ? '−∞' : money(s.max_loss),
          cls: (s.max_loss != null && s.max_loss < 0) ? 'neg' : '' },
        { label: '净保费',
          value: money(-s.net_cost),
          cls: (s.net_cost > 0) ? 'neg' : (s.net_cost < 0 ? 'pos' : ''),
          sub: s.net_cost > 0 ? '净付出' : (s.net_cost < 0 ? '净收入' : '零成本') },
    ];
    document.getElementById('metrics-hero').innerHTML = heroCells.map(c => `
        <div class="metric-hero-card">
            <div class="lab">${c.label}</div>
            <div class="val ${c.cls || ''}">${c.value}</div>
            ${c.sub ? `<div class="sub">${c.sub}</div>` : ''}
        </div>`).join('');

    // —— 五张希腊字母 tile ——
    const g = s.greeks_at_spot;
    const greekCells = [
        { sym: 'Δ', name: 'Delta', v: g.delta.toFixed(3) },
        { sym: 'Γ', name: 'Gamma', v: g.gamma.toFixed(4) },
        { sym: 'ν', name: 'Vega',  v: g.vega.toFixed(3) },
        { sym: 'Θ', name: 'Theta', v: g.theta.toFixed(3) },
        { sym: 'ρ', name: 'Rho',   v: g.rho.toFixed(3) },
    ];
    document.getElementById('metrics-greeks').innerHTML = greekCells.map(c => `
        <div class="greek-tile">
            <div class="sym">${c.sym}</div>
            <div class="name">${c.name}</div>
            <div class="v">${c.v}</div>
        </div>`).join('');

    // —— 底部左:两张次要卡(2×2 占位,目前两条)——
    const bottomCells = [
        { label: '盈亏平衡点',
          value: s.breakevens.length ? s.breakevens.map(v => num(v, 2)).join(' / ') : '—',
          sub: s.breakevens.length ? `共 ${s.breakevens.length} 个` : '' },
        { label: '盈利概率',
          value: pct(s.prob_profit, 1),
          sub: '对数正态假设下' },
    ];
    document.getElementById('metrics-bottom-left').innerHTML = bottomCells.map(c => `
        <div class="metric-card">
            <div class="metric-label">${c.label}</div>
            <div class="metric-value">${c.value}</div>
            ${c.sub ? `<div class="metric-delta">${c.sub}</div>` : ''}
        </div>`).join('');
}

function renderEduCard() {
    const card = document.getElementById('edu-card');
    const titleEl = document.getElementById('edu-title');
    const bodyEl = document.getElementById('edu-body');
    if (state.presetMeta) {
        // 加载了一个预设:显示预设的市场观点和适用场景
        titleEl.textContent = state.presetMeta.label;
        bodyEl.textContent = state.presetMeta.view;
    } else if (state.legs.length) {
        // —— 自定义组合:基于实际 legs 生成画像 —— //

        // 1) 多方 / 空方 列表(列出每条 leg 的种类与关键参数)
        const fmtLeg = (l) => {
            const kindLabel = ({ call: 'Call', put: 'Put', underlying: '现货', forward: '远期' })[l.kind];
            const q = Math.abs(l.qty);
            const qPart = q > 1 ? `${q}× ` : '';
            if (l.kind === 'call' || l.kind === 'put')
                return `${qPart}${kindLabel} K=${l.K ?? '?'}`;
            if (l.kind === 'forward')
                return `${qPart}${kindLabel} F=${l.forward_price ?? '?'}`;
            return `${qPart}${kindLabel}`;
        };
        const longList  = state.legs.filter(l => l.qty > 0).map(fmtLeg);
        const shortList = state.legs.filter(l => l.qty < 0).map(fmtLeg);
        const longText  = longList.length  ? longList.join('、')  : '无';
        const shortText = shortList.length ? shortList.join('、') : '无';

        // 2) Δ 倾向(刻度调温和,ATM long call ≈ 0.5 应判"温和看涨"而非"显著为正")
        let stance = '方向中性';
        if (lastCompute && lastCompute.summary && lastCompute.summary.greeks_at_spot) {
            const d = lastCompute.summary.greeks_at_spot.delta;
            if (d >  0.6)       stance = '看涨偏向显著';
            else if (d >  0.2)  stance = '温和看涨';
            else if (d > -0.2)  stance = '方向中性';
            else if (d > -0.6)  stance = '温和看跌';
            else                stance = '看跌偏向显著';
        }

        // 3) 风险结构:从 legs 自身的右端斜率推断,而不是依赖服务端 max_profit/max_loss
        //    (服务端 max 是在有限 S 网格上取的最大值,长 Call 单腿那种"右端发散"的情形会被误判成封顶)
        //    Call / Underlying / Forward 的 qty 决定 S→∞ 时的 P&L 斜率;Put 在右端饱和不计
        let rightSlope = 0;
        state.legs.forEach(l => {
            if (l.kind === 'call' || l.kind === 'underlying' || l.kind === 'forward') {
                rightSlope += l.qty;
            }
        });
        let riskShape;
        if (rightSlope > 0)        riskShape = '亏损封顶、盈利无上限,典型的"有限成本博无限上行"。';
        else if (rightSlope < 0)   riskShape = '盈利封顶、亏损无上限,卖方策略,需要保证金管理。';
        else                       riskShape = '盈利与亏损均有上限,风险收益结构封闭。';

        titleEl.textContent = '自定义组合';
        bodyEl.innerHTML = `
            多方:${longText}<br>
            空方:${shortText}<br>
            ${stance};${riskShape}`;
    } else {
        // 无 leg:邀请用户搭建
        titleEl.textContent = '尚未搭建组合';
        bodyEl.textContent = '在第一页用 Call、Put、现货、远期任意搭配,或从侧栏选一个预设策略加载;这里会显示组合的市场观点与适用画像。';
    }
    card.style.display = '';
}

// ============================================================
// Plotly
// ============================================================
function isDark() { return document.body.classList.contains('dark-mode'); }
function plotlyLayout() {
    const dark = isDark();
    const text = dark ? '#F2EDE5' : '#2D2A26';
    const muted = dark ? '#A89F92' : '#8B8680';
    const grid = dark ? '#322C25' : '#E8E4DE';
    return {
        font: { family: 'Georgia, Times New Roman, Songti SC, STSong, serif', color: text, size: 12 },
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(0,0,0,0)',
        margin: { l: 56, r: 24, t: 24, b: 48 },
        xaxis: { gridcolor: grid, zeroline: true, zerolinecolor: muted, zerolinewidth: 1, tickfont: { color: text }, title: { font: { color: text } } },
        yaxis: { gridcolor: grid, zeroline: true, zerolinecolor: muted, zerolinewidth: 1, tickfont: { color: text }, title: { font: { color: text } } },
        legend: { font: { color: text }, bgcolor: 'rgba(0,0,0,0)' },
        hovermode: 'x unified',
    };
}
const PLOTLY_CFG = { responsive: true, displaylogo: false, modeBarButtonsToRemove: ['select2d', 'lasso2d'] };

function renderActiveChart() {
    if (!lastCompute) return;
    // section 01 主图、section 03 时间切片、section 04 希腊都常驻渲染
    renderExpiry();
    renderSlices();
    renderGreeks();
}

// 没有 leg 时:画一张只有数轴的占位图,而不是完全空白
function renderEmptyExpiry() {
    const el = document.getElementById('chart-expiry');
    if (!el || typeof Plotly === 'undefined') return;
    const layout = plotlyLayout();
    const S0 = state.market.S0 || 100;
    const half = Math.max(20, S0 * 0.4);
    layout.xaxis.title = '标的价格 S';
    layout.yaxis.title = '到期 P&L';
    layout.xaxis.range = [Math.max(0, S0 - half), S0 + half];
    layout.yaxis.range = [-half * 0.4, half * 0.4];
    layout.shapes = [{
        type: 'line', xref: 'x', yref: 'y',
        x0: S0, x1: S0, y0: -half * 0.4, y1: half * 0.4,
        line: { color: isDark() ? '#A89F92' : '#8B8680', width: 1, dash: 'dot' },
    }];
    layout.annotations = [{
        x: S0, y: half * 0.4,
        text: `S₀ = ${num(S0, 2)}`, showarrow: false, yshift: 12,
        font: { color: isDark() ? '#A89F92' : '#8B8680', size: 11 },
    }, {
        x: S0, y: 0,
        text: '在上方添加 Call / Put / 现货 / 远期,或在侧栏选一个预设策略',
        showarrow: false,
        font: { color: isDark() ? '#A89F92' : '#8B8680', size: 12 },
    }];
    Plotly.react('chart-expiry', [], layout, PLOTLY_CFG);
}

// 红=涨/盈利, 蓝=跌/亏损
const COLOR_GAIN = '#A0403C';
const COLOR_LOSS = '#3D5A80';
const COLOR_GAIN_FILL = 'rgba(160,64,60,0.16)';
const COLOR_LOSS_FILL = 'rgba(61,90,128,0.16)';

function renderExpiry() {
    const d = lastCompute;
    const layout = plotlyLayout();
    layout.xaxis.title = '标的价格 S';
    layout.yaxis.title = '到期 P&L';
    // 算 y 范围,把所有 leg + 总和都纳入
    let allY = d.pnl_expiry.slice();
    if (d.legs_pnl) d.legs_pnl.forEach(l => { allY = allY.concat(l.pnl); });
    const yMin = Math.min(...allY), yMax = Math.max(...allY);

    layout.shapes = [{
        type: 'line', xref: 'x', yref: 'y',
        x0: state.market.S0, x1: state.market.S0,
        y0: yMin, y1: yMax,
        line: { color: isDark() ? '#A89F92' : '#8B8680', width: 1, dash: 'dot' },
    }];
    layout.annotations = [{
        x: state.market.S0, y: yMax,
        text: `S₀ = ${num(state.market.S0, 2)}`, showarrow: false, yshift: 12,
        font: { color: isDark() ? '#A89F92' : '#8B8680', size: 11 },
    }];
    d.summary.breakevens.forEach((be) => {
        layout.annotations.push({
            x: be, y: 0, text: `${num(be, 2)}`, showarrow: true, arrowhead: 2,
            ax: 0, ay: -28, font: { color: COLOR_GAIN, size: 11 },
        });
    });

    // 配色:每条 leg 用一组柔和的颜色,各自虚线;组合用红色实线突出
    // 12 色色板,日常组合(≤8 条 leg)不会重复
    const legColors = [
        '#8E6FB0', '#C49A4B', '#5A8A6A', '#6B89B5',
        '#A8826F', '#7A8B7C', '#B4644A', '#4A6B7C',
        '#9C8E6A', '#7B5C8A', '#5A8A8A', '#A0826B',
    ];
    const traces = [];

    // 1) 亏损区(蓝阴影)
    traces.push({
        x: d.S, y: d.pnl_expiry.map(v => v < 0 ? v : 0),
        type: 'scatter', mode: 'lines', line: { width: 0 }, fill: 'tozeroy',
        fillcolor: COLOR_LOSS_FILL, hoverinfo: 'skip', showlegend: false,
    });
    // 2) 盈利区(红阴影)
    traces.push({
        x: d.S, y: d.pnl_expiry.map(v => v > 0 ? v : 0),
        type: 'scatter', mode: 'lines', line: { width: 0 }, fill: 'tozeroy',
        fillcolor: COLOR_GAIN_FILL, hoverinfo: 'skip', showlegend: false,
    });
    // 3) 各条 leg(虚线):hover 用单行格式,在 unified 浮窗里更紧凑
    if (d.legs_pnl && d.legs_pnl.length > 1) {
        d.legs_pnl.forEach((leg, i) => {
            traces.push({
                x: d.S, y: leg.pnl,
                type: 'scatter', mode: 'lines',
                name: leg.label,
                line: { color: legColors[i % legColors.length], width: 1.5, dash: 'dash' },
                opacity: 0.85,
                hovertemplate: `${leg.label}: %{y:.2f}<extra></extra>`,
            });
        });
    }
    // 4) 组合总和(实线,粗,红色)
    traces.push({
        x: d.S, y: d.pnl_expiry,
        type: 'scatter', mode: 'lines',
        name: '组合 P&L',
        line: { color: COLOR_GAIN, width: 2.8 },
        hovertemplate: '<b>组合</b>: %{y:.2f}<extra></extra>',
    });

    layout.legend = {
        font: { color: layout.font.color }, bgcolor: 'rgba(0,0,0,0)',
        orientation: 'h', x: 0, y: -0.15,
    };
    Plotly.react('chart-expiry', traces, layout, PLOTLY_CFG);
}

function renderSlices() {
    const d = lastCompute;
    const layout = plotlyLayout();
    layout.xaxis.title = '标的价格 S';
    layout.yaxis.title = 'P&L';
    layout.margin = { l: 56, r: 110, t: 24, b: 48 };  // 留右边给曲线末端标签
    const colors = [COLOR_GAIN, '#C49A4B', COLOR_LOSS, '#5A8A6A'];
    const traces = d.slices.map((sl, i) => ({
        x: d.S, y: sl.pnl, type: 'scatter', mode: 'lines',
        name: sl.label,
        line: { color: colors[i % colors.length], width: i === 0 ? 2.5 : 1.8 },
        opacity: i === 0 ? 1.0 : 0.85,
        showlegend: false,
        hovertemplate: `${sl.label}<br>S=%{x:.2f}<br>P&L=%{y:.2f}<extra></extra>`,
    }));
    layout.shapes = [{
        type: 'line', xref: 'x', yref: 'paper',
        x0: state.market.S0, x1: state.market.S0, y0: 0, y1: 1,
        line: { color: isDark() ? '#A89F92' : '#8B8680', width: 1, dash: 'dot' },
    }];
    // 曲线右端直接打时间标签(主站净值图同款手法)
    layout.annotations = d.slices.map((sl, i) => ({
        xref: 'x', yref: 'y',
        x: d.S[d.S.length - 1], y: sl.pnl[sl.pnl.length - 1],
        text: sl.label,
        showarrow: false,
        xanchor: 'left', yanchor: 'middle',
        xshift: 6,
        font: { color: colors[i % colors.length], size: 12, family: 'Georgia, serif' },
    }));
    Plotly.react('chart-slices', traces, layout, PLOTLY_CFG);
}

function renderGreeks() {
    const d = lastCompute;
    const greeks = ['delta', 'gamma', 'vega', 'theta', 'rho'];
    const greekLabels = { delta: 'Δ Delta', gamma: 'Γ Gamma', vega: 'ν Vega', theta: 'Θ Theta', rho: 'ρ Rho' };
    const colors = { delta: COLOR_GAIN, gamma: '#C49A4B', vega: COLOR_LOSS, theta: '#8E6FB0', rho: '#5A8A6A' };

    greeks.forEach(g => {
        const layout = plotlyLayout();
        layout.title = {
            text: greekLabels[g],
            font: { family: 'Georgia, serif', size: 14, color: layout.font.color },
            x: 0.04, y: 0.94, xanchor: 'left', yanchor: 'top',
        };
        layout.margin = { l: 48, r: 16, t: 36, b: 36 };
        layout.showlegend = false;
        // S₀ 竖虚线
        layout.shapes = [{
            type: 'line', xref: 'x', yref: 'paper',
            x0: state.market.S0, x1: state.market.S0, y0: 0, y1: 1,
            line: { color: isDark() ? '#A89F92' : '#8B8680', width: 1, dash: 'dot' },
        }];
        const trace = {
            x: d.S, y: d.greeks[g], type: 'scatter', mode: 'lines',
            line: { color: colors[g], width: 2 },
            hovertemplate: `${greekLabels[g]}<br>S=%{x:.2f}<br>%{y:.4f}<extra></extra>`,
        };
        Plotly.react('greek-' + g, [trace], layout, PLOTLY_CFG);
    });

    // 第六格:S₀ 处希腊值清单,每行附一句人话解释
    const sg = d.summary.greeks_at_spot;
    const cell = document.getElementById('greek-summary');
    cell.innerHTML = `
        <div class="greek-summary-title">当前组合的希腊值</div>
        <div class="greek-summary-sub">在 S₀ = ${num(state.market.S0, 2)},距到期 ${state.market.T.toFixed(2)} 年的位置</div>
        <div class="greek-summary-row">
            <span><span class="sym">Δ</span><span class="name">标的价格变动 1 单位,组合损益变化</span></span>
            <span class="v">${sg.delta.toFixed(3)}</span>
        </div>
        <div class="greek-summary-row">
            <span><span class="sym">Γ</span><span class="name">Delta 自身随标的的变化率</span></span>
            <span class="v">${sg.gamma.toFixed(4)}</span>
        </div>
        <div class="greek-summary-row">
            <span><span class="sym">ν</span><span class="name">波动率涨 1 个百分点,组合损益变化</span></span>
            <span class="v">${sg.vega.toFixed(3)}</span>
        </div>
        <div class="greek-summary-row">
            <span><span class="sym">Θ</span><span class="name">每过去一年的自然时间损耗</span></span>
            <span class="v">${sg.theta.toFixed(3)}</span>
        </div>
        <div class="greek-summary-row">
            <span><span class="sym">ρ</span><span class="name">无风险利率涨 1 个百分点,组合损益变化</span></span>
            <span class="v">${sg.rho.toFixed(3)}</span>
        </div>`;
}

async function refreshSurface() {
    if (!state.legs.length || !lastCompute) return;
    if (!surfaceCache) {
        try {
            surfaceCache = await api('/api/compute_surface', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(buildPayload()),
            });
        } catch (e) { showToast('3D 曲面计算失败 ' + e.message, 'error'); return; }
    }
    const d = surfaceCache;
    const layout = plotlyLayout();
    layout.margin = { l: 0, r: 0, t: 0, b: 0 };
    layout.scene = {
        xaxis: { title: '标的价格 S', color: layout.font.color, gridcolor: layout.xaxis.gridcolor },
        yaxis: { title: '剩余年限 T', color: layout.font.color, gridcolor: layout.yaxis.gridcolor },
        zaxis: { title: 'P&L', color: layout.font.color, gridcolor: layout.yaxis.gridcolor },
        bgcolor: 'rgba(0,0,0,0)',
        // 调相机:正向 P&L 朝观众
        camera: { eye: { x: 1.4, y: -1.6, z: 1.1 }, center: { x: 0, y: 0, z: -0.05 } },
        aspectratio: { x: 1.4, y: 1.0, z: 0.9 },
    };
    delete layout.xaxis; delete layout.yaxis;
    const trace = {
        type: 'surface', x: d.S, y: d.T, z: d.Z,
        colorscale: [[0, '#3D5A80'], [0.45, '#FAFAF7'], [0.55, '#FAFAF7'], [1, '#A0403C']],
        cmid: 0,
        contours: { z: { show: true, usecolormap: true, project: { z: true } } },
        colorbar: { thickness: 14, outlinewidth: 0, x: 1.0, len: 0.85, ypad: 10 },
    };
    Plotly.react('chart-surface', [trace], layout, PLOTLY_CFG);
}

// ============================================================
// Tab(主站同名 .tab-btn / .tab-pane)
// ============================================================
function initTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.tab;
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
            const pane = document.getElementById('tab-' + tab);
            if (pane) pane.classList.add('active');
            state.activeTab = tab;
            renderActiveChart();
            setTimeout(() => {
                const el = document.getElementById('chart-' + tab);
                if (el && el.data) Plotly.Plots.resize(el);
            }, 60);
        });
    });
}

// ============================================================
// 点线导航 + section IntersectionObserver(主站同款)
// ============================================================
function initDotNav() {
    const mainContent = document.getElementById('main-content');
    const sections = document.querySelectorAll('.content-section');
    const dots = document.querySelectorAll('.dot-item');

    dots.forEach(dot => {
        dot.addEventListener('click', () => {
            const target = document.getElementById(dot.dataset.section);
            if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    });

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const id = entry.target.id;
                dots.forEach(d => d.classList.remove('active'));
                const active = document.querySelector(`.dot-item[data-section="${id}"]`);
                if (active) active.classList.add('active');
                entry.target.classList.add('section-active');

                // section-greeks / section-surface 是懒渲染:进入视野再算
                if (id === 'section-surface') refreshSurface();

                setTimeout(() => {
                    entry.target.querySelectorAll('.chart-box').forEach(el => {
                        if (el.data) Plotly.Plots.resize(el);
                    });
                }, 100);
            } else {
                entry.target.classList.remove('section-active');
            }
        });
    }, { root: mainContent, rootMargin: '-20% 0px -70% 0px' });

    sections.forEach(s => observer.observe(s));
}

function initScrollHint() {
    const mainContent = document.getElementById('main-content');
    const hint = document.getElementById('scroll-hint');
    if (!hint) return;
    let hidden = false;
    mainContent.addEventListener('scroll', () => {
        if (!hidden && mainContent.scrollTop > 80) {
            hint.classList.add('hidden');
            hidden = true;
        }
    }, { passive: true });
}

// 末段循环回首段(主站同款)
function initLoopScroll() {
    const mainContent = document.getElementById('main-content');
    const lastSection = document.getElementById('section-surface');
    let looping = false;
    function loopToFirst() {
        if (looping) return;
        looping = true;
        mainContent.style.transition = 'opacity 0.35s ease';
        mainContent.style.opacity = '0';
        setTimeout(() => {
            mainContent.style.scrollBehavior = 'auto';
            mainContent.scrollTop = 0;
            mainContent.style.scrollBehavior = 'smooth';
            requestAnimationFrame(() => {
                mainContent.style.opacity = '1';
                setTimeout(() => { mainContent.style.transition = ''; looping = false; }, 400);
            });
        }, 350);
    }
    mainContent.addEventListener('wheel', (e) => {
        if (e.deltaY > 0 && lastSection.classList.contains('section-active')) {
            e.preventDefault();
            loopToFirst();
        }
    }, { passive: false });
    let touchStartY = 0;
    mainContent.addEventListener('touchstart', (e) => { touchStartY = e.touches[0].clientY; }, { passive: true });
    mainContent.addEventListener('touchend', (e) => {
        const diff = touchStartY - e.changedTouches[0].clientY;
        if (diff > 50 && lastSection.classList.contains('section-active')) loopToFirst();
    }, { passive: true });
}

// ============================================================
// 我的策略
// ============================================================
async function refreshStrategyList() {
    const ul = document.getElementById('strategy-list');
    if (!user) {
        ul.innerHTML = `<li class="empty"><a href="#" onclick="openAuth('login'); return false;" style="color:var(--primary);">登录</a>后即可在云端保存组合</li>`;
        return;
    }
    try {
        const data = await api('/api/strategies/');
        if (!data.strategies.length) {
            ul.innerHTML = '<li class="empty">还没有保存的策略</li>';
            return;
        }
        ul.innerHTML = data.strategies.map(s => `
            <li>
                <div style="flex:1; min-width:0; overflow:hidden;">
                    <div class="name">${escapeHTML(s.name)}</div>
                    <div class="meta">${s.updated_at.replace('T', ' ').slice(0, 16)}</div>
                </div>
                <div class="actions">
                    <button class="strategy-mini-btn" onclick="loadStrategy(${s.id})">加载</button>
                    <button class="strategy-mini-btn danger" onclick="deleteStrategy(${s.id})">×</button>
                </div>
            </li>`).join('');
    } catch (e) {
        if (e.status === 401) { user = null; refreshStrategyList(); return; }
        ul.innerHTML = `<li class="empty">加载失败 ${escapeHTML(e.message)}</li>`;
    }
}
async function loadStrategy(id) {
    try {
        const s = await api('/api/strategies/' + id);
        const p = s.payload;
        state.market = { ...state.market, ...p.market };
        state.legs = p.legs.map(l => ({
            kind: l.kind, qty: l.qty, K: l.K ?? null, sigma: l.sigma ?? null,
            premium: l.premium ?? null, forward_price: l.forward_price ?? null,
            label: l.label || '',
        }));
        state.presetMeta = null;
        document.getElementById('m-S0').value = state.market.S0;
        document.getElementById('m-T').value  = state.market.T;
        document.getElementById('m-r').value  = (state.market.r * 100).toFixed(2);
        document.getElementById('m-q').value  = (state.market.q * 100).toFixed(2);
        document.getElementById('m-sigma').value = (state.market.sigma * 100).toFixed(2);
        refreshMarketDisplay();
        renderLegs();
        scheduleCompute();
        showToast('已加载 ' + s.name, 'success');
        document.body.classList.remove('sidebar-open');
    } catch (e) { showToast('加载失败 ' + e.message, 'error'); }
}
async function deleteStrategy(id) {
    if (!confirm('确认删除这个策略吗')) return;
    try {
        await api('/api/strategies/' + id, { method: 'DELETE' });
        await refreshStrategyList();
        showToast('已删除', 'success');
    } catch (e) { showToast('删除失败 ' + e.message, 'error'); }
}

function openSaveDialog() {
    if (!state.legs.length) { showToast('当前还没有 Leg', 'error'); return; }
    if (!user) {
        showToast('保存策略需要登录', 'error');
        openAuth('login', { onSuccess: () => openSaveDialog() });
        return;
    }
    document.getElementById('save-name').value = state.presetMeta ? state.presetMeta.label : '';
    document.getElementById('save-desc').value = '';
    document.getElementById('save-dialog').style.display = 'flex';
    setTimeout(() => document.getElementById('save-name').focus(), 50);
}
function closeSaveDialog() { document.getElementById('save-dialog').style.display = 'none'; }
async function confirmSaveStrategy() {
    const name = document.getElementById('save-name').value.trim();
    const desc = document.getElementById('save-desc').value.trim();
    if (!name) { showToast('请输入名称', 'error'); return; }
    try {
        await api('/api/strategies/', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, description: desc, payload: buildPayload() }),
        });
        closeSaveDialog();
        await refreshStrategyList();
        showToast('已保存', 'success');
    } catch (e) {
        if (e.status === 401) {
            closeSaveDialog();
            openAuth('login', { onSuccess: () => openSaveDialog() });
        } else {
            showToast('保存失败 ' + e.message, 'error');
        }
    }
}

// ============================================================
// 登录 / 注册模态框
// ============================================================
let _authMode = 'login';
let _authOnSuccess = null;
function openAuth(mode = 'login', opts = {}) {
    _authMode = mode;
    _authOnSuccess = opts.onSuccess || null;
    switchAuthTab(mode);
    document.getElementById('auth-modal').style.display = 'flex';
    setTimeout(() => {
        const f = document.querySelector('#auth-modal-form input[name="email"]');
        if (f) f.focus();
    }, 50);
}
function closeAuth() {
    document.getElementById('auth-modal').style.display = 'none';
    document.getElementById('auth-modal-error').classList.remove('show');
}
function switchAuthTab(mode) {
    _authMode = mode;
    document.querySelectorAll('.opt-modal-tab').forEach(t => t.classList.toggle('active', t.dataset.mode === mode));
    document.getElementById('row-display-name').style.display = (mode === 'register') ? '' : 'none';
    document.getElementById('auth-modal-submit').textContent = (mode === 'register') ? '注册并登录' : '登录';
    document.getElementById('auth-modal-error').classList.remove('show');
    const pw = document.querySelector('#auth-modal-form input[name="password"]');
    if (pw) pw.autocomplete = (mode === 'register') ? 'new-password' : 'current-password';
}
function bindAuthForm() {
    const form = document.getElementById('auth-modal-form');
    if (!form) return;
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const errBox = document.getElementById('auth-modal-error');
        errBox.classList.remove('show');
        const fd = new FormData(form);
        const url = _authMode === 'register' ? '/api/auth/register' : '/api/auth/login';
        const submitBtn = document.getElementById('auth-modal-submit');
        const oldText = submitBtn.textContent;
        submitBtn.disabled = true;
        submitBtn.textContent = '处理中…';
        try {
            const data = await api(url, { method: 'POST', body: fd });
            user = data.user;
            closeAuth();
            renderAuthArea();
            await refreshStrategyList();
            showToast(_authMode === 'register' ? '注册成功' : `欢迎回来 ${user.display_name}`, 'success');
            const cb = _authOnSuccess; _authOnSuccess = null;
            if (cb) setTimeout(cb, 200);
        } catch (e2) {
            errBox.textContent = e2.message || '操作失败';
            errBox.classList.add('show');
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = oldText;
        }
    });
}
function renderAuthArea() {
    const area = document.getElementById('auth-area');
    if (!area) return;
    if (user) {
        area.innerHTML = `<div class="topbar-user">
            <span>${escapeHTML(user.display_name)}</span>
            <button class="btn-textlink" onclick="logout()">登出</button>
        </div>`;
    } else {
        area.innerHTML = `<div class="topbar-anon">
            <button class="btn-textlink" onclick="openAuth('login')">登录</button>
            <button class="btn-textlink primary" onclick="openAuth('register')">注册</button>
        </div>`;
    }
}
async function logout() {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
    user = null;
    renderAuthArea();
    await refreshStrategyList();
    showToast('已登出', 'success');
}

// ============================================================
// 启动
// ============================================================
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeAuth(); closeSaveDialog(); }
});

document.addEventListener('DOMContentLoaded', async () => {
    // Loader 启动(主站同款 6s 动画)
    if (window.DMRLoader) DMRLoader.show('欢迎使用 · 数据加载中');

    // 绑定 UI
    bindMarketInputs();
    refreshMarketDisplay();
    bindDarkModeToggle();
    bindIdealModeToggle();
    initTabs();
    initDotNav();
    initScrollHint();
    initLoopScroll();
    bindAuthForm();
    renderLegs();

    // 拉数据
    await Promise.all([loadPresets(), refreshStrategyList()]);

    // 默认空白状态(没有 leg):画一张只有数轴的空图,让用户感受到"画布在等你"
    if (state.legs.length) {
        scheduleCompute();
    } else {
        renderEmptyExpiry();
    }

    // 通知 loader 数据就绪;loader 在 6 秒结束 + dataReady 时才隐藏
    if (window.DMRLoader) DMRLoader.dataReady();
});

// ============================================================
// 注册:随机名字生成器(形容词的伟人格式)
// ============================================================
const NAME_ADJECTIVES = [
    '爱学习的', '好奇的', '勤奋的', '专注的', '谦逊的', '温和的',
    '稳重的', '严谨的', '踏实的', '用心的', '细心的', '安静的',
    '认真的', '刻苦的', '谨慎的', '从容的', '平和的',
];
const NAME_GIANTS = [
    // 数学
    '高斯', '欧拉', '黎曼', '希尔伯特', '伯努利', '莱布尼茨',
    '费马', '拉普拉斯', '柯西', '庞加莱', '康托尔',
    // 概率与统计
    '贝叶斯', '马尔可夫', '柯尔莫哥洛夫', '费雪', '内曼',
    // 信息与计算
    '香农', '图灵', '冯诺依曼', '维纳',
    // 金融与经济
    '布莱克', '舒尔斯', '莫顿', '马科维茨', '夏普', '法玛',
    '托宾', '米勒', '芒格', '凯利', '萨缪尔森', '凯恩斯',
];
function rollRandomName() {
    const a = NAME_ADJECTIVES[Math.floor(Math.random() * NAME_ADJECTIVES.length)];
    const g = NAME_GIANTS[Math.floor(Math.random() * NAME_GIANTS.length)];
    const inp = document.querySelector('#auth-modal-form input[name="display_name"]');
    if (inp) {
        inp.value = a + g;
        inp.focus();
    }
}

// 暴露给 inline onclick
Object.assign(window, {
    addLeg, removeLeg, clearLegs, applyPreset, flipLegSide,
    loadStrategy, deleteStrategy,
    openSaveDialog, closeSaveDialog, confirmSaveStrategy,
    openAuth, closeAuth, switchAuthTab, logout,
    toggleSidebar, rollRandomName,
});
