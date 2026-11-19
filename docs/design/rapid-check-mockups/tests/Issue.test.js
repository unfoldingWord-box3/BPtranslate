class DCLogic { constructor(props){ this.props=props; this.state={}; } setState(p){ this.state=Object.assign({}, this.state, p); } }
global.setTimeout = (fn)=>0;
const GROUPS = [
  { ref: '1:1',
    ar: 'رؤيا عوبديا: هكذا قال السيد الرب عن أدوم: سمعنا خبرا من قبل الرب وأرسل رسول بين الأمم: قوموا ولنقم عليها للحرب.',
    ult: 'The vision of Obadiah: thus says my Lord Yahweh concerning Edom. We have heard a message from Yahweh, and a messenger has been sent off among the nations: Get up! And let us rise up against her for battle!',
    notes: [
      { id: 'xm1w', status: 'approved', he: 'חֲז֖וֹן עֹֽבַדְיָ֑ה', arq: ['رؤيا عوبديا'], ulq: ['The vision of Obadiah'],
        en: 'This is the title of the book. Here **vision** is used in the general sense of a message from Yahweh, rather than to indicate how Obadiah received that message. **Vision** here is a metaphor for the way that God gives knowledge to people. Alternate translation: [The message that God gave to Obadiah] or [The prophecy of Obadiah]',
        ar: `هذا هو عنوان السفر. هنا تُستخدم كلمة **رؤيا** بالمعنى العام لرسالة من يهوه، لا للإشارة إلى الطريقة التي تلقى بها عوبديا تلك الرسالة. **رؤيا** هنا استعارة عن الطريقة التي يمنح بها الله المعرفة للناس. ترجمة بديلة: [الرسالة التي أعطاها الله لعوبديا] أو [نبوءة عوبديا]` }
    ] },
  { ref: '1:2',
    ar: 'إني قد جعلتك صغيرا بين الشعوب. أنت محتقر جدا.',
    ult: 'Behold, I am making you small among the nations, you are extremely despised.',
    notes: [
      { id: 'ec8m', status: 'approved', he: 'קָטֹ֛ן נְתַתִּ֖י⁠ךָ בַּ⁠גּוֹיִ֑ם', arq: ['قد جعلتك صغيرا بين الشعوب'], ulq: ['I am making you small among the nations'],
        en: 'Something insignificant is spoken of as if it were small in size and could easily be overlooked. Alternate translation: [insignificant among the nations]',
        ar: `هنا، يُتحدث عن الشيء التافه كما لو كان صغير الحجم يمكن تجاهله بسهولة. ترجمة بديلة: [تافهة بين الأمم]` }
    ] },
  { ref: '1:3',
    ar: 'تكبر قلبك قد خدعك أيها الساكن في محاجئ الصخر، رفعة مقعده، القائل في قلبه: من يحدرني إلى الأرض؟',
    ult: 'The pride of your heart has deceived you: he who dwells in the clefts of the rock, lofty in his dwelling; he who says in his heart, “Who will bring me down to earth?”',
    notes: [
      { id: 'qpw7', status: 'draft', he: 'זְד֤וֹן לִבְּ⁠ךָ֙', arq: ['تكبر قلبك'], ulq: ['The pride of your heart'],
        en: 'Here, **heart** is used to refer to a person’s thoughts and feelings. Alternate translation: [Your proud attitude]',
        ar: `هنا، تُستخدم **القلب** للإشارة إلى أفكار الشخص ومشاعره. ترجمة بديلة: [موقفك المتكبر]` },
      { id: 'jd3r', status: 'draft', he: 'אֹמֵ֣ר בְּ⁠לִבּ֔⁠וֹ', arq: ['القائل في قلبه'], ulq: ['he who says in his heart'],
        en: 'Here, the heart is used to refer to a person’s thoughts and feelings. Alternate translation: [he who says to himself] or [you who think]',
        ar: `هنا، يُستخدم القلب للإشارة إلى أفكار الشخص ومشاعره. ترجمة بديلة: [الذي يقول لنفسه] أو [أنت الذي تفكر]` }
    ] },
  { ref: '1:4',
    ar: 'إن كنت ترتفع كالنسر، وإن كان عشك موضوعا بين النجوم، فمن هناك أحدرك، يقول الرب.',
    ult: 'If you make yourself high like the eagle, even if your nest is set between the stars, from there I will bring you down: a declaration of Yahweh.',
    notes: [
      { id: 'bbu3', status: 'edited', he: 'מִ⁠שָּׁ֥ם אוֹרִֽידְ⁠ךָ֖', arq: ['فمن هناك أحدرك'], ulq: ['from there I will bring you down'],
        en: 'Here, **bring you down** means “humble you” or “defeat you.” This is a spatial metaphor. Yahweh’s response to the Edomites is that there is nowhere they would be safe from his judgment and punishment. Alternate translation: [you would still not be safe there from the attackers that I am sending]',
        ar: `هنا، تُستخدم **أُنزلك** استعارة مكانية بمعنى "أُذلّك" أو "أهزمك". رد يهوه على الأدوميين هو أنه لا يوجد مكان يكونون فيه آمنين من دينونته وعقابه. ترجمة بديلة: [فلن تكونوا آمنين هناك من المهاجمين الذين سأرسلهم]` }
    ] },
  { ref: '1:9',
    ar: 'ويرتاع أبطالك يا تيمان، لكي ينقرض كل واحد من جبل عيسو بالقتل.',
    ult: 'And your mighty men will be dismayed, O Teman, so that a man will be cut off from the mountain of Esau by slaughter.',
    notes: [
      { id: 'jd27', status: 'draft', he: 'יִכָּֽרֶת־אִ֛ישׁ', arq: ['ينقرض كل واحد'], ulq: ['a man will be cut off'],
        en: 'Here, **cut off** is a metaphor for being killed. The Edomites are pictured as part of the mountain where they live, and their death as being cut off from the mountain. Alternate translation: [your enemies will destroy all of you]',
        ar: `هنا، **قُطع** استعارة عن القتل. يُصوَّر الأدوميون كجزء من الجبل الذي يعيشون فيه، ويُصوَّر موتهم كأنه قطعٌ من الجبل. ترجمة بديلة: [سيهلككم أعداؤكم جميعًا]` }
    ] },
  { ref: '1:11',
    ar: 'يوم وقفت مقابله، يوم سبت الأعاجم قدرته، ودخلت الغرباء أبوابه، وألقوا قرعة على أورشليم، كنت أنت أيضا كواحد منهم.',
    ult: 'On the day that you stood opposite, on the day that strangers took captive his wealth, and foreigners entered his gates and cast lots for Jerusalem, you also were like one of them.',
    notes: [
      { id: 'w6hj', status: 'draft', he: 'עֲמָֽדְ⁠ךָ֣ מִ⁠נֶּ֔גֶד', arq: ['وقفت مقابله'], ulq: ['you stood opposite'],
        en: 'This is a metaphor that pictures the people of Edom as a person who was just standing around and not helping a relative. Alternate translation: [you did not help him.]',
        ar: `هذه استعارة تصوّر شعب أدوم كشخص وقف مكتوف الأيدي ولم يساعد قريبه. ترجمة بديلة: [لم تساعده.]` },
      { id: 'i8sr', status: 'draft', he: 'וְ⁠עַל־יְרוּשָׁלִַ֨ם֙ יַדּ֣וּ גוֹרָ֔ל', arq: ['وألقوا قرعة على أورشليم'], ulq: ['cast lots for Jerusalem'],
        en: 'There are two possibilities for what this could mean: (1) This is a figurative way of saying that the **foreigners** had complete control of **Jerusalem**, with Jerusalem pictured as something that everybody wants to have, but it cannot be divided, so they cast lots to see who will get it. Alternate translation: [they even plundered Jerusalem] or (2) The name of the city may be standing for the wealth of the city. Alternate translation: [and they divided the wealth of Jerusalem among themselves]',
        ar: `هناك احتمالان لما يمكن أن يعنيه هذا: (1) هذه طريقة مجازية للقول إن **الغرباء** كانت لهم السيطرة الكاملة على **أورشليم**، إذ تُصوَّر أورشليم كشيء يريده الجميع لكن لا يمكن تقسيمه، فألقوا القرعة ليروا من سيحصل عليه. ترجمة بديلة: [حتى إنهم نهبوا أورشليم] أو (2) قد يكون اسم المدينة يشير إلى ثروة المدينة. ترجمة بديلة: [وقسّموا ثروة أورشليم فيما بينهم]` }
    ] },
  { ref: '1:14',
    ar: 'ولا تقف على المفرق لتقطع منفلتيه، ولا تسلم بقاياه في يوم الضيق.',
    ult: 'And you should not have stood at the crossroads to cut down his fugitives. And you should not have delivered up his survivors in a day of distress.',
    notes: [
      { id: 'p7i1', status: 'draft', he: 'לְ⁠הַכְרִ֖ית', arq: ['لتقطع'], ulq: ['to cut down'],
        en: 'Here, **to cut down** is a metaphor that means “to kill.” It is likely a comparison to the way grain is cut down at harvest time. See how you translated this same metaphor in [1:9](../01/09.md).',
        ar: `هنا، **يقطع** استعارة بمعنى «يقتل». ويُرجَّح أنها تشبيه بالطريقة التي يُقطع بها الزرع وقت الحصاد. انظر كيف ترجمت هذه الاستعارة نفسها في [1:9](../01/09.md).` }
    ] },
  { ref: '1:15',
    ar: 'فإنه قريب يوم الرب على كل الأمم. كما فعلت يفعل بك. عملك يرتد على رأسك.',
    ult: 'For the day of Yahweh is near upon all the nations. According to what you have done, it will be done to you; your recompense will return on your own head.',
    notes: [
      { id: 'djk9', status: 'draft', he: 'גְּמֻלְ⁠ךָ֖ יָשׁ֥וּב בְּ⁠רֹאשֶֽׁ⁠ךָ', arq: ['عملك يرتد على رأسك'], ulq: ['your recompense will return on your own head'],
        en: 'This is a metaphor that pictures the Edomites as having sent bad things out to others, and now those things are going to come back and hurt them as they land on their heads. Alternate translation: [those same things will soon happen to you]',
        ar: `هذه استعارة تصوّر الأدوميين وقد أرسلوا أمورًا سيئة إلى آخرين، والآن ستعود تلك الأمور لتؤذيهم إذ تحطّ على رؤوسهم. ترجمة بديلة: [تلك الأمور نفسها ستحدث لكم قريبًا]` }
    ] },
  { ref: '1:16',
    ar: 'لأنه كما شربتم على جبل قدسي يشرب جميع الأمم دائما، يشربون ويجرعون ويكونون كأنهم لم يكونوا.',
    ult: 'For according to how you drank on the mountain of my holiness, all the nations shall drink continually. And they will drink, and they will swallow, and they will become like they never existed.',
    notes: [
      { id: 'cr7s', status: 'draft', he: 'שְׁתִיתֶם֙', arq: ['شربتم'], ulq: ['you drank'],
        en: 'The image of drinking something is often used in the Bible as a metaphor for suffering or for being punished by God. Alternate translation: [you suffered] or [I punished you]',
        ar: `غالبًا ما تُستخدم صورة شرب شيء ما في الكتاب المقدس استعارةً للمعاناة أو للعقاب من الله. ترجمة بديلة: [عانيتم] أو [عاقبتكم]` },
      { id: 'qz7p', status: 'draft', he: 'יִשְׁתּ֥וּ כָֽל־הַ⁠גּוֹיִ֖ם תָּמִ֑יד', arq: ['يشرب جميع الأمم دائما'], ulq: ['all the nations shall drink continually'],
        en: 'Here the metaphor continues, using **drink** to mean “suffer” or “be punished.” Alternate translation: [I will punish all of the nations continually]',
        ar: `يستمر هنا استخدام الاستعارة، إذ تُستخدم كلمة **يشربون** بمعنى «يعانون» أو «يُعاقَبون». ترجمة بديلة: [سأعاقب جميع الأمم باستمرار]` },
      { id: 'vcve', status: 'draft', he: 'וְ⁠שָׁת֣וּ וְ⁠לָע֔וּ', arq: ['يشربون ويجرعون'], ulq: ['they will drink, and they will swallow'],
        en: 'Here the metaphor continues, using **drink** and **swallow** as images for suffering or being punished. Alternate translation: [I will make them suffer a lot]',
        ar: `يستمر هنا استخدام الاستعارة، إذ تُستخدم كلمتا **يشربون** و**يبتلعون** كصورتين للمعاناة أو العقاب. ترجمة بديلة: [سأجعلهم يعانون كثيرًا]` }
    ] },
  { ref: '1:18',
    ar: 'ويكون بيت يعقوب نارا، وبيت يوسف لهيبا، وبيت عيسو قشا، فيشعلونهم ويأكلونهم، ولا يكون باق من بيت عيسو، لأن الرب تكلم.',
    ult: 'And the house of Jacob will become a fire, and the house of Joseph a flame, and the house of Esau as stubble. And they will burn them, and consume them. And there will be no survivor for the house of Esau, for Yahweh has spoken.',
    notes: [
      { id: 'cr19', status: 'draft', he: 'אֵ֜שׁ & לֶהָבָ֗ה & לְ⁠קַ֔שׁ', arq: ['نارا', 'لهيبا', 'قشا'], ulq: ['a fire', 'a flame', 'stubble'],
        en: 'In this metaphor, Yahweh is saying that the Israelites will be like fire and flame, that the people of Edom will be like dry grass, and that the Israelites will do to the people of Edom what fire and flame do to dry grass. In other words, just as fire and flame burn up dry grass until it is all gone, the Israelites who survive will conquer all of Edom. If this metaphor is not clear in your language, you could make it a simile, as in the UST.',
        ar: `في هذه الاستعارة، يقول يهوه إن الإسرائيليين سيكونون كالنار واللهب، وإن شعب أدوم سيكون كالعشب الجاف، وإن الإسرائيليين سيفعلون بشعب أدوم ما تفعله النار واللهب بالعشب الجاف. بمعنى آخر، كما تحرق النار واللهب العشب الجاف حتى يفنى كله، كذلك سيغزو الإسرائيليون الناجون كل أرض أدوم. إذا لم تكن هذه الاستعارة واضحة في لغتك، يمكنك تحويلها إلى تشبيه، كما في UST.` }
    ] },
  { ref: '1:20',
    ar: 'وسبي هذا الجيش من بني إسرائيل يرثون الذين هم من الكنعانيين إلى صرفة، وسبي أورشليم الذي في صفارد يرث مدن الجنوب.',
    ult: 'And the exile of this army of the sons of Israel, who are Canaanites, as far as Zarephath, and the exile of Jerusalem, who are in Sepharad: they will possess the cities of the Negev.',
    notes: [
      { id: 'cr35', status: 'draft', he: 'לִ⁠בְנֵ֨י יִשְׂרָאֵ֤ל', arq: ['من بني إسرائيل'], ulq: ['of the sons of Israel'],
        en: 'Here, there are two possibilities for the meaning of **the sons of Israel**: (1) In this context, **Israel** is identified as occupying territory in the north and is in contrast with **Jerusalem**, so it seems that **the sons of Israel** is referring to people who are from the northern kingdom of Israel. Alternate translation: [from northern Israel]; (2) It could refer to all of the descendants of Israel. Alternate translation: [of the people of Israel]',
        ar: `هنا يوجد احتمالان لمعنى **بني إسرائيل**: (1) في هذا السياق، يُحدَّد أن **إسرائيل** تحتل أراضٍ في الشمال وتُقابَل بـ **أورشليم**، فيبدو أن **بني إسرائيل** تشير إلى الناس من مملكة إسرائيل الشمالية. ترجمة بديلة: [من شمال إسرائيل]؛ (2) قد تشير إلى جميع نسل إسرائيل. ترجمة بديلة: [من شعب إسرائيل]` }
    ] }
];

