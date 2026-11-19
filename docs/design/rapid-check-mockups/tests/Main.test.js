class DCLogic { constructor(props){ this.props=props; this.state={}; } setState(p){ this.state=Object.assign({}, this.state, p); } }
global.setTimeout = (fn)=>0;
const VERSE = {
  ar: 'تكبر قلبك قد خدعك أيها الساكن في محاجئ الصخر، رفعة مقعده، القائل في قلبه: من يحدرني إلى الأرض؟',
  ult: 'The pride of your heart has deceived you: he who dwells in the clefts of the rock, lofty in his dwelling; he who says in his heart, “Who will bring me down to earth?”',
  he: 'זְד֤וֹן לִבְּ⁠ךָ֙ הִשִּׁיאֶ֔⁠ךָ שֹׁכְנִ֥י בְ⁠חַגְוֵי־סֶּ֖לַע מְר֣וֹם שִׁבְתּ֑⁠וֹ אֹמֵ֣ר בְּ⁠לִבּ֔⁠וֹ מִ֥י יוֹרִדֵ֖⁠נִי אָֽרֶץ׃'
};

const ROWS = [
  { id: 'kjbt', typeLabel: 'Personification', status: 'approved',
    he: 'זְד֤וֹן לִבְּ⁠ךָ֙ הִשִּׁיאֶ֔⁠ךָ', arq: 'تكبر قلبك قد خدعك', ulq: 'The pride of your heart has deceived you',
    en: 'Here, **pride** is spoken of as though it were a person who could deceive someone. If this is not clear, you could say this with plain language. Alternate translation: [Because you are so proud, you have deceived yourselves]',
    ar: `يتحدث الكاتب عن **الكبرياء** كما لو كان شخصًا يستطيع أن يخدع أحدًا. إذا لم يكن ذلك واضحًا، يمكنك التعبير عن المعنى بلغة مباشرة. ترجمة بديلة: [لأنك متكبر جدًا، فقد خدعت نفسك]` },
  { id: 'hzdk', typeLabel: 'You (singular group)', status: 'approved',
    he: 'זְד֤וֹן לִבְּ⁠ךָ֙ הִשִּׁיאֶ֔⁠ךָ', arq: 'تكبر قلبك قد خدعك', ulq: 'The pride of your heart has deceived you',
    en: 'Here, **you** is singular, since it refers to the people of Edom as a single nation, but if this is confusing in your language, you can use a plural form of “you” here and throughout this book.',
    ar: `هنا، **أنت** ضمير مفرد، لأنه يشير إلى شعب أدوم كأمة واحدة، لكن إذا كان هذا مربكًا في لغتك، يمكنك استخدام صيغة الجمع لـ"أنتم" هنا وفي بقية هذا السفر.` },
  { id: 'kcc3', typeLabel: 'Abstract nouns', status: 'edited',
    he: 'זְד֤וֹן לִבְּ⁠ךָ֙', arq: 'تكبر قلبك', ulq: 'The pride of your heart',
    en: 'If your language does not use an abstract noun for the idea behind the word **pride**, you can express the same idea with an adjective such as “proud.” Alternate translation: [Your proud attitude]',
    ar: `إذا كانت لغتك لا تستخدم اسمًا مجرّدًا للتعبير عن فكرة **الكبرياء**، يمكنك التعبير عن الفكرة نفسها بصفة مثل "متكبر." ترجمة بديلة: [موقفك المتكبر]` },
  { id: 'qpw7', typeLabel: 'Metaphor', status: 'draft',
    he: 'זְד֤וֹן לִבְּ⁠ךָ֙', arq: 'تكبر قلبك', ulq: 'The pride of your heart',
    en: 'Here, **heart** is used to refer to a person’s thoughts and feelings. Alternate translation: [Your proud attitude]',
    ar: `هنا، تُستخدم **القلب** للإشارة إلى أفكار الشخص ومشاعره. ترجمة بديلة: [موقفك المتكبر]` },
  { id: 'k9sw', typeLabel: '1st / 2nd / 3rd person', status: 'draft',
    he: 'שֹׁכְנִ֥י בְ⁠חַגְוֵי־סֶּ֖לַע', arq: 'الساكن في محاجئ الصخر', ulq: 'he who dwells in the clefts of the rock',
    en: 'Here, the pronoun switches from **you** to **he** even though Yahweh is still talking to the people of Edom. If this is confusing in your language, you can continue to use **you**, since this is part of Yahweh’s continuing message to the people of Edom. Alternate translation: [you who live in the clefts of the rock]',
    ar: `هنا، يتحول الضمير من **أنت** إلى **هو** مع أن يهوه ما زال يتحدث إلى شعب أدوم. إذا كان هذا مربكًا في لغتك، يمكنك الاستمرار في استخدام **أنت**، لأن هذا جزء من كلام يهوه المستمر لشعب أدوم. ترجمة بديلة: [أنت الذي تسكن في شقوق الصخر]` },
  { id: 'q6sz', typeLabel: 'No type', status: 'draft',
    he: 'בְ⁠חַגְוֵי־סֶּ֖לַע', arq: 'في محاجئ الصخر', ulq: 'in the clefts of the rock',
    en: 'This means a place that is protected because it is surrounded by rocks.',
    ar: `هذا يعني مكانًا محميًا لأنه محاط بالصخور.` },
  { id: 'r5zj', typeLabel: '1st / 2nd / 3rd person', status: 'draft',
    he: 'אֹמֵ֣ר בְּ⁠לִבּ֔⁠וֹ', arq: 'القائل في قلبه', ulq: 'he who says in his heart',
    en: 'This says **he** and **his**, as if Yahweh were talking aloud about Edom rather than to Edom, but it can be translated with **you** as part of Yahweh’s continuing words to the people. Alternate translation: [you who say in your heart] or [you who say to yourselves]',
    ar: `هذا يقول **هو** و**له**، كما لو كان يهوه يتحدث بصوت عالٍ عن أدوم بدلًا من التحدث إليه، لكن يمكن ترجمته بـ**أنت** كجزء من كلام يهوه المستمر لشعبه. ترجمة بديلة: [أنت الذي تقول في قلبك] أو [أنت الذي تقول لنفسك]` },
  { id: 'jd3r', typeLabel: 'Metaphor', status: 'draft',
    he: 'אֹמֵ֣ר בְּ⁠לִבּ֔⁠וֹ', arq: 'القائل في قلبه', ulq: 'he who says in his heart',
    en: 'Here, the heart is used to refer to a person’s thoughts and feelings. Alternate translation: [he who says to himself] or [you who think]',
    ar: `هنا، يُستخدم القلب للإشارة إلى أفكار الشخص ومشاعره. ترجمة بديلة: [الذي يقول لنفسه] أو [أنت الذي تفكر]` },
  { id: 'i2hx', typeLabel: 'Rhetorical question', status: 'draft',
    he: 'מִ֥י יוֹרִדֵ֖⁠נִי אָֽרֶץ', arq: 'من يحدرني إلى الأرض', ulq: 'Who will bring me down to earth?',
    en: 'This rhetorical question expresses how proud the Edomites were and how safe they felt. Alternate translation: [no one can bring me down to the ground] or [I am safe from all attackers]',
    ar: `لا يطلب الكاتب معلومات هنا، بل يستخدم صيغة السؤال للتعبير عن مدى كبرياء الأدوميين وشعورهم بالأمان. إذا كانت لغتك لا تستخدم السؤال البلاغي بهذه الطريقة، يمكنك ترجمة كلماته كعبارة تقريرية أو تعجبية. ترجمة بديلة: [لا أحد يستطيع أن ينزلني إلى الأرض] أو [أنا آمن من كل المهاجمين]` }
];

