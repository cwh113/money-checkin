/* Pay stub reader for Paylocity "Earnings Statement" and Workday "Payroll Deposit Advice" PDFs.
   Input: pages = [{ items: [{ s, x, y }] }] (text positions from pdf.js). Output: array of stub summaries.
   Runs in the browser; nothing is uploaded anywhere. */
(function (root) {
  'use strict';
  const r2 = x => Math.round(x * 100) / 100;
  function num(s) {
    if (typeof s !== 'string') return NaN;
    const t = s.replace(/[$,\s]/g, '');
    return /^-?\d*\.?\d+$/.test(t) ? parseFloat(t) : NaN;
  }
  const isNum = s => !isNaN(num(s));
  function rowsOf(items) {
    const its = items.filter(i => i.s && i.s.trim()).map(i => ({ s: i.s.trim(), x: i.x, y: i.y }));
    its.sort((a, b) => b.y - a.y || a.x - b.x);
    const rows = [];
    its.forEach(i => {
      let r = rows.find(r => Math.abs(r.y - i.y) < 2.5);
      if (!r) { r = { y: i.y, it: [] }; rows.push(r); }
      r.it.push(i);
    });
    rows.sort((a, b) => b.y - a.y);
    rows.forEach(r => r.it.sort((a, b) => a.x - b.x));
    return rows;
  }
  function valAfter(rows, labels, test) {
    labels = [].concat(labels);
    for (const lab of labels) for (const r of rows) {
      const i = r.it.findIndex(c => c.s === lab);
      if (i >= 0) for (let j = i + 1; j < r.it.length; j++) if (!test || test(r.it[j].s)) return r.it[j].s;
    }
    return null;
  }
  function isoFromAny(s) {
    if (!s) return null;
    let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (m) return m[3] + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0');
    const d = new Date(s + ' 12:00:00');
    if (isNaN(d)) return null;
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function classify(label) {
    const l = label.toLowerCase();
    if (/group term|\bgtl\b|imputed/.test(l)) return 'imputed';
    if (/roth/.test(l) && /401|403/.test(l)) return 'roth401k';
    if (/\bhsa\b|health sav/.test(l)) return 'hsa';
    if (/dental|vision|medical|health|insur|\bins\b|\bfsa\b|\blife\b|disab|\bltd\b|\bstd\b|premium/.test(l)) return 'pretaxOther';
    return 'other';
  }
  const NORMAL_EARN = /^(regular|salary|orientation|education|training|pto|holiday|sick|vacation|vac-pto|paid time off|bereave|jury|floating)/i;

  function finish(st) {
    st.gross = r2(st.gross); st.net = r2(st.net);
    ['roth401k', 'hsa', 'pretaxOther', 'otherPost', 'taxes', 'imputed'].forEach(k => { st[k] = r2(st[k] || 0); });
    return st;
  }

  function parsePaylocity(rows) {
    const esRow = rows.find(r => r.it.some(c => c.s === 'Earnings Statement'));
    if (!esRow) return null;
    const name = esRow.it[0].s;
    const body = rows.filter(r => r.y < esRow.y - 1);
    const hdr = body.find(r => r.it.some(c => c.s === 'Earnings') && r.it.some(c => c.s === 'Deductions'));
    if (!hdr) return null;
    const split = hdr.it.find(c => c.s === 'Deductions').x - 6;
    const st = {
      src: 'Paylocity', name, date: isoFromAny(valAfter(body, 'Check Date')), periodEnd: isoFromAny(valAfter(body, 'Period Ending')),
      net: num(valAfter(body, 'Net Pay', isNum)), base: num((valAfter(body, 'Salary') || '').replace('$', '')),
      gross: 0, imputed: 0, taxes: 0, roth401k: 0, hsa: 0, pretaxOther: 0, otherPost: 0, other: [],
      ytd: { gross: 0, roth401k: 0, hsa: 0 }, match: 0, deposits: []
    };
    let section = 'earn', rmode = 'ded';
    body.filter(r => r.y < hdr.y - 1).forEach(r => {
      const left = r.it.filter(c => c.x < split), right = r.it.filter(c => c.x >= split);
      // ---- left block: earnings, then taxes
      if (left.length) {
        const label = left[0].s, nums = left.slice(1).filter(c => isNum(c.s)).map(c => num(c.s));
        if (label === 'Gross Earnings' && nums.length) { st.gross = nums.length >= 3 ? nums[1] : nums[0]; st.ytd.gross = nums[nums.length - 1]; section = 'tax'; }
        else if (section === 'earn' && /^group te|^gtl/i.test(label) && nums.length >= 3) st.imputed += nums[1];
        else if (section === 'tax' && label === 'Taxes' && nums.length) { st.taxes = nums[0]; }
      }
      // ---- right block: deductions, deposits, benefits
      if (right.length) {
        const label = right[0].s, nums = right.slice(1).filter(c => isNum(c.s)).map(c => num(c.s));
        if (label === 'Deductions' && nums.length) { rmode = 'after'; return; }
        if (label === 'Direct Deposits') { rmode = 'dd'; return; }
        if (label === 'Benefits') { rmode = 'ben'; return; }
        if (label === 'Time Off') { rmode = 'to'; return; }
        if (rmode === 'ded' && nums.length >= 1) {
          const kind = classify(label), cur = nums[0], ytd = nums.length > 1 ? nums[1] : 0;
          if (kind === 'roth401k') { st.roth401k += cur; st.ytd.roth401k = ytd; }
          else if (kind === 'hsa') { st.hsa += cur; st.ytd.hsa = ytd; }
          else if (kind === 'imputed') { /* taxable-only line, no cash leaves */ }
          else if (kind === 'pretaxOther') st.pretaxOther += cur;
          else { st.otherPost += cur; st.other.push({ label, amt: r2(cur) }); }
        } else if (rmode === 'dd') {
          const acct = right.find(c => /^\*+\d{3,4}$/.test(c.s));
          const amt = right.slice().reverse().find(c => isNum(c.s));
          if (acct && amt) st.deposits.push({ last4: acct.s.replace(/\D/g, '').slice(-4), amt: num(amt.s) });
        } else if (rmode === 'ben' && /401k? match|401\(k\) match|er match/i.test(label) && nums.length) st.match = nums[0];
      }
    });
    st.typical = Math.abs(st.gross - st.imputed - st.base) <= 1.01;
    return finish(st);
  }

  function parseWorkday(rows) {
    const hdrRow = rows.find(r => r.it.some(c => c.s === 'HOURS/UNIT AND EARNINGS'));
    if (!hdrRow) return null;
    const descHdr = rows.find(r => r.y < hdrRow.y && r.it.filter(c => c.s === 'Description').length && r.it.some(c => c.s === 'Current'));
    const split = descHdr ? descHdr.it.find(c => c.s === 'Description').x - 6 : 410;
    const leaveRow = rows.find(r => r.it.some(c => c.s === 'LEAVE BALANCE' || c.s === 'EMPLOYER PAID BENEFITS & TAXES'));
    const leaveY = leaveRow ? leaveRow.y : -1e9;
    const dateTest = s => /^\d{2}\/\d{2}\/\d{4}$/.test(s);
    const st = {
      src: 'Workday', name: valAfter(rows, 'Name:'),
      date: isoFromAny(valAfter(rows, ['Check Date:', 'Date:'], dateTest)), periodEnd: isoFromAny(valAfter(rows, 'Pay End Date:', dateTest)),
      net: 0, base: 0, gross: 0, imputed: 0, taxes: 0, roth401k: 0, hsa: 0, pretaxOther: 0, otherPost: 0, other: [],
      ytd: { gross: 0, roth401k: 0, hsa: 0 }, match: 0, deposits: []
    };
    // direct deposits near the top
    rows.forEach(r => {
      if (r.y < hdrRow.y) return;
      const acct = r.it.find(c => /\*{3,}\d{3,4}$/.test(c.s));
      if (acct) { const amt = r.it.slice().reverse().find(c => isNum(c.s) && c !== acct); if (amt) st.deposits.push({ last4: acct.s.replace(/\D/g, '').slice(-4), amt: num(amt.s) }); }
    });
    const colHdr = rows.find(r => r.y < hdrRow.y && r.it.some(c => c.s === 'Position'));
    let otherEarn = 0, normalEarn = 0, mode = null;
    rows.filter(r => colHdr && r.y <= colHdr.y + 1 && r.y > -1e9).forEach(r => {
      const inEarn = r.y > leaveY;
      const left = r.it.filter(c => c.x < split), right = r.it.filter(c => c.x >= split);
      if (inEarn && left.length) {
        const lab = left.find(c => !isNum(c.s) && !/\d\/\d/.test(c.s) && c.s !== 'Position');
        const hasDate = left.some(c => /^\d{2}\/\d{2}\/\d{4}$/.test(c.s));
        const nums = left.filter(c => isNum(c.s)).map(c => num(c.s));
        if (lab && hasDate && nums.length >= 3 && lab.s !== 'Description') {
          const cur = nums[2];
          if (NORMAL_EARN.test(lab.s) && !/payout|bonus|stipend/i.test(lab.s)) normalEarn += cur; else otherEarn += cur;
        }
      }
      if (!right.length) return;
      const label = right[0].s, nums = right.slice(1).filter(c => isNum(c.s));
      if (!inEarn && label !== 'Description') {
        // totals block below the leave balance row
        const n = nums.map(c => num(c.s));
        if (label === 'Total Gross Wages' && n.length) { st.gross = n[0]; st.ytd.gross = n[1] || 0; }
        else if (label === 'Total Taxes' && n.length) st.taxes = n[0];
        else if (label === 'Net Pay' && n.length) st.net = n[0];
        return;
      }
      if (label === 'TAXES') { mode = 'tax'; return; }
      if (label === 'BEFORE-TAX DEDUCTIONS') { mode = 'pre'; return; }
      if (label === 'AFTER-TAX DEDUCTION') { mode = 'post'; return; }
      if (label === 'Description' || !nums.length || !mode || mode === 'tax') return;
      const cur = nums.length >= 2 ? num(nums[0].s) : (nums[0].x > 550 ? 0 : num(nums[0].s));
      const ytd = nums.length >= 2 ? num(nums[1].s) : (nums[0].x > 550 ? num(nums[0].s) : 0);
      const kind = classify(label);
      if (kind === 'roth401k') { st.roth401k += cur; st.ytd.roth401k = ytd; }
      else if (kind === 'hsa') { st.hsa += cur; st.ytd.hsa = ytd; }
      else if (kind === 'imputed') { /* ignore */ }
      else if (mode === 'pre' && kind === 'pretaxOther') st.pretaxOther += cur;
      else if (cur) { st.otherPost += cur; st.other.push({ label, amt: r2(cur) }); }
    });
    // employer 401(k) match (lower left block)
    rows.forEach(r => {
      if (r.y > leaveY) return;
      const m = r.it.find(c => /^401k? er match|^401\(k\) er match|^401 er match/i.test(c.s));
      if (m) { const n = r.it.filter(c => c.x > m.x && c.x < split && isNum(c.s)).map(c => num(c.s)); if (n.length) st.match = n[0]; }
    });
    st.base = r2(normalEarn);
    st.typical = otherEarn === 0 && Math.abs(st.gross - normalEarn) <= 1.01;
    return finish(st);
  }

  function parsePages(pages) {
    const out = [];
    pages.forEach(p => {
      const rows = rowsOf(p.items || []);
      const text = rows.map(r => r.it.map(c => c.s).join(' ')).join('\n');
      let st = null;
      try {
        if (/Earnings Statement/.test(text) && /Direct Deposits|Net Pay/.test(text)) st = parsePaylocity(rows);
        else if (/HOURS\/UNIT AND EARNINGS/.test(text)) st = parseWorkday(rows);
      } catch (e) { st = null; }
      if (st && st.date && st.net) out.push(st);
    });
    // de-duplicate (same person, date, net)
    const seen = {};
    return out.filter(s => { const k = [s.name, s.date, s.net, s.gross].join('|'); if (seen[k]) return false; seen[k] = 1; return true; })
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  /* Turn a person's stubs into per-paycheck settings for the app. */
  function summarize(stubs, depositMap) {
    if (!stubs.length) return null;
    const latest = stubs[stubs.length - 1];
    const typicals = stubs.filter(s => s.typical);
    const T = typicals.length ? typicals[typicals.length - 1] : null;
    const notes = [];
    let src = latest, scale = 1;
    if (!latest.typical) {
      if (T) { src = T; scale = latest.base / T.base; notes.push('The latest check (' + latest.date + ') has one-time pay in it, so the numbers are scaled from the ' + T.date + ' check.'); }
      else { notes.push('The latest check has one-time pay in it and no normal check was uploaded, so tax and take-home figures are estimates.'); scale = latest.base / (latest.gross - latest.imputed || 1); }
    }
    const f = v => r2(v * scale);
    const o = {
      date: latest.date, base: latest.base, gross: r2(latest.base), taxes: f(src.taxes), roth401k: f(src.roth401k),
      hsa: r2(src.hsa), pretaxOther: r2(src.pretaxOther), otherPost: r2(src.otherPost), other: src.other, net: src.net, srcDate: src.date,
      ytd: latest.ytd, match: latest.match, notes, deposits: latest.deposits, estimated: !latest.typical
    };
    if (src.typical) {
      const recent = typicals.slice(-6); // irregular lines (parking, one-off premiums) are smoothed
      o.otherPost = r2(recent.reduce((s, x) => s + x.otherPost, 0) / recent.length);
      if (recent.length > 1 && o.otherPost !== r2(src.otherPost)) notes.push('Other deductions are averaged over your last ' + recent.length + ' normal checks.');
    }
    if (!latest.typical && T && src === T) {
      // keep fixed-dollar items fixed; percent-based items scale
      o.hsa = r2(src.hsa); o.pretaxOther = r2(src.pretaxOther); o.otherPost = r2(src.otherPost);
    }
    // direct deposit split
    const dm = depositMap || {};
    const sums = { brokerage: 0, rothIra: 0, other: 0, mapped: false };
    latest.deposits.forEach(d => { const k = dm[d.last4] || 'checking'; if (k === 'brokerage') { sums.brokerage += d.amt; sums.mapped = true; } else if (k === 'rothIra') { sums.rothIra += d.amt; sums.mapped = true; } });
    if (sums.mapped) {
      o.rothIra = r2(sums.rothIra);
      if (latest.typical) o.brokerage = r2(sums.brokerage);
      else {
        // brokerage takes what's left over, so re-derive it for a normal check
        const fixedOther = latest.deposits.reduce((s, d) => { const k = dm[d.last4] || 'checking'; return s + (k === 'checking' ? d.amt : 0); }, 0);
        const netNormal = o.gross - o.taxes - o.roth401k - o.hsa - o.pretaxOther - o.otherPost;
        o.brokerage = r2(Math.max(0, netNormal - fixedOther - o.rothIra));
        notes.push('Brokerage per check is estimated, because the brokerage deposit takes whatever is left after the fixed deposits.');
      }
    }
    return o;
  }

  /* Compact history record for one check. d date, g gross, n take-home, b regular base pay, i imputed income,
     t taxes, r Roth 401(k), h HSA, o other deductions. Records from older systems may carry only d, g, n, b. */
  function toRecord(s) {
    const o = { d: s.date, g: r2(s.gross), n: r2(s.net) };
    if (s.base !== undefined) o.b = r2(s.base);
    if (s.imputed) o.i = r2(s.imputed);
    if (s.taxes !== undefined && s.src) { o.t = r2(s.taxes); o.r = r2(s.roth401k || 0); o.h = r2(s.hsa || 0); o.o = r2((s.pretaxOther || 0) + (s.otherPost || 0)); }
    if (s.match) o.m = r2(s.match);
    if (s.src) o.k = s.src;
    return o;
  }
  /* Merge records into a list: de-dupe on date+net, then fold checks issued the same day (split pay periods). */
  function mergeHistory(list, recs) {
    const out = (list || []).slice(), seen = {};
    out.forEach(x => { seen[x.d + '|' + x.n] = 1; });
    (recs || []).forEach(x => { const k = x.d + '|' + x.n; if (!seen[k] && x.g > 0) { seen[k] = 1; out.push(x); } });
    out.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
    return out;
  }
  /* Parse pasted lines such as "Sep 24, 2026  Gross $4,615.38  Take Home $2,988.08". */
  function parseHistoryText(text) {
    const re = /(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4}|[A-Z][a-z]{2,8}\.? \d{1,2}, \d{4})[^\d$]*\$?\s*([\d,]+\.\d{2})[^\d$]*\$?\s*([\d,]+\.\d{2})/g;
    const out = []; let m;
    while ((m = re.exec(text))) {
      const d = isoFromAny(m[1].replace('.', '')), g = num(m[2]), n = num(m[3]);
      if (d && g > 0 && n > 0) out.push({ d, g: r2(g), n: r2(n) });
    }
    return out;
  }

  const api = { parsePages, summarize, rowsOf, num, toRecord, mergeHistory, parseHistoryText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PayStubs = api;
})(typeof window !== 'undefined' ? window : this);