const NOTES = [];
GROUPS.forEach((g) => g.notes.forEach((n) => NOTES.push(n)));
const IDS = NOTES.map((n) => n.id);

const TYPES = [
  ['Metaphor', 15], ['Metonymy', 13], ['Explicit information', 12], ['Synecdoche', 10], ['Idiom', 10],
  ['Abstract nouns', 10], ['Active or passive', 9], ['No type', 13], ['Personification', 8], ['Names', 7], ['Parallelism', 7],
  ['Rhetorical question', 5], ['Ellipsis', 4]
];

const CHIPS = {
  approved: { label: 'Approved', bg: '#E2F2EA', fg: '#0E5B3E', dot: '#1E8A5F' },
  edited: { label: 'Edited', bg: '#FFF0D9', fg: '#8A4600', dot: '#D07A00' },
  draft: { label: 'Draft · AI', bg: '#ECEFF3', fg: '#3A4450', dot: '#8A94A0' },
  pending: { label: 'Pending · AI', bg: '#E8EEFB', fg: '#1F4FA0', dot: '#1F5FBF' },
  notneeded: { label: 'Not needed', bg: '#F1F1F1', fg: '#5E6670', dot: '#A0A7AF' },
  unsaved: { label: 'Unsaved', bg: '#FFF3CC', fg: '#7A5200', dot: '#D08A00' }
};