const VERSE_COUNTS = [14, 5, 9, 6, 5, 5, 8, 8, 9, 7, 7, 7, 5, 3, 7, 7, 5, 9, 11, 10, 5];

const CHIPS = {
  approved: { label: 'Approved', bg: '#E2F2EA', fg: '#0E5B3E', dot: '#1E8A5F' },
  edited: { label: 'Edited', bg: '#FFF0D9', fg: '#8A4600', dot: '#D07A00' },
  draft: { label: 'Draft · AI', bg: '#ECEFF3', fg: '#3A4450', dot: '#8A94A0' },
  pending: { label: 'Pending · AI', bg: '#E8EEFB', fg: '#1F4FA0', dot: '#1F5FBF' },
  notneeded: { label: 'Not needed', bg: '#F1F1F1', fg: '#5E6670', dot: '#A0A7AF' },
  unsaved: { label: 'Unsaved', bg: '#FFF3CC', fg: '#7A5200', dot: '#D08A00' }
};


const STAT = {
  draft: { label: 'Draft · AI', fg: '#B34700', ring: '#D55E00', style: 'solid', fill: '#FFFFFF', mark: '' },
  pending: { label: 'Pending · AI', fg: '#0B5A8F', ring: '#0072B2', style: 'dashed', fill: '#FFFFFF', mark: '' },
  edited: { label: 'Edited', fg: '#8A5A00', ring: '#E69F00', style: 'solid', fill: 'linear-gradient(90deg, #E69F00 50%, #FFFFFF 50%)', mark: '' },
  unsaved: { label: 'Unsaved edit', fg: '#8A5A00', ring: '#E69F00', style: 'dashed', fill: '#FFFFFF', mark: 'dot' },
  approved: { label: 'Approved', fg: '#00704F', ring: '#009E73', style: 'solid', fill: '#009E73', mark: 'check' },
  notneeded: { label: 'Not needed', fg: '#5E6670', ring: '#8A94A0', style: 'solid', fill: '#E3E7EC', mark: 'dash' }
};

function statVals(key, id) {
  const v = STAT[key];
  return {
    stLabel: v.label, stFg: v.fg, ring: v.ring, ringStyle: v.style, fill: v.fill,
    markCheck: v.mark === 'check', markDash: v.mark === 'dash', markDot: v.mark === 'dot',
    approvedAria: key === 'approved' ? 'true' : 'false',
    circleAria: key === 'approved' ? 'Approved. Click to take approval off ' + id : 'Approve ' + id + ' (A)'
  };
}

const LIST = ROWS;
const ORDER = ROWS.map((r) => r.id);

function strip(s) { return s.replace(/⁠/g, ''); }

function marks(text, quote, color) {
  const t = strip(text);
  const q = quote ? strip(quote) : '';
  const i = q ? t.indexOf(q) : -1;
  if (i < 0) return [{ t: t, bg: 'transparent' }];
  return [
    { t: t.slice(0, i), bg: 'transparent' },
    { t: q, bg: color },
    { t: t.slice(i + q.length), bg: 'transparent' }
  ];
}

function md(text) {
  return text.split('**').map((t, i) => ({ t: t, w: i % 2 ? 700 : 400 }));
}

class Component extends DCLogic {
  defaults() {
    const base = { sel: {}, anchor: null, editing: null, drafts: {}, statusOv: {}, arOv: {}, showEn: true, showUlt: true, showHe: false, showKeys: false, focus: 'qpw7', msg: null, undoSnap: null };
    if ((this.props.scenario ?? 'default') === 'action') {
      base.sel = { kcc3: true, qpw7: true, k9sw: true, q6sz: true };
      base.anchor = 'kcc3';
      base.editing = 'qpw7';
      base.focus = 'qpw7';
      base.drafts = { qpw7: 'هنا، يُستخدم **القلب** للإشارة إلى أفكار الإنسان ومشاعره. ترجمة بديلة: [موقفك المتكبر] أو [كبرياؤك]' };
    }
    return base;
  }

  s() { return Object.assign({}, this.defaults(), this.state || {}); }

  snap(s) { return { statusOv: s.statusOv, arOv: s.arOv, drafts: s.drafts }; }

  statusOf(s, r) { return s.statusOv[r.id] ?? r.status; }
  arOf(s, r) { return s.arOv[r.id] ?? r.ar; }