const STRONG = '#FFD966';
const SOFT = '#FFF1C2';


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

const LIST = NOTES;
const ORDER = IDS;

function strip(s) { return s.replace(/⁠/g, ''); }

function marksMulti(text, list) {
  const t = strip(text);
  const hits = [];
  list.forEach((m) => {
    const q = strip(m.q);
    let from = 0;
    while (from <= t.length) {
      const i = t.indexOf(q, from);
      if (i < 0) break;
      const clash = hits.some((h) => i < h.end && i + q.length > h.start);
      if (!clash) { hits.push({ start: i, end: i + q.length, bg: m.bg }); break; }
      from = i + 1;
    }
  });
  hits.sort((a, b) => a.start - b.start);
  const out = [];
  let pos = 0;
  hits.forEach((h) => {
    if (h.start > pos) out.push({ t: t.slice(pos, h.start), bg: 'transparent' });
    out.push({ t: t.slice(h.start, h.end), bg: h.bg });
    pos = h.end;
  });
  if (pos < t.length) out.push({ t: t.slice(pos), bg: 'transparent' });
  return out;
}

function md(text) {
  return text.split('**').map((t, i) => ({ t: t, w: i % 2 ? 700 : 400 }));
}

class Component extends DCLogic {
  defaults() {
    const base = { sel: {}, anchor: null, editing: null, drafts: {}, statusOv: {}, arOv: {}, showEn: true, showUlt: true, showKeys: false, focus: 'qpw7', scope: 'chapter', size: 20, msg: null, undoSnap: null };
    if ((this.props.preset ?? 'full') === 'compact') {
      base.showEn = false;
      base.showUlt = false;
      base.scope = 'book';
      base.sel = { djk9: true, cr7s: true, qz7p: true, vcve: true };
      base.anchor = 'djk9';
      base.focus = 'cr7s';
    }
    return base;
  }