  toggle(id, e) {
    const s = this.s();
    const ids = ROWS.map((r) => r.id);
    const sel = Object.assign({}, s.sel);
    const val = !sel[id];
    if (e && e.shiftKey && s.anchor && s.anchor !== id) {
      const a = ids.indexOf(s.anchor), b = ids.indexOf(id);
      const lo = Math.min(a, b), hi = Math.max(a, b);
      for (let k = lo; k <= hi; k++) { if (val) sel[ids[k]] = true; else delete sel[ids[k]]; }
    } else {
      if (val) sel[id] = true; else delete sel[id];
    }
    this.setState({ sel: sel, anchor: id, focus: id, msg: null });
  }

  toggleAll() {
    const s = this.s();
    const n = Object.keys(s.sel).length;
    if (n === ROWS.length) this.setState({ sel: {}, anchor: null, msg: null });
    else {
      const sel = {};
      ROWS.forEach((r) => { sel[r.id] = true; });
      this.setState({ sel: sel, msg: null });
    }
  }

  bulk(kind) {
    const s = this.s();
    const ids = Object.keys(s.sel);
    if (!ids.length) return;
    const statusOv = Object.assign({}, s.statusOv);
    const arOv = Object.assign({}, s.arOv);
    const drafts = Object.assign({}, s.drafts);
    let savedFirst = 0;
    ids.forEach((id) => {
      if (kind === 'approve') {
        if (drafts[id] !== undefined) { arOv[id] = drafts[id]; delete drafts[id]; savedFirst++; }
        statusOv[id] = 'approved';
      } else if (kind === 'redo') {
        statusOv[id] = 'pending';
      } else if (kind === 'notneeded') {
        statusOv[id] = 'notneeded';
      }
    });
    const n = ids.length;
    const msg = kind === 'approve'
      ? 'Approved ' + n + ' note' + (n === 1 ? '' : 's') + (savedFirst ? ' (saved ' + savedFirst + ' unsaved edit first)' : '') + '.'
      : kind === 'redo'
        ? 'Asked the AI to redo ' + n + ' note' + (n === 1 ? '' : 's') + '. New drafts appear when ready.'
        : 'Set aside ' + n + ' note' + (n === 1 ? '' : 's') + ' as not needed.';
    const editing = ids.indexOf(s.editing) >= 0 ? null : s.editing;
    this.setState({ statusOv: statusOv, arOv: arOv, drafts: drafts, sel: {}, anchor: null, editing: editing, msg: msg, undoSnap: this.snap(s) });
  }

  undo() {
    const s = this.s();
    if (!s.undoSnap) return;
    this.setState(Object.assign({}, s.undoSnap, { msg: null, undoSnap: null }));
  }

  one(id, kind) {
    const s = this.s();
    const statusOv = Object.assign({}, s.statusOv);
    const arOv = Object.assign({}, s.arOv);
    const drafts = Object.assign({}, s.drafts);
    if (kind === 'cancel') { delete drafts[id]; this.setState({ drafts: drafts, editing: null }); return; }
    if (drafts[id] !== undefined) { arOv[id] = drafts[id]; delete drafts[id]; }
    statusOv[id] = kind === 'save' ? 'edited' : 'approved';
    const sel = Object.assign({}, s.sel);
    if (kind !== 'save') delete sel[id];
    this.setState({ statusOv: statusOv, arOv: arOv, drafts: drafts, editing: null, sel: sel, msg: kind === 'save' ? 'Saved ' + id + '.' : 'Approved ' + id + '.', undoSnap: this.snap(s) });
  }

  edit(id) {
    const s = this.s();
    const r = ROWS.find((x) => x.id === id);
    const drafts = Object.assign({}, s.drafts);
    if (drafts[id] === undefined) drafts[id] = this.arOf(s, r);
    this.setState({ editing: id, focus: id, drafts: drafts });
  }


  flipApprove(id) {
    const s = this.s();
    const n = LIST.find((x) => x.id === id);
    if (this.statusOf(s, n) === 'approved') {
      const statusOv = Object.assign({}, s.statusOv);
      statusOv[id] = n.status === 'approved' || s.arOv[id] !== undefined ? 'edited' : n.status;
      this.setState({ statusOv: statusOv, focus: id, msg: 'Took approval off ' + id + '.', undoSnap: this.snap(s) });
    } else {
      this.one(id, 'approve');
      this.setState({ focus: id });
    }
  }

  focusRow(root, id) {
    setTimeout(() => {
      if (!root || !root.querySelector) return;
      const cb = root.querySelector('[data-cb="' + id + '"]');
      if (!cb) return;
      const scrolls = root.scrollHeight > root.clientHeight + 2;
      if (!scrolls) { cb.focus(); return; }
      cb.focus({ preventScroll: true });
      const row = cb.closest('[data-row]') || cb;
      const sticky = root.querySelector('[data-sticky]');
      const rr = row.getBoundingClientRect();
      const cr = root.getBoundingClientRect();
      const top = (sticky ? sticky.getBoundingClientRect().bottom : cr.top) + 4;
      if (rr.top < top) root.scrollTop -= (top - rr.top);
      else if (rr.bottom > cr.bottom - 8) root.scrollTop += Math.min(rr.bottom - cr.bottom + 8, rr.top - top);
    }, 0);
  }