  s() { return Object.assign({}, this.defaults(), this.state || {}); }
  snap(s) { return { statusOv: s.statusOv, arOv: s.arOv, drafts: s.drafts }; }
  statusOf(s, n) { return s.statusOv[n.id] ?? n.status; }
  arOf(s, n) { return s.arOv[n.id] ?? n.ar; }

  toggle(id, e) {
    const s = this.s();
    const sel = Object.assign({}, s.sel);
    const val = !sel[id];
    if (e && e.shiftKey && s.anchor && s.anchor !== id) {
      const a = IDS.indexOf(s.anchor), b = IDS.indexOf(id);
      const lo = Math.min(a, b), hi = Math.max(a, b);
      for (let k = lo; k <= hi; k++) { if (val) sel[IDS[k]] = true; else delete sel[IDS[k]]; }
    } else {
      if (val) sel[id] = true; else delete sel[id];
    }
    this.setState({ sel: sel, anchor: id, focus: id, msg: null });
  }

  toggleGroup(g) {
    const s = this.s();
    const sel = Object.assign({}, s.sel);
    const all = g.notes.every((n) => sel[n.id]);
    g.notes.forEach((n) => { if (all) delete sel[n.id]; else sel[n.id] = true; });
    const last = g.notes[g.notes.length - 1].id;
    this.setState({ sel: sel, anchor: last, focus: g.notes[0].id, msg: null });
  }