  onKey(e) {
    const root = e.currentTarget;
    const t = e.target || {};
    const tag = (t.tagName || '').toLowerCase();
    const s = this.s();
    const ids = ORDER;
    if (tag === 'textarea' || tag === 'input') {
      if (!s.editing) return;
      if (e.key === 'Escape') { e.preventDefault(); const id = s.editing; this.one(id, 'cancel'); this.focusRow(root, id); }
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        const id = s.editing;
        const next = ids[Math.min(ids.length - 1, ids.indexOf(id) + 1)];
        this.one(id, 'approve');
        this.setState({ focus: next });
        this.focusRow(root, next);
      }
      return;
    }
    if (e.altKey) return;
    const k = e.key;
    const cur = ids.indexOf(s.focus) >= 0 ? s.focus : ids[0];
    const down = k === 'j' || k === 'J' || k === 'ArrowDown';
    const up = k === 'k' || k === 'K' || k === 'ArrowUp';
    if ((down || up) && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      const i = ids.indexOf(cur);
      const nid = ids[Math.max(0, Math.min(ids.length - 1, i + (down ? 1 : -1)))];
      const patch = { focus: nid, msg: null };
      if (e.shiftKey) {
        const sel = Object.assign({}, s.sel);
        sel[cur] = true; sel[nid] = true;
        patch.sel = sel;
        patch.anchor = s.anchor || cur;
      }
      this.setState(patch);
      this.focusRow(root, nid);
    } else if (k === ' ' && tag !== 'button') {
      e.preventDefault();
      this.toggle(cur, { shiftKey: e.shiftKey });
      this.focusRow(root, cur);
    } else if (k === 'Enter' && !e.ctrlKey && !e.metaKey && (tag !== 'button' || (t.getAttribute && t.getAttribute('data-cb')))) {
      e.preventDefault();
      this.edit(cur);
      setTimeout(() => { const ta = root.querySelector('textarea'); if (ta) { ta.focus({ preventScroll: true }); ta.setSelectionRange(ta.value.length, ta.value.length); } }, 30);
    } else if ((k === 'a' || k === 'A') && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      this.toggleAll();
    } else if ((k === 'a' || k === 'A') && !e.shiftKey) {
      e.preventDefault();
      if (Object.keys(s.sel).length) { this.bulk('approve'); return; }
      const next = ids[Math.min(ids.length - 1, ids.indexOf(cur) + 1)];
      this.one(cur, 'approve');
      this.setState({ focus: next });
      this.focusRow(root, next);
    }
  }

  renderVals() {
    const s = this.s();
    const focusRow = ROWS.find((r) => r.id === s.focus) || ROWS[3];
    const selIds = Object.keys(s.sel);
    const selCount = selIds.length;
    const dirtySel = selIds.filter((id) => s.drafts[id] !== undefined).length;
    const cols = s.showEn
      ? '32px 112px 170px minmax(0, 1fr) minmax(0, 1.2fr)'
      : '32px 112px 170px minmax(0, 1.8fr)';

    const rows = ROWS.map((r) => {
      const st = this.statusOf(s, r);
      const sel = !!s.sel[r.id];
      const draft = s.drafts[r.id];
      const dirty = draft !== undefined && draft !== this.arOf(s, r);
      const chip = dirty ? CHIPS.unsaved : CHIPS[st];
      const isEditing = s.editing === r.id;
      return {
        id: r.id,
        typeLabel: r.typeLabel,
        he: strip(r.he),
        arq: r.arq,
        enSeg: md(r.en),
        arSeg: md(dirty ? draft : this.arOf(s, r)),
        draft: draft ?? this.arOf(s, r),
        sel: sel,
        aria: sel ? 'true' : 'false',
        cbBorder: sel ? '#1F5FBF' : '#6B7480',
        cbBg: sel ? '#1F5FBF' : '#FFFFFF',
        isAnchor: s.anchor === r.id && selCount > 0,
        bg: sel ? '#EAF1FC' : (s.focus === r.id ? '#F5F8FE' : '#FFFFFF'),
        curBar: s.focus === r.id ? 'inset 4px 0 0 #1F5FBF' : 'none',
        opacity: st === 'notneeded' ? 0.55 : 1,
        cellBorder: dirty ? '#E3B341' : (s.focus === r.id ? '#C9D0D8' : 'transparent'),
        cellBg: dirty ? '#FFFBEA' : 'transparent',
        ...statVals(dirty ? 'unsaved' : st, r.id),
        flip: (e) => { if (e && e.stopPropagation) e.stopPropagation(); this.flipApprove(r.id); },
        makeCurrent: () => this.setState({ focus: r.id }),
        canApprove: st !== 'approved' && st !== 'notneeded',
        isEditing: isEditing,
        notEditing: !isEditing,
        toggle: (e) => { if (e && e.stopPropagation) e.stopPropagation(); this.toggle(r.id, e); },
        noTextSelect: (e) => { if (e && e.shiftKey) e.preventDefault(); },
        focus: () => { if (s.focus !== r.id) this.setState({ focus: r.id }); },
        edit: (e) => { if (e && e.stopPropagation) e.stopPropagation(); this.edit(r.id); },
        onEdit: (e) => { const d = Object.assign({}, this.s().drafts); d[r.id] = e.target.value; this.setState({ drafts: d }); },
        cancel: (e) => { if (e && e.stopPropagation) e.stopPropagation(); this.one(r.id, 'cancel'); },
        save: (e) => { if (e && e.stopPropagation) e.stopPropagation(); this.one(r.id, 'save'); },
        saveApprove: (e) => { if (e && e.stopPropagation) e.stopPropagation(); this.one(r.id, 'approve'); },
        approve: (e) => { if (e && e.stopPropagation) e.stopPropagation(); this.one(r.id, 'approve'); }
      };
    });

    const verseApproved = ROWS.filter((r) => this.statusOf(s, r) === 'approved').length;
    const chapterApproved = 19 + verseApproved;

    const allOn = selCount === ROWS.length;
    const mixed = selCount > 0 && !allOn;

    const tog = (label, key) => {
      const on = !!s[key];
      return {
        label: label,
        pressed: on ? 'true' : 'false',
        border: on ? '#1F5FBF' : '#C9D0D8',
        bg: on ? '#E8EEFB' : '#FFFFFF',
        fg: on ? '#1F4FA0' : '#3A4450',
        tickOpacity: on ? 1 : 0,
        flip: () => { const p = {}; p[key] = !on; this.setState(p); }
      };
    };

    const stripItems = VERSE_COUNTS.map((c, i) => {
      const n = i + 1;
      const current = n === 3;
      const done = n < 3;
      return {
        n: n,
        sub: done ? '✓' : String(c),
        aria: 'Verse ' + n + ', ' + c + ' notes' + (done ? ', all approved' : ''),
        current: current ? 'true' : 'false',
        border: current ? '#1F5FBF' : (done ? '#B9DCCB' : '#D5DAE0'),
        bg: current ? '#1F5FBF' : (done ? '#E2F2EA' : '#FFFFFF'),
        fg: current ? '#FFFFFF' : (done ? '#0E5B3E' : '#3A4450')
      };
    });

    return {
      cols: cols,
      rows: rows,
      strip: stripItems,
      showEn: s.showEn,
      enHidden: !s.showEn,
      showUlt: s.showUlt,
      showHe: s.showHe,
      toggles: [tog('ULT', 'showUlt'), tog('Hebrew', 'showHe'), tog('English note', 'showEn')],
      hideEn: () => this.setState({ showEn: false }),
      showEnFn: () => this.setState({ showEn: true }),
      arVerse: marks(VERSE.ar, focusRow.arq, '#FFE08A'),
      ultVerse: marks(VERSE.ult, focusRow.ulq, '#FFE08A'),
      heVerse: marks(VERSE.he, focusRow.he, '#FFE08A'),
      focusId: focusRow.id,
      verseLine: '9 notes, ' + verseApproved + ' approved.',
      onKey: (e) => this.onKey(e),
      showKeys: s.showKeys,
      keysOpen: s.showKeys ? 'true' : 'false',
      flipKeys: () => this.setState({ showKeys: !s.showKeys }),
      verseApproved: verseApproved,
      chapterApproved: chapterApproved,
      chapterPct: Math.round(chapterApproved / 152 * 100) + '%',
      all: {
        aria: allOn ? 'true' : (mixed ? 'mixed' : 'false'),
        on: allOn,
        mixed: mixed,
        border: selCount ? '#1F5FBF' : '#6B7480',
        bg: selCount ? '#1F5FBF' : '#FFFFFF',
        toggle: () => this.toggleAll()
      },
      barBg: selCount ? '#EAF1FC' : '#FFFFFF',
      hasSel: selCount > 0,
      noSel: selCount === 0,
      selCount: selCount,
      hasDirtySel: dirtySel > 0,
      dirtySelText: dirtySel + ' with unsaved edits',
      hasMsg: !!s.msg,
      noMsg: !s.msg,
      msg: s.msg || '',
      undo: () => this.undo(),
      approveSel: () => this.bulk('approve'),
      redoSel: () => this.bulk('redo'),
      notNeededSel: () => this.bulk('notneeded'),
      clearSel: () => this.setState({ sel: {}, anchor: null })
    };
  }
}
const c = new Component({});
const ev = (key, extra={}) => Object.assign({ key, currentTarget: {}, target: { tagName: 'DIV' }, preventDefault(){} , shiftKey:false, ctrlKey:false, metaKey:false, altKey:false }, extra);
const st = () => { const v = c.renderVals(); const rows = v.rows || v.groups.flatMap(g=>g.notes); return rows.map(r => r.id + ':' + r.stLabel + (r.curBar!=='none'?'*':'') + (r.sel?'[x]':'')).join(' '); };
console.log('Main start   ', st());
c.onKey(ev('j')); console.log('j         ', st());
c.onKey(ev('a')); console.log('a         ', st());
c.onKey(ev('J',{shiftKey:true})); console.log('shift J   ', st());
c.onKey(ev('a')); console.log('a (bulk)  ', st(), '|', c.s().msg);
c.onKey(ev('k')); c.onKey(ev(' ')); console.log('k space   ', st());
c.onKey(ev('Enter')); console.log('enter editing=', c.s().editing);
c.onKey(ev('Escape',{target:{tagName:'TEXTAREA'}})); console.log('esc editing=', c.s().editing);
c.onKey(ev('Enter')); c.onKey(ev('Enter',{ctrlKey:true,target:{tagName:'TEXTAREA'}})); console.log('ctrl+enter', st());
const v=c.renderVals(); const r=(v.rows||v.groups.flatMap(g=>g.notes)).find(r=>r.stLabel==='Approved'); r.flip(); console.log('unapprove '+r.id, c.s().statusOv[r.id], c.s().msg);