  toggleAll() {
    const s = this.s();
    if (Object.keys(s.sel).length === IDS.length) this.setState({ sel: {}, anchor: null, msg: null });
    else { const sel = {}; IDS.forEach((id) => { sel[id] = true; }); this.setState({ sel: sel, msg: null }); }
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
      } else if (kind === 'redo') statusOv[id] = 'pending';
      else if (kind === 'notneeded') statusOv[id] = 'notneeded';
    });
    const n = ids.length;
    const pl = n === 1 ? '' : 's';
    const msg = kind === 'approve'
      ? 'Approved ' + n + ' note' + pl + (savedFirst ? ' (saved ' + savedFirst + ' unsaved edit first)' : '') + '.'
      : kind === 'redo'
        ? 'Asked the AI to redo ' + n + ' note' + pl + '. New drafts appear when ready.'
        : 'Set aside ' + n + ' note' + pl + ' as not needed.';
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
    const n = NOTES.find((x) => x.id === id);
    const drafts = Object.assign({}, s.drafts);
    if (drafts[id] === undefined) drafts[id] = this.arOf(s, n);
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
    } else if ((k === 'u' || k === 'U') && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      this.setState({ showUlt: !s.showUlt });
    } else if ((k === 'e' || k === 'E') && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      this.setState({ showEn: !s.showEn });
    }
  }

  renderVals() {
    const s = this.s();
    const selIds = Object.keys(s.sel);
    const selCount = selIds.length;
    const dirtySel = selIds.filter((id) => s.drafts[id] !== undefined).length;
    const stop = (e) => { if (e && e.stopPropagation) e.stopPropagation(); };

    let firstInGroup = true;
    const groups = GROUPS.map((g) => {
      const focusIn = g.notes.some((n) => n.id === s.focus);
      const arList = [], ultList = [];
      g.notes.forEach((n) => {
        const bg = !focusIn || n.id === s.focus ? STRONG : SOFT;
        n.arq.forEach((q) => arList.push({ q: q, bg: bg }));
        n.ulq.forEach((q) => ultList.push({ q: q, bg: bg }));
      });
      const nSel = g.notes.filter((n) => s.sel[n.id]).length;
      const gOn = nSel === g.notes.length;
      const gMixed = nSel > 0 && !gOn;
      firstInGroup = true;
      const notes = g.notes.map((n) => {
        const st = this.statusOf(s, n);
        const sel = !!s.sel[n.id];
        const draft = s.drafts[n.id];
        const dirty = draft !== undefined && draft !== this.arOf(s, n);
        const chip = dirty ? CHIPS.unsaved : CHIPS[st];
        const isEditing = s.editing === n.id;
        const divider = firstInGroup ? '0' : '1px solid #E3E7EC';
        firstInGroup = false;
        return {
          id: n.id,
          he: strip(n.he),
          arqLabel: n.arq.join(' … '),
          quoteBg: !focusIn || n.id === s.focus ? STRONG : SOFT,
          enSeg: md(n.en),
          arSeg: md(dirty ? draft : this.arOf(s, n)),
          draft: draft ?? this.arOf(s, n),
          sel: sel,
          aria: sel ? 'true' : 'false',
          cbBorder: sel ? '#1F5FBF' : '#6B7480',
          cbBg: sel ? '#1F5FBF' : '#FFFFFF',
          isAnchor: s.anchor === n.id && selCount > 0,
          divider: divider,
          bg: sel ? '#EAF1FC' : (s.focus === n.id ? '#F5F8FE' : '#FFFFFF'),
          curBar: s.focus === n.id ? 'inset 4px 0 0 #1F5FBF' : 'none',
          opacity: st === 'notneeded' ? 0.55 : 1,
          cellBorder: dirty ? '#E3B341' : '#D5DAE0',
          cellBg: dirty ? '#FFFBEA' : '#FFFFFF',
          ...statVals(dirty ? 'unsaved' : st, n.id),
          flip: (e) => { stop(e); this.flipApprove(n.id); },
          makeCurrent: () => this.setState({ focus: n.id }),
          canApprove: st !== 'approved' && st !== 'notneeded',
          isEditing: isEditing,
          notEditing: !isEditing,
          toggle: (e) => { stop(e); this.toggle(n.id, e); },
          noTextSelect: (e) => { if (e && e.shiftKey) e.preventDefault(); },
          edit: (e) => { stop(e); this.edit(n.id); },
          onEdit: (e) => { const d = Object.assign({}, this.s().drafts); d[n.id] = e.target.value; this.setState({ drafts: d }); },
          cancel: (e) => { stop(e); this.one(n.id, 'cancel'); },
          save: (e) => { stop(e); this.one(n.id, 'save'); },
          saveApprove: (e) => { stop(e); this.one(n.id, 'approve'); },
          approve: (e) => { stop(e); this.one(n.id, 'approve'); }
        };
      });
      return {
        ref: g.ref,
        countLabel: g.notes.length === 1 ? '1 metaphor note' : g.notes.length + ' metaphor notes',
        arSeg: marksMulti(g.ar, arList),
        ultSeg: marksMulti(g.ult, ultList),
        notes: notes,
        aria: gOn ? 'true' : (gMixed ? 'mixed' : 'false'),
        on: gOn,
        mixed: gMixed,
        cbBorder: nSel ? '#1F5FBF' : '#6B7480',
        cbBg: nSel ? '#1F5FBF' : '#FFFFFF',
        toggle: (e) => { stop(e); this.toggleGroup(g); },
        noTextSelect: (e) => { if (e && e.shiftKey) e.preventDefault(); }
      };
    });

    const approved = NOTES.filter((n) => this.statusOf(s, n) === 'approved').length;
    const chapterApproved = 19 + 2 + (approved - 2);

    const seg = (label, on, pick) => ({
      label: label,
      pressed: on ? 'true' : 'false',
      bg: on ? '#FFFFFF' : 'transparent',
      fg: on ? '#1B1F24' : '#3A4450',
      shadow: on ? '0 1px 2px rgba(0,0,0,0.12)' : 'none',
      pick: pick
    });

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

    const allOn = selCount === IDS.length;
    const mixed = selCount > 0 && !allOn;

    return {
      onKey: (e) => this.onKey(e),
      rootH: (this.props.preset ?? 'full') === 'compact' ? '768px' : 'auto',
      rootOv: (this.props.preset ?? 'full') === 'compact' ? 'hidden' : 'visible',
      listOv: (this.props.preset ?? 'full') === 'compact' ? 'auto' : 'visible',
      showKeys: s.showKeys,
      keysOpen: s.showKeys ? 'true' : 'false',
      flipKeys: () => this.setState({ showKeys: !s.showKeys }),
      types: TYPES.slice(0, 8).map((t, i) => ({
        label: t[0], count: t[1],
        current: i === 0 ? 'page' : 'false',
        border: i === 0 ? '#1F5FBF' : '#D5DAE0',
        bg: i === 0 ? '#E8EEFB' : '#FFFFFF',
        fg: i === 0 ? '#1F4FA0' : '#2B323A',
        weight: i === 0 ? 700 : 500,
        countBg: i === 0 ? '#1F5FBF' : '#EEF0F3',
        countFg: i === 0 ? '#FFFFFF' : '#3A4450'
      })),
      scopeLine: (s.scope === 'book' ? '15 notes in Obadiah' : '15 notes in chapter 1') + ' · ' + approved + ' approved',
      isBook: s.scope === 'book',
      scopes: [
        seg('This chapter', s.scope === 'chapter', () => this.setState({ scope: 'chapter' })),
        seg('Whole book', s.scope === 'book', () => this.setState({ scope: 'book' }))
      ],
      sizes: [
        seg('20 per page', s.size === 20, () => this.setState({ size: 20 })),
        seg('50', s.size === 50, () => this.setState({ size: 50 })),
        seg('All', s.size === 0, () => this.setState({ size: 0 }))
      ],
      toggles: [tog('ULT', 'showUlt'), tog('English note', 'showEn')],
      showUlt: s.showUlt,
      showEn: s.showEn,
      groups: groups,
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
      barBorder: selCount ? '#B8CCF0' : '#E3E7EC',
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
console.log('Issue start   ', st());
c.onKey(ev('j')); console.log('j         ', st());
c.onKey(ev('a')); console.log('a         ', st());
c.onKey(ev('J',{shiftKey:true})); console.log('shift J   ', st());
c.onKey(ev('a')); console.log('a (bulk)  ', st(), '|', c.s().msg);
c.onKey(ev('k')); c.onKey(ev(' ')); console.log('k space   ', st());
c.onKey(ev('Enter')); console.log('enter editing=', c.s().editing);
c.onKey(ev('Escape',{target:{tagName:'TEXTAREA'}})); console.log('esc editing=', c.s().editing);
c.onKey(ev('Enter')); c.onKey(ev('Enter',{ctrlKey:true,target:{tagName:'TEXTAREA'}})); console.log('ctrl+enter', st());
const v=c.renderVals(); const r=(v.rows||v.groups.flatMap(g=>g.notes)).find(r=>r.stLabel==='Approved'); r.flip(); console.log('unapprove '+r.id, c.s().statusOv[r.id], c.s().msg);
