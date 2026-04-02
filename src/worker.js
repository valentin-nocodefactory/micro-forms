/**
 * NCF Diagnostic Admin — Cloudflare Worker
 *
 * Routes:
 *   GET  /                    → redirect /admin
 *   GET  /admin               → admin UI
 *   GET  /api/configs         → liste toutes les configs
 *   GET  /api/configs/:path   → une config (path = encodedURIComponent du pathname)
 *   PUT  /api/configs/:path   → créer/modifier une config
 *   DELETE /api/configs/:path → supprimer une config
 *   GET  /ncf-diagnostic.js   → JS dynamique avec toutes les configs depuis KV
 */

const KV_PREFIX = "config:";

// ─── AUTH ──────────────────────────────────────────────────────────────────────

function checkAuth(request, env) {
  if (!env.ADMIN_TOKEN) return true;
  const auth = request.headers.get("Authorization");
  if (!auth) return false;
  const token = auth.replace(/^Bearer\s+/i, "");
  return token === env.ADMIN_TOKEN;
}

function unauthorized() {
  return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}

// ─── API ───────────────────────────────────────────────────────────────────────

async function handleAPI(request, env, path) {
  if (!checkAuth(request, env)) return unauthorized();

  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  // GET /api/configs — list all
  if (path === "/api/configs" && request.method === "GET") {
    const list = await env.CONFIGS.list({ prefix: KV_PREFIX });
    const configs = [];
    for (const key of list.keys) {
      const val = await env.CONFIGS.get(key.name, "json");
      configs.push({
        path: key.name.slice(KV_PREFIX.length),
        config: val,
      });
    }
    return new Response(JSON.stringify(configs), { headers });
  }

  // GET/PUT/DELETE /api/configs/:encodedPath
  const match = path.match(/^\/api\/configs\/(.+)$/);
  if (match) {
    const configPath = decodeURIComponent(match[1]);
    const kvKey = KV_PREFIX + configPath;

    if (request.method === "GET") {
      const val = await env.CONFIGS.get(kvKey, "json");
      if (!val) return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers });
      return new Response(JSON.stringify({ path: configPath, config: val }), { headers });
    }

    if (request.method === "PUT") {
      const body = await request.json();
      await env.CONFIGS.put(kvKey, JSON.stringify(body));
      return new Response(JSON.stringify({ ok: true, path: configPath }), { headers });
    }

    if (request.method === "DELETE") {
      await env.CONFIGS.delete(kvKey);
      return new Response(JSON.stringify({ ok: true }), { headers });
    }
  }

  // POST /api/seed — injecter les configs par défaut
  if (path === "/api/seed" && request.method === "POST") {
    const existing = await env.CONFIGS.list({ prefix: KV_PREFIX, limit: 1 });
    if (existing.keys.length > 0) {
      return new Response(JSON.stringify({ ok: false, message: "KV already has configs, skipping seed" }), { headers });
    }
    for (const [seedPath, seedConfig] of Object.entries(DEFAULT_CONFIGS)) {
      await env.CONFIGS.put(KV_PREFIX + seedPath, JSON.stringify(seedConfig));
    }
    return new Response(JSON.stringify({ ok: true, seeded: Object.keys(DEFAULT_CONFIGS).length }), { headers });
  }

  return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers });
}

// ─── DIAGNOSTIC JS DYNAMIQUE ──────────────────────────────────────────────────

async function serveDiagnosticJS(env) {
  const list = await env.CONFIGS.list({ prefix: KV_PREFIX });
  const configs = {};
  for (const key of list.keys) {
    const val = await env.CONFIGS.get(key.name, "json");
    const p = key.name.slice(KV_PREFIX.length);
    configs[p] = val;
  }

  const js = DIAGNOSTIC_JS_TEMPLATE.replace(
    '"__NCF_CONFIGS_PLACEHOLDER__"',
    JSON.stringify(configs, null, 2)
  );

  return new Response(js, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=60",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// ─── DEFAULT CONFIGS (pour le seed initial) ──────────────────────────────────

const DEFAULT_CONFIGS = {
  "/blog/ia-entreprise": {
    questions: [
      { question: "Où en êtes-vous avec l'IA dans votre entreprise ?", options: [
        { label: "On n'y a pas encore touché", score: 1, emoji: "🌱" },
        { label: "On a testé ChatGPT ponctuellement", score: 2, emoji: "🧪" },
        { label: "Quelques outils IA sont utilisés par l'équipe", score: 3, emoji: "⚙️" },
        { label: "L'IA est intégrée dans nos process", score: 4, emoji: "🚀" },
      ]},
      { question: "Quel est votre plus gros frein aujourd'hui ?", options: [
        { label: "Je ne sais pas par où commencer", score: 1, emoji: "🤔" },
        { label: "Je manque de temps pour explorer", score: 2, emoji: "⏳" },
        { label: "Mon équipe n'est pas formée", score: 2, emoji: "🎓" },
        { label: "Trouver les bons cas d'usage", score: 3, emoji: "🎯" },
      ]},
      { question: "Combien de temps votre équipe passe-t-elle sur des tâches répétitives par semaine ?", options: [
        { label: "Moins de 5h", score: 4, emoji: "✅" },
        { label: "Entre 5h et 15h", score: 3, emoji: "💡" },
        { label: "Entre 15h et 30h", score: 2, emoji: "⚠️" },
        { label: "Plus de 30h", score: 1, emoji: "🔥" },
      ]},
      { question: "Quel serait l'impact idéal de l'IA pour vous ?", options: [
        { label: "Gagner du temps au quotidien", score: 2, emoji: "⏱️" },
        { label: "Réduire les coûts opérationnels", score: 3, emoji: "💰" },
        { label: "Améliorer la qualité de service", score: 3, emoji: "⭐" },
        { label: "Prendre de meilleures décisions", score: 4, emoji: "📊" },
      ]},
    ],
    results: [
      { maxScore: 7, tag: "Phase découverte", tagBg: "#FAEEDA", tagColor: "#854F0B", title: "Vous êtes au tout début du voyage IA", desc: "Pas de panique — la majorité des PME sont dans votre situation. L'important, c'est de commencer avec un cadrage clair pour éviter de perdre du temps sur les mauvais outils.", reco: "Un diagnostic de 30 min avec notre équipe vous permettra d'identifier les 2-3 quick wins IA les plus impactants pour votre activité." },
      { maxScore: 11, tag: "Phase accélération", tagBg: "#E0F2FE", tagColor: "#0C4A6E", title: "Vous avez les bases, il faut structurer", desc: "Vous avez déjà une sensibilité IA, mais il manque une stratégie claire pour passer à l'échelle. C'est le moment de transformer les expérimentations en process.", reco: "On peut vous aider à construire une roadmap IA concrète adaptée à vos enjeux métier et à votre budget." },
      { maxScore: 16, tag: "Phase industrialisation", tagBg: "#DCFCE7", tagColor: "#14532D", title: "Vous êtes déjà bien avancé", desc: "Bravo ! Vous faites partie des entreprises qui ont pris le virage. L'enjeu maintenant : optimiser, automatiser davantage et former vos équipes en continu.", reco: "Un audit de vos workflows actuels pourrait révéler des gains de productivité supplémentaires de 20-40%." },
    ],
    cta: { label: "Réserver mon diagnostic gratuit", url: "https://calendly.com/nocodefactory", sub: "30 min · Sans engagement · 100% actionnable" },
  },
  "/blog/webflow-meilleur-cms": {
    questions: [
      { question: "Quel est votre site actuel ?", options: [
        { label: "WordPress", score: 2, emoji: "📝" },
        { label: "Wix, Squarespace ou autre", score: 2, emoji: "🌐" },
        { label: "Site codé sur mesure", score: 3, emoji: "💻" },
        { label: "Je n'ai pas encore de site", score: 1, emoji: "🆕" },
      ]},
      { question: "Qui gère votre site au quotidien ?", options: [
        { label: "Un développeur externe (freelance/agence)", score: 1, emoji: "👨‍💻" },
        { label: "Notre équipe marketing", score: 3, emoji: "📣" },
        { label: "Moi-même, tant bien que mal", score: 2, emoji: "🤷" },
        { label: "Personne — il est à l'abandon", score: 1, emoji: "👻" },
      ]},
      { question: "Quelle est votre frustration principale ?", options: [
        { label: "Dépendance à un dev pour chaque modif", score: 1, emoji: "🔒" },
        { label: "Le site est lent ou mal référencé", score: 2, emoji: "🐢" },
        { label: "Le design ne me représente plus", score: 3, emoji: "🎨" },
        { label: "C'est trop cher pour ce que c'est", score: 2, emoji: "💸" },
      ]},
      { question: "Quel est votre objectif principal ?", options: [
        { label: "Générer plus de leads", score: 3, emoji: "🎯" },
        { label: "Être autonome sur mon site", score: 2, emoji: "💪" },
        { label: "Améliorer mon image de marque", score: 3, emoji: "✨" },
        { label: "Lancer rapidement un nouveau site", score: 1, emoji: "⚡" },
      ]},
    ],
    results: [
      { maxScore: 6, tag: "Migration recommandée", tagBg: "#FEE2E2", tagColor: "#991B1B", title: "Webflow pourrait transformer votre présence en ligne", desc: "Votre situation actuelle vous freine clairement. Une migration vers Webflow vous donnerait l'autonomie, la performance et le design que vous méritez.", reco: "On audite gratuitement votre site actuel et on vous montre concrètement ce que Webflow changerait pour vous." },
      { maxScore: 9, tag: "Optimisation possible", tagBg: "#FEF3C7", tagColor: "#854F0B", title: "Vous avez une bonne base, Webflow peut l'améliorer", desc: "Votre setup fonctionne mais pourrait être nettement plus efficace. Webflow vous permettrait de gagner en autonomie et en performance SEO.", reco: "Un échange de 30 min pour comparer objectivement votre solution actuelle vs Webflow sur vos critères." },
      { maxScore: 16, tag: "Fine-tuning", tagBg: "#DCFCE7", tagColor: "#14532D", title: "Votre setup est solide, voyons les détails", desc: "Vous avez déjà une bonne maîtrise. L'enjeu est d'optimiser les conversions, le SEO technique et l'expérience utilisateur.", reco: "Un audit technique rapide pourrait révéler des opportunités d'optimisation que vous n'avez pas encore exploitées." },
    ],
    cta: { label: "Évaluer mon site gratuitement", url: "https://calendly.com/nocodefactory", sub: "30 min · Sans engagement · Analyse personnalisée" },
  },
};

// ─── ROUTER ────────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    // Diagnostic JS
    if (path === "/ncf-diagnostic.js") {
      return serveDiagnosticJS(env);
    }

    // API
    if (path.startsWith("/api/")) {
      return handleAPI(request, env, path);
    }

    // Auth check endpoint
    if (path === "/auth/check") {
      const ok = checkAuth(request, env);
      const needsAuth = !!env.ADMIN_TOKEN;
      return new Response(JSON.stringify({ ok, needsAuth }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Admin UI
    if (path === "/" || path === "/admin") {
      return new Response(ADMIN_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};

// ─── DIAGNOSTIC JS TEMPLATE ──────────────────────────────────────────────────
// Le template complet du script diagnostic — le placeholder est remplacé
// dynamiquement par les configs depuis KV

const DIAGNOSTIC_JS_TEMPLATE = `/**
 * NCF Diagnostic Loader — NoCode Factory
 * Généré dynamiquement depuis Cloudflare KV
 */
(function () {
  "use strict";

  var NCF_DIAGNOSTIC_CONFIGS = "__NCF_CONFIGS_PLACEHOLDER__";

  var STYLE_ID = "ncf-diagnostic-styles";

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent =
      ".ncf-wrap{max-width:520px;margin:32px auto;background:#fff;border-radius:16px;box-shadow:0 1px 2px rgba(0,0,0,.04),0 6px 24px rgba(0,0,0,.06);border:1px solid rgba(0,0,0,.06);overflow:hidden;font-family:inherit;position:relative}" +
      ".ncf-bar{height:4px;background:linear-gradient(90deg,#E94235,#F28B30,#FBBC04,#34A853,#4ECDC4,#7B68EE,#C084FC,#E091B5,#6BCFA8,#4DD0C8);background-size:520px 4px;transition:width .7s cubic-bezier(.34,1.56,.64,1)}" +
      ".ncf-inner{padding:28px 24px 24px}" +
      ".ncf-step{font-size:13px;color:#888;margin-bottom:6px;transition:opacity .3s,transform .3s}" +
      ".ncf-q{font-size:18px;font-weight:600;line-height:1.4;color:#1a1a1a;margin-bottom:20px;transition:opacity .3s,transform .3s}" +
      ".ncf-opts{display:flex;flex-direction:column;gap:10px}" +
      ".ncf-opt{display:flex;align-items:center;gap:12px;padding:14px 16px;border:1.5px solid rgba(0,0,0,.1);border-radius:12px;cursor:pointer;font-size:15px;line-height:1.4;color:#1a1a1a;background:#fff;transition:border-color .2s,background .2s,transform .15s,opacity .35s cubic-bezier(.16,1,.3,1);opacity:0;transform:translateY(8px) scale(.97)}" +
      ".ncf-opt:hover{border-color:#7B68EE;background:rgba(123,104,238,.04)}" +
      ".ncf-opt.ncf-visible{opacity:1;transform:translateY(0) scale(1)}" +
      ".ncf-opt.ncf-selected{border-color:#7B68EE;background:rgba(123,104,238,.06);transform:scale(.985)}" +
      ".ncf-opt.ncf-fading{opacity:0;transform:translateY(-4px);pointer-events:none}" +
      ".ncf-opt-emoji{font-size:20px;flex-shrink:0}" +
      ".ncf-opt-label{flex:1}" +
      ".ncf-exit .ncf-q,.ncf-exit .ncf-step{opacity:0;transform:translateY(-6px)}" +
      ".ncf-result{text-align:center;opacity:0;animation:ncfFadeUp .5s cubic-bezier(.16,1,.3,1) forwards}" +
      "@keyframes ncfFadeUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}" +
      ".ncf-circle-wrap{position:relative;width:112px;height:112px;margin:0 auto 16px}" +
      ".ncf-circle-bg{fill:none;stroke:rgba(0,0,0,.06);stroke-width:7}" +
      ".ncf-circle-fg{fill:none;stroke-width:7;stroke-linecap:round;transition:stroke-dashoffset 1.2s cubic-bezier(.22,1,.36,1) .2s}" +
      ".ncf-score-txt{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:700;color:#1a1a1a}" +
      ".ncf-tag{display:inline-block;padding:4px 14px;border-radius:99px;font-size:13px;font-weight:600;margin-bottom:12px}" +
      ".ncf-rtitle{font-size:20px;font-weight:700;color:#1a1a1a;margin-bottom:8px}" +
      ".ncf-rdesc{font-size:14px;color:#555;line-height:1.6;margin-bottom:20px}" +
      ".ncf-reco{background:#f8f8f8;border-radius:12px;padding:16px;margin-bottom:20px}" +
      ".ncf-reco-label{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#7B68EE;margin-bottom:6px}" +
      ".ncf-reco-text{font-size:14px;color:#333;line-height:1.5}" +
      ".ncf-cta{display:inline-block;padding:14px 32px;border-radius:12px;background:#7B68EE;color:#fff;font-size:16px;font-weight:600;text-decoration:none;transition:background .2s,transform .15s}" +
      ".ncf-cta:hover{background:#6a56e0;transform:translateY(-1px)}" +
      ".ncf-sub{font-size:13px;color:#888;margin-top:10px}" +
      ".ncf-reset{display:inline-block;margin-top:16px;font-size:13px;color:#888;cursor:pointer;background:none;border:none;font-family:inherit}" +
      ".ncf-reset:hover{color:#555}" +
      ".ncf-anim{opacity:0;animation:ncfFadeUp .5s cubic-bezier(.16,1,.3,1) forwards}" +
      "@media(prefers-color-scheme:dark){" +
        ".ncf-wrap{background:#1c1c1e;border-color:rgba(255,255,255,.08);box-shadow:0 1px 2px rgba(0,0,0,.2),0 6px 24px rgba(0,0,0,.3)}" +
        ".ncf-q,.ncf-rtitle,.ncf-score-txt{color:#f0f0f0}" +
        ".ncf-step{color:#888}" +
        ".ncf-opt{background:#2c2c2e;border-color:rgba(255,255,255,.1);color:#e8e8e8}" +
        ".ncf-opt:hover{background:rgba(123,104,238,.1);border-color:#7B68EE}" +
        ".ncf-opt.ncf-selected{background:rgba(123,104,238,.15)}" +
        ".ncf-rdesc{color:#aaa}" +
        ".ncf-reco{background:#2c2c2e}" +
        ".ncf-reco-text{color:#ccc}" +
        ".ncf-sub{color:#777}" +
        ".ncf-reset{color:#777}" +
        ".ncf-reset:hover{color:#aaa}" +
        ".ncf-circle-bg{stroke:rgba(255,255,255,.08)}" +
      "}" +
      "@media(max-width:560px){" +
        ".ncf-wrap{margin:24px 12px;border-radius:14px}" +
        ".ncf-inner{padding:22px 18px 20px}" +
        ".ncf-q{font-size:16px}" +
      "}";
    document.head.appendChild(style);
  }

  function renderDiagnostic(container, config) {
    var state = { step: 0, scores: [] };
    var total = config.questions.length;
    container.innerHTML = "";
    var wrap = el("div", "ncf-wrap");
    var bar = el("div", "ncf-bar");
    var inner = el("div", "ncf-inner");
    wrap.appendChild(bar);
    wrap.appendChild(inner);
    container.appendChild(wrap);
    showQuestion();

    function showQuestion() {
      var q = config.questions[state.step];
      inner.innerHTML = "";
      var pct = (state.step / total) * 100;
      bar.style.width = pct + "%";
      requestAnimationFrame(function () {
        bar.style.width = ((state.step + 1) / total) * 100 + "%";
      });
      var stepEl = el("div", "ncf-step");
      stepEl.textContent = "Question " + (state.step + 1) + "/" + total;
      inner.appendChild(stepEl);
      var qEl = el("div", "ncf-q");
      qEl.textContent = q.question;
      inner.appendChild(qEl);
      var optsWrap = el("div", "ncf-opts");
      var optEls = [];
      q.options.forEach(function (opt, i) {
        var optEl = el("div", "ncf-opt");
        var emojiEl = el("span", "ncf-opt-emoji");
        emojiEl.textContent = opt.emoji;
        var labelEl = el("span", "ncf-opt-label");
        labelEl.textContent = opt.label;
        optEl.appendChild(emojiEl);
        optEl.appendChild(labelEl);
        optsWrap.appendChild(optEl);
        optEls.push(optEl);
        var delay = 0.08 + i * 0.06;
        optEl.style.transitionDelay = delay + "s";
        setTimeout(function () { optEl.classList.add("ncf-visible"); }, delay * 1000);
        optEl.addEventListener("click", function () {
          if (optEl.classList.contains("ncf-selected")) return;
          state.scores.push(opt.score);
          optEl.classList.add("ncf-selected");
          optEls.forEach(function (o, j) {
            if (j !== i) {
              o.style.transitionDelay = Math.abs(j - i) * 0.04 + "s";
              o.classList.add("ncf-fading");
            }
          });
          inner.classList.add("ncf-exit");
          setTimeout(function () {
            inner.classList.remove("ncf-exit");
            state.step++;
            if (state.step < total) showQuestion();
            else showResult();
          }, 420);
        });
      });
      inner.appendChild(optsWrap);
    }

    function showResult() {
      inner.innerHTML = "";
      bar.style.width = "100%";
      var totalScore = 0, maxPossible = 0;
      config.questions.forEach(function (q, i) {
        totalScore += state.scores[i];
        var mx = 0;
        q.options.forEach(function (o) { if (o.score > mx) mx = o.score; });
        maxPossible += mx;
      });
      var pct = Math.round((totalScore / maxPossible) * 100);
      var result = config.results[config.results.length - 1];
      for (var r = 0; r < config.results.length; r++) {
        if (totalScore <= config.results[r].maxScore) { result = config.results[r]; break; }
      }
      var rd = el("div", "ncf-result");
      var R = 48, C = 2 * Math.PI * R;
      var svgNS = "http://www.w3.org/2000/svg";
      var cw = el("div", "ncf-circle-wrap ncf-anim");
      cw.style.animationDelay = "0.1s";
      var svg = document.createElementNS(svgNS, "svg");
      svg.setAttribute("width","112"); svg.setAttribute("height","112"); svg.setAttribute("viewBox","0 0 112 112");
      var bg = document.createElementNS(svgNS,"circle");
      bg.setAttribute("cx","56"); bg.setAttribute("cy","56"); bg.setAttribute("r",String(R)); bg.setAttribute("class","ncf-circle-bg");
      var fg = document.createElementNS(svgNS,"circle");
      fg.setAttribute("cx","56"); fg.setAttribute("cy","56"); fg.setAttribute("r",String(R)); fg.setAttribute("class","ncf-circle-fg");
      fg.setAttribute("stroke",result.tagColor); fg.setAttribute("stroke-dasharray",String(C)); fg.setAttribute("stroke-dashoffset",String(C));
      fg.setAttribute("transform","rotate(-90 56 56)");
      svg.appendChild(bg); svg.appendChild(fg); cw.appendChild(svg);
      var st = el("div","ncf-score-txt"); st.textContent="0%"; cw.appendChild(st); rd.appendChild(cw);
      var tag = el("div","ncf-tag ncf-anim"); tag.style.background=result.tagBg; tag.style.color=result.tagColor;
      tag.style.animationDelay="0.2s"; tag.textContent=result.tag; rd.appendChild(tag);
      var ti = el("div","ncf-rtitle ncf-anim"); ti.style.animationDelay="0.25s"; ti.textContent=result.title; rd.appendChild(ti);
      var de = el("div","ncf-rdesc ncf-anim"); de.style.animationDelay="0.3s"; de.textContent=result.desc; rd.appendChild(de);
      var re = el("div","ncf-reco ncf-anim"); re.style.animationDelay="0.35s";
      var rl = el("div","ncf-reco-label"); rl.textContent="Notre recommandation";
      var rt = el("div","ncf-reco-text"); rt.textContent=result.reco;
      re.appendChild(rl); re.appendChild(rt); rd.appendChild(re);
      var ca = document.createElement("a"); ca.className="ncf-cta ncf-anim"; ca.style.animationDelay="0.45s";
      ca.href=config.cta.url; ca.target="_blank"; ca.rel="noopener"; ca.textContent=config.cta.label; rd.appendChild(ca);
      var su = el("div","ncf-sub ncf-anim"); su.style.animationDelay="0.5s"; su.textContent=config.cta.sub; rd.appendChild(su);
      var rs = document.createElement("button"); rs.className="ncf-reset ncf-anim"; rs.style.animationDelay="0.6s";
      rs.textContent="\\u2190 Recommencer";
      rs.addEventListener("click", function(){ state.step=0; state.scores=[]; bar.style.width="0%"; showQuestion(); });
      rd.appendChild(rs); inner.appendChild(rd);
      requestAnimationFrame(function(){ fg.setAttribute("stroke-dashoffset", String(C-(pct/100)*C)); });
      animateCounter(st, pct, 1000);
    }
  }

  function el(tag, cls) { var e = document.createElement(tag); if(cls) e.className=cls; return e; }

  function animateCounter(element, target, duration) {
    var start = performance.now();
    function tick(now) {
      var t = Math.min((now - start) / duration, 1);
      var eased = 1 - Math.pow(1 - t, 3);
      element.textContent = Math.round(eased * target) + "%";
      if (t < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  function normalizePath(p) { return p.replace(/\\/+$/, "") || "/"; }

  function init() {
    var path = normalizePath(window.location.pathname);
    var config = NCF_DIAGNOSTIC_CONFIGS[path];
    if (!config) return;
    var containers = document.querySelectorAll(".ncf-diagnostic");
    if (!containers.length) return;
    injectStyles();
    for (var i = 0; i < containers.length; i++) renderDiagnostic(containers[i], config);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();`;

// ─── ADMIN HTML ────────────────────────────────────────────────────────────────

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NCF Diagnostic — Admin</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#f5f5f7;--surface:#fff;--border:#e5e5e7;--text:#1a1a1a;--text2:#666;--text3:#999;
  --accent:#7B68EE;--accent-light:rgba(123,104,238,.08);--accent-hover:#6a56e0;
  --danger:#e53e3e;--danger-light:#fef2f2;
  --radius:12px;--radius-sm:8px;
  --shadow:0 1px 3px rgba(0,0,0,.06),0 4px 16px rgba(0,0,0,.04);
  --font:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
}
body{font-family:var(--font);background:var(--bg);color:var(--text);line-height:1.5;min-height:100vh}

/* ─── LAYOUT ─── */
.layout{display:flex;min-height:100vh}
.sidebar{width:280px;background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column;flex-shrink:0}
.main{flex:1;overflow-y:auto;padding:32px 40px}
@media(max-width:800px){
  .layout{flex-direction:column}
  .sidebar{width:100%;border-right:none;border-bottom:1px solid var(--border);max-height:40vh;overflow-y:auto}
  .main{padding:20px 16px}
}

/* ─── SIDEBAR ─── */
.sidebar-header{padding:20px;border-bottom:1px solid var(--border)}
.sidebar-header h1{font-size:16px;font-weight:700;display:flex;align-items:center;gap:8px}
.sidebar-header h1 span{background:linear-gradient(135deg,#7B68EE,#C084FC);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.sidebar-header p{font-size:12px;color:var(--text3);margin-top:2px}
.sidebar-list{flex:1;overflow-y:auto;padding:8px}
.sidebar-item{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:var(--radius-sm);cursor:pointer;font-size:14px;color:var(--text2);transition:background .15s,color .15s;border:none;background:none;width:100%;text-align:left;font-family:var(--font)}
.sidebar-item:hover{background:var(--accent-light);color:var(--text)}
.sidebar-item.active{background:var(--accent-light);color:var(--accent);font-weight:600}
.sidebar-item .path{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sidebar-item .count{font-size:11px;background:var(--border);border-radius:99px;padding:1px 8px;color:var(--text3);flex-shrink:0}
.sidebar-footer{padding:12px;border-top:1px solid var(--border);display:flex;flex-direction:column;gap:8px}

/* ─── BUTTONS ─── */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:8px 16px;border-radius:var(--radius-sm);font-size:13px;font-weight:600;border:none;cursor:pointer;transition:background .15s,transform .1s;font-family:var(--font)}
.btn:active{transform:scale(.97)}
.btn-primary{background:var(--accent);color:#fff}
.btn-primary:hover{background:var(--accent-hover)}
.btn-secondary{background:var(--surface);color:var(--text);border:1px solid var(--border)}
.btn-secondary:hover{background:var(--bg)}
.btn-danger{background:var(--danger-light);color:var(--danger);border:1px solid #fecaca}
.btn-danger:hover{background:#fee2e2}
.btn-full{width:100%}
.btn-sm{padding:6px 10px;font-size:12px}
.btn-icon{width:32px;height:32px;padding:0;border-radius:var(--radius-sm);background:none;border:1px solid var(--border);color:var(--text3);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;transition:background .15s,color .15s}
.btn-icon:hover{background:var(--bg);color:var(--text)}
.btn-icon.danger:hover{background:var(--danger-light);color:var(--danger);border-color:#fecaca}

/* ─── FORM ─── */
.form-group{margin-bottom:20px}
.form-label{display:block;font-size:12px;font-weight:600;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}
.form-input,.form-textarea{width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:var(--radius-sm);font-size:14px;font-family:var(--font);color:var(--text);background:var(--surface);transition:border-color .2s}
.form-input:focus,.form-textarea:focus{outline:none;border-color:var(--accent)}
.form-textarea{resize:vertical;min-height:60px}
.form-input-sm{padding:8px 10px;font-size:13px}
.form-row{display:flex;gap:12px}
.form-row>*{flex:1}

/* ─── SECTIONS ─── */
.section{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px;margin-bottom:16px;box-shadow:var(--shadow)}
.section-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
.section-title{font-size:15px;font-weight:700;display:flex;align-items:center;gap:8px}
.section-title .badge{font-size:11px;background:var(--accent-light);color:var(--accent);padding:2px 8px;border-radius:99px;font-weight:600}

/* ─── QUESTION CARD ─── */
.q-card{border:1px solid var(--border);border-radius:var(--radius-sm);padding:16px;margin-bottom:12px;background:var(--bg);position:relative}
.q-card-header{display:flex;align-items:center;gap:8px;margin-bottom:12px}
.q-num{width:24px;height:24px;border-radius:50%;background:var(--accent);color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.q-card-actions{display:flex;gap:4px;margin-left:auto}

/* ─── OPTION ROW ─── */
.opt-row{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.opt-emoji{width:44px}
.opt-label{flex:1}
.opt-score{width:60px}

/* ─── RESULT CARD ─── */
.r-card{border:1px solid var(--border);border-radius:var(--radius-sm);padding:16px;margin-bottom:12px;background:var(--bg)}
.r-card-header{display:flex;align-items:center;gap:8px;margin-bottom:12px}
.r-tag-preview{display:inline-block;padding:2px 10px;border-radius:99px;font-size:11px;font-weight:600}
.color-row{display:flex;gap:8px;align-items:center}
.color-input{width:40px;height:32px;border:1px solid var(--border);border-radius:6px;padding:2px;cursor:pointer;background:none}

/* ─── EMPTY STATE ─── */
.empty{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:400px;color:var(--text3);text-align:center}
.empty svg{width:64px;height:64px;margin-bottom:16px;opacity:.4}
.empty h2{font-size:18px;color:var(--text2);margin-bottom:4px}
.empty p{font-size:14px;margin-bottom:20px}

/* ─── PREVIEW ─── */
.preview-wrap{max-width:520px;margin:0 auto}

/* ─── TOAST ─── */
.toast{position:fixed;bottom:20px;right:20px;background:#1a1a1a;color:#fff;padding:12px 20px;border-radius:var(--radius-sm);font-size:14px;font-weight:500;z-index:1000;opacity:0;transform:translateY(10px);transition:opacity .3s,transform .3s;pointer-events:none}
.toast.visible{opacity:1;transform:translateY(0)}
.toast.error{background:var(--danger)}

/* ─── AUTH ─── */
.auth-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:999}
.auth-box{background:var(--surface);border-radius:var(--radius);padding:32px;width:360px;box-shadow:0 8px 32px rgba(0,0,0,.15);text-align:center}
.auth-box h2{margin-bottom:16px;font-size:18px}
.auth-box .form-input{margin-bottom:12px}

/* tabs */
.tabs{display:flex;gap:4px;margin-bottom:20px;border-bottom:2px solid var(--border);padding-bottom:0}
.tab{padding:8px 16px;border:none;background:none;cursor:pointer;font-size:14px;font-weight:500;color:var(--text3);border-bottom:2px solid transparent;margin-bottom:-2px;font-family:var(--font);transition:color .15s,border-color .15s}
.tab.active{color:var(--accent);border-bottom-color:var(--accent)}
.tab:hover{color:var(--text)}
.tab-content{display:none}
.tab-content.active{display:block}

/* header actions */
.header-actions{display:flex;align-items:center;gap:12px;margin-bottom:24px}
.page-title{font-size:22px;font-weight:700;flex:1}
</style>
</head>
<body>

<div class="layout" id="app">
  <aside class="sidebar">
    <div class="sidebar-header">
      <h1><span>NCF</span> Diagnostic Admin</h1>
      <p>Gestion des mini-diagnostics</p>
    </div>
    <div class="sidebar-list" id="sidebar-list"></div>
    <div class="sidebar-footer">
      <button class="btn btn-primary btn-full" onclick="newConfig()">+ Nouveau diagnostic</button>
      <button class="btn btn-secondary btn-full btn-sm" onclick="copyScriptTag()">Copier balise script</button>
    </div>
  </aside>

  <main class="main" id="main-content">
    <div class="empty" id="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"/></svg>
      <h2>Aucun diagnostic selectionne</h2>
      <p>Selectionnez un diagnostic ou creez-en un nouveau.</p>
    </div>
  </main>
</div>

<div class="toast" id="toast"></div>

<script>
// ─── STATE ─────────────────────────────────────────────────────────────────────
let configs = [];
let currentPath = null;
let token = sessionStorage.getItem("ncf_token") || "";

const API = "";  // same origin

// ─── AUTH ──────────────────────────────────────────────────────────────────────
async function checkAuth() {
  const res = await fetch(API + "/auth/check", {
    headers: token ? { Authorization: "Bearer " + token } : {},
  });
  const data = await res.json();
  if (data.needsAuth && !data.ok) showAuthPrompt();
  else loadConfigs();
}

function showAuthPrompt() {
  const overlay = document.createElement("div");
  overlay.className = "auth-overlay";
  overlay.innerHTML = \`
    <div class="auth-box">
      <h2>Connexion Admin</h2>
      <input type="password" class="form-input" id="auth-input" placeholder="Token d'acces">
      <button class="btn btn-primary btn-full" onclick="submitAuth()">Se connecter</button>
    </div>
  \`;
  document.body.appendChild(overlay);
  setTimeout(() => document.getElementById("auth-input").focus(), 100);
  document.getElementById("auth-input").addEventListener("keydown", e => { if (e.key === "Enter") submitAuth(); });
}

async function submitAuth() {
  token = document.getElementById("auth-input").value;
  sessionStorage.setItem("ncf_token", token);
  const res = await fetch(API + "/auth/check", { headers: { Authorization: "Bearer " + token } });
  const data = await res.json();
  if (data.ok) {
    document.querySelector(".auth-overlay")?.remove();
    loadConfigs();
  } else {
    toast("Token invalide", true);
    document.getElementById("auth-input").value = "";
    document.getElementById("auth-input").focus();
  }
}

// ─── API HELPERS ───────────────────────────────────────────────────────────────
function authHeaders(extra = {}) {
  const h = { "Content-Type": "application/json", ...extra };
  if (token) h.Authorization = "Bearer " + token;
  return h;
}

async function loadConfigs() {
  const res = await fetch(API + "/api/configs", { headers: authHeaders() });
  if (res.status === 401) { showAuthPrompt(); return; }
  configs = await res.json();
  if (configs.length === 0) {
    showSeedPrompt();
    return;
  }
  renderSidebar();
  if (currentPath) {
    const exists = configs.find(c => c.path === currentPath);
    if (exists) renderEditor(exists);
    else showEmpty();
  }
}

function showSeedPrompt() {
  document.getElementById("main-content").innerHTML = \`
    <div class="empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/></svg>
      <h2>Aucune config trouvee</h2>
      <p>Le KV est vide. Voulez-vous charger les 2 diagnostics d'exemple ?</p>
      <button class="btn btn-primary" onclick="seedDefaults()">Charger les exemples</button>
    </div>
  \`;
}

async function seedDefaults() {
  const res = await fetch(API + "/api/seed", { method: "POST", headers: authHeaders() });
  const data = await res.json();
  if (data.ok) {
    toast("Configs d'exemple chargees !");
    await loadConfigs();
  } else {
    toast(data.message || "Erreur", true);
  }
}

async function saveConfig(path, config) {
  const res = await fetch(API + "/api/configs/" + encodeURIComponent(path), {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify(config),
  });
  if (!res.ok) { toast("Erreur de sauvegarde", true); return false; }
  await loadConfigs();
  toast("Sauvegarde OK !");
  return true;
}

async function deleteConfig(path) {
  if (!confirm("Supprimer le diagnostic pour " + path + " ?")) return;
  await fetch(API + "/api/configs/" + encodeURIComponent(path), {
    method: "DELETE",
    headers: authHeaders(),
  });
  currentPath = null;
  showEmpty();
  await loadConfigs();
  toast("Supprime !");
}

// ─── RENDER SIDEBAR ────────────────────────────────────────────────────────────
function renderSidebar() {
  const list = document.getElementById("sidebar-list");
  list.innerHTML = "";
  configs.forEach(c => {
    const btn = document.createElement("button");
    btn.className = "sidebar-item" + (currentPath === c.path ? " active" : "");
    btn.innerHTML = \`
      <span class="path">\${escHtml(c.path)}</span>
      <span class="count">\${c.config.questions.length}Q</span>
    \`;
    btn.onclick = () => { currentPath = c.path; renderSidebar(); renderEditor(c); };
    list.appendChild(btn);
  });
}

// ─── EMPTY STATE ───────────────────────────────────────────────────────────────
function showEmpty() {
  document.getElementById("main-content").innerHTML = \`
    <div class="empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"/></svg>
      <h2>Aucun diagnostic selectionne</h2>
      <p>Selectionnez un diagnostic ou creez-en un nouveau.</p>
    </div>
  \`;
}

// ─── NEW CONFIG ────────────────────────────────────────────────────────────────
function newConfig() {
  const config = {
    questions: [
      {
        question: "Votre premiere question ?",
        options: [
          { label: "Option A", score: 1, emoji: "\\uD83D\\uDCA1" },
          { label: "Option B", score: 2, emoji: "\\u2B50" },
          { label: "Option C", score: 3, emoji: "\\uD83D\\uDE80" },
        ],
      },
    ],
    results: [
      { maxScore: 4, tag: "Debutant", tagBg: "#FAEEDA", tagColor: "#854F0B", title: "Titre du resultat", desc: "Description", reco: "Recommandation" },
      { maxScore: 12, tag: "Avance", tagBg: "#DCFCE7", tagColor: "#14532D", title: "Titre avance", desc: "Description avancee", reco: "Recommandation avancee" },
    ],
    cta: { label: "Reserver un appel", url: "https://calendly.com/nocodefactory", sub: "30 min - Sans engagement" },
  };
  currentPath = "__new__";
  renderEditor({ path: "", config }, true);
  renderSidebar();
}

// ─── RENDER EDITOR ─────────────────────────────────────────────────────────────
function renderEditor(entry, isNew = false) {
  const main = document.getElementById("main-content");
  const cfg = JSON.parse(JSON.stringify(entry.config)); // deep clone

  main.innerHTML = \`
    <div class="header-actions">
      <div class="page-title">\${isNew ? "Nouveau diagnostic" : escHtml(entry.path)}</div>
      <button class="btn btn-primary" id="btn-save">Sauvegarder</button>
      \${!isNew ? '<button class="btn btn-danger" id="btn-delete">Supprimer</button>' : ''}
    </div>

    <div class="tabs">
      <button class="tab active" data-tab="edit">Editeur</button>
      <button class="tab" data-tab="preview">Apercu</button>
      <button class="tab" data-tab="json">JSON</button>
    </div>

    <div class="tab-content active" id="tab-edit">
      <div class="section">
        <div class="section-title">Chemin URL</div>
        <div class="form-group" style="margin-top:12px;margin-bottom:0">
          <input type="text" class="form-input" id="cfg-path" value="\${escAttr(entry.path)}" placeholder="/blog/mon-article" \${!isNew ? '' : ''}>
          <div style="font-size:12px;color:var(--text3);margin-top:4px">Pathname de l'article (ex: /blog/ia-entreprise)</div>
        </div>
      </div>

      <div class="section" id="questions-section">
        <div class="section-header">
          <div class="section-title">Questions <span class="badge" id="q-count">\${cfg.questions.length}</span></div>
          <button class="btn btn-secondary btn-sm" id="btn-add-q">+ Question</button>
        </div>
        <div id="questions-list"></div>
      </div>

      <div class="section" id="results-section">
        <div class="section-header">
          <div class="section-title">Resultats <span class="badge" id="r-count">\${cfg.results.length}</span></div>
          <button class="btn btn-secondary btn-sm" id="btn-add-r">+ Resultat</button>
        </div>
        <div id="results-list"></div>
      </div>

      <div class="section">
        <div class="section-title" style="margin-bottom:12px">CTA (Call to Action)</div>
        <div class="form-group">
          <label class="form-label">Label du bouton</label>
          <input type="text" class="form-input" id="cta-label" value="\${escAttr(cfg.cta.label)}">
        </div>
        <div class="form-group">
          <label class="form-label">URL (Calendly)</label>
          <input type="text" class="form-input" id="cta-url" value="\${escAttr(cfg.cta.url)}">
        </div>
        <div class="form-group" style="margin-bottom:0">
          <label class="form-label">Texte de reassurance</label>
          <input type="text" class="form-input" id="cta-sub" value="\${escAttr(cfg.cta.sub)}">
        </div>
      </div>
    </div>

    <div class="tab-content" id="tab-preview">
      <div class="preview-wrap">
        <div class="ncf-diagnostic" id="preview-container"></div>
      </div>
    </div>

    <div class="tab-content" id="tab-json">
      <div class="section">
        <textarea class="form-textarea" id="json-editor" style="min-height:400px;font-family:monospace;font-size:13px"></textarea>
        <button class="btn btn-secondary btn-sm" style="margin-top:8px" id="btn-import-json">Importer le JSON</button>
      </div>
    </div>
  \`;

  // ─── Tab switching ───
  main.querySelectorAll(".tab").forEach(tab => {
    tab.addEventListener("click", () => {
      main.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
      main.querySelectorAll(".tab-content").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById("tab-" + tab.dataset.tab).classList.add("active");
      if (tab.dataset.tab === "preview") renderPreview(gatherConfig());
      if (tab.dataset.tab === "json") document.getElementById("json-editor").value = JSON.stringify(gatherConfig(), null, 2);
    });
  });

  // ─── Render questions ───
  function renderQuestions() {
    const list = document.getElementById("questions-list");
    list.innerHTML = "";
    cfg.questions.forEach((q, qi) => {
      const card = document.createElement("div");
      card.className = "q-card";
      let optsHtml = "";
      q.options.forEach((o, oi) => {
        optsHtml += \`
          <div class="opt-row" data-qi="\${qi}" data-oi="\${oi}">
            <input type="text" class="form-input form-input-sm opt-emoji" value="\${escAttr(o.emoji)}" data-field="emoji" title="Emoji">
            <input type="text" class="form-input form-input-sm opt-label" value="\${escAttr(o.label)}" data-field="label" placeholder="Label">
            <input type="number" class="form-input form-input-sm opt-score" value="\${o.score}" data-field="score" min="1" max="10" title="Score">
            <button class="btn-icon danger" title="Supprimer" onclick="removeOption(\${qi},\${oi})">\\u2715</button>
          </div>
        \`;
      });
      card.innerHTML = \`
        <div class="q-card-header">
          <div class="q-num">\${qi + 1}</div>
          <input type="text" class="form-input form-input-sm" value="\${escAttr(q.question)}" data-qi="\${qi}" data-field="question" style="flex:1">
          <div class="q-card-actions">
            \${qi > 0 ? '<button class="btn-icon" title="Monter" onclick="moveQuestion(' + qi + ',-1)">\\u2191</button>' : ''}
            \${qi < cfg.questions.length - 1 ? '<button class="btn-icon" title="Descendre" onclick="moveQuestion(' + qi + ',1)">\\u2193</button>' : ''}
            <button class="btn-icon danger" title="Supprimer" onclick="removeQuestion(\${qi})">\\u2715</button>
          </div>
        </div>
        <div class="form-label">Options (emoji, label, score)</div>
        \${optsHtml}
        <button class="btn btn-secondary btn-sm" onclick="addOption(\${qi})" style="margin-top:4px">+ Option</button>
      \`;
      list.appendChild(card);
    });
    document.getElementById("q-count").textContent = cfg.questions.length;

    // bind inputs
    list.querySelectorAll("[data-field='question']").forEach(input => {
      input.addEventListener("input", () => { cfg.questions[+input.dataset.qi].question = input.value; });
    });
    list.querySelectorAll(".opt-row input").forEach(input => {
      input.addEventListener("input", () => {
        const row = input.closest(".opt-row");
        const qi = +row.dataset.qi, oi = +row.dataset.oi, field = input.dataset.field;
        const val = field === "score" ? (+input.value || 1) : input.value;
        cfg.questions[qi].options[oi][field] = val;
      });
    });
  }

  // ─── Render results ───
  function renderResults() {
    const list = document.getElementById("results-list");
    list.innerHTML = "";
    cfg.results.forEach((r, ri) => {
      const card = document.createElement("div");
      card.className = "r-card";
      card.innerHTML = \`
        <div class="r-card-header">
          <span class="r-tag-preview" style="background:\${escAttr(r.tagBg)};color:\${escAttr(r.tagColor)}">\${escHtml(r.tag)}</span>
          <span style="font-size:12px;color:var(--text3);margin-left:auto">maxScore \\u2264</span>
          <input type="number" class="form-input form-input-sm" value="\${r.maxScore}" data-ri="\${ri}" data-field="maxScore" style="width:60px" min="1">
          <button class="btn-icon danger" title="Supprimer" onclick="removeResult(\${ri})">\\u2715</button>
        </div>
        <div class="form-row" style="margin-bottom:8px">
          <div>
            <label class="form-label">Tag</label>
            <input type="text" class="form-input form-input-sm" value="\${escAttr(r.tag)}" data-ri="\${ri}" data-field="tag">
          </div>
          <div>
            <label class="form-label">Couleurs tag</label>
            <div class="color-row">
              <input type="color" class="color-input" value="\${r.tagBg}" data-ri="\${ri}" data-field="tagBg" title="Fond">
              <input type="color" class="color-input" value="\${r.tagColor}" data-ri="\${ri}" data-field="tagColor" title="Texte">
            </div>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Titre</label>
          <input type="text" class="form-input form-input-sm" value="\${escAttr(r.title)}" data-ri="\${ri}" data-field="title">
        </div>
        <div class="form-group">
          <label class="form-label">Description</label>
          <textarea class="form-textarea form-input-sm" data-ri="\${ri}" data-field="desc" rows="2">\${escHtml(r.desc)}</textarea>
        </div>
        <div class="form-group" style="margin-bottom:0">
          <label class="form-label">Recommandation</label>
          <textarea class="form-textarea form-input-sm" data-ri="\${ri}" data-field="reco" rows="2">\${escHtml(r.reco)}</textarea>
        </div>
      \`;
      list.appendChild(card);
    });
    document.getElementById("r-count").textContent = cfg.results.length;

    // bind inputs
    list.querySelectorAll("input,textarea").forEach(input => {
      input.addEventListener("input", () => {
        const ri = +input.dataset.ri, field = input.dataset.field;
        if (!field) return;
        const val = field === "maxScore" ? (+input.value || 1) : input.value;
        cfg.results[ri][field] = val;
        if (field === "tag" || field === "tagBg" || field === "tagColor") {
          const preview = input.closest(".r-card").querySelector(".r-tag-preview");
          preview.textContent = cfg.results[ri].tag;
          preview.style.background = cfg.results[ri].tagBg;
          preview.style.color = cfg.results[ri].tagColor;
        }
      });
    });
  }

  renderQuestions();
  renderResults();

  // ─── Actions ───
  window.addOption = (qi) => {
    cfg.questions[qi].options.push({ label: "Nouvelle option", score: 1, emoji: "\\u2B50" });
    renderQuestions();
  };
  window.removeOption = (qi, oi) => {
    if (cfg.questions[qi].options.length <= 2) { toast("Minimum 2 options", true); return; }
    cfg.questions[qi].options.splice(oi, 1);
    renderQuestions();
  };
  window.removeQuestion = (qi) => {
    if (cfg.questions.length <= 1) { toast("Minimum 1 question", true); return; }
    cfg.questions.splice(qi, 1);
    renderQuestions();
  };
  window.moveQuestion = (qi, dir) => {
    const ni = qi + dir;
    [cfg.questions[qi], cfg.questions[ni]] = [cfg.questions[ni], cfg.questions[qi]];
    renderQuestions();
  };
  window.removeResult = (ri) => {
    if (cfg.results.length <= 1) { toast("Minimum 1 resultat", true); return; }
    cfg.results.splice(ri, 1);
    renderResults();
  };

  document.getElementById("btn-add-q").addEventListener("click", () => {
    cfg.questions.push({
      question: "Nouvelle question ?",
      options: [
        { label: "Option A", score: 1, emoji: "\\uD83D\\uDCA1" },
        { label: "Option B", score: 2, emoji: "\\u2B50" },
        { label: "Option C", score: 3, emoji: "\\uD83D\\uDE80" },
      ],
    });
    renderQuestions();
  });

  document.getElementById("btn-add-r").addEventListener("click", () => {
    cfg.results.push({
      maxScore: 10, tag: "Nouveau", tagBg: "#E0F2FE", tagColor: "#0C4A6E",
      title: "Titre", desc: "Description", reco: "Recommandation",
    });
    renderResults();
  });

  // ─── Gather config from form ───
  function gatherConfig() {
    return {
      questions: cfg.questions,
      results: cfg.results.map(r => ({...r, maxScore: +r.maxScore})),
      cta: {
        label: document.getElementById("cta-label").value,
        url: document.getElementById("cta-url").value,
        sub: document.getElementById("cta-sub").value,
      },
    };
  }

  // ─── Save ───
  document.getElementById("btn-save").addEventListener("click", async () => {
    const path = document.getElementById("cfg-path").value.trim();
    if (!path || !path.startsWith("/")) { toast("Le chemin doit commencer par /", true); return; }
    const finalConfig = gatherConfig();
    if (finalConfig.questions.length === 0) { toast("Au moins 1 question requise", true); return; }
    const ok = await saveConfig(path, finalConfig);
    if (ok) {
      currentPath = path;
      renderSidebar();
    }
  });

  // ─── Delete ───
  if (!isNew) {
    document.getElementById("btn-delete")?.addEventListener("click", () => deleteConfig(entry.path));
  }

  // ─── Import JSON ───
  document.getElementById("btn-import-json")?.addEventListener("click", () => {
    try {
      const parsed = JSON.parse(document.getElementById("json-editor").value);
      if (!parsed.questions || !parsed.results || !parsed.cta) throw new Error("Structure invalide");
      Object.assign(cfg, parsed);
      renderQuestions();
      renderResults();
      document.getElementById("cta-label").value = cfg.cta.label;
      document.getElementById("cta-url").value = cfg.cta.url;
      document.getElementById("cta-sub").value = cfg.cta.sub;
      toast("JSON importe !");
      // switch to edit tab
      main.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
      main.querySelectorAll(".tab-content").forEach(t => t.classList.remove("active"));
      main.querySelector('[data-tab="edit"]').classList.add("active");
      document.getElementById("tab-edit").classList.add("active");
    } catch (e) {
      toast("JSON invalide: " + e.message, true);
    }
  });
}

// ─── PREVIEW ───────────────────────────────────────────────────────────────────
function renderPreview(config) {
  const container = document.getElementById("preview-container");
  if (!container) return;
  // Inject diagnostic styles if not present
  if (!document.getElementById("ncf-diagnostic-styles")) {
    const s = document.createElement("style");
    s.id = "ncf-diagnostic-styles";
    s.textContent =
      ".ncf-wrap{max-width:520px;margin:32px auto;background:#fff;border-radius:16px;box-shadow:0 1px 2px rgba(0,0,0,.04),0 6px 24px rgba(0,0,0,.06);border:1px solid rgba(0,0,0,.06);overflow:hidden;font-family:inherit;position:relative}" +
      ".ncf-bar{height:4px;background:linear-gradient(90deg,#E94235,#F28B30,#FBBC04,#34A853,#4ECDC4,#7B68EE,#C084FC,#E091B5,#6BCFA8,#4DD0C8);background-size:520px 4px;transition:width .7s cubic-bezier(.34,1.56,.64,1)}" +
      ".ncf-inner{padding:28px 24px 24px}" +
      ".ncf-step{font-size:13px;color:#888;margin-bottom:6px;transition:opacity .3s,transform .3s}" +
      ".ncf-q{font-size:18px;font-weight:600;line-height:1.4;color:#1a1a1a;margin-bottom:20px;transition:opacity .3s,transform .3s}" +
      ".ncf-opts{display:flex;flex-direction:column;gap:10px}" +
      ".ncf-opt{display:flex;align-items:center;gap:12px;padding:14px 16px;border:1.5px solid rgba(0,0,0,.1);border-radius:12px;cursor:pointer;font-size:15px;line-height:1.4;color:#1a1a1a;background:#fff;transition:border-color .2s,background .2s,transform .15s,opacity .35s cubic-bezier(.16,1,.3,1);opacity:0;transform:translateY(8px) scale(.97)}" +
      ".ncf-opt:hover{border-color:#7B68EE;background:rgba(123,104,238,.04)}" +
      ".ncf-opt.ncf-visible{opacity:1;transform:translateY(0) scale(1)}" +
      ".ncf-opt.ncf-selected{border-color:#7B68EE;background:rgba(123,104,238,.06);transform:scale(.985)}" +
      ".ncf-opt.ncf-fading{opacity:0;transform:translateY(-4px);pointer-events:none}" +
      ".ncf-opt-emoji{font-size:20px;flex-shrink:0}" +
      ".ncf-opt-label{flex:1}" +
      ".ncf-exit .ncf-q,.ncf-exit .ncf-step{opacity:0;transform:translateY(-6px)}" +
      ".ncf-result{text-align:center;opacity:0;animation:ncfFadeUp .5s cubic-bezier(.16,1,.3,1) forwards}" +
      "@keyframes ncfFadeUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}" +
      ".ncf-circle-wrap{position:relative;width:112px;height:112px;margin:0 auto 16px}" +
      ".ncf-circle-bg{fill:none;stroke:rgba(0,0,0,.06);stroke-width:7}" +
      ".ncf-circle-fg{fill:none;stroke-width:7;stroke-linecap:round;transition:stroke-dashoffset 1.2s cubic-bezier(.22,1,.36,1) .2s}" +
      ".ncf-score-txt{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:700;color:#1a1a1a}" +
      ".ncf-tag{display:inline-block;padding:4px 14px;border-radius:99px;font-size:13px;font-weight:600;margin-bottom:12px}" +
      ".ncf-rtitle{font-size:20px;font-weight:700;color:#1a1a1a;margin-bottom:8px}" +
      ".ncf-rdesc{font-size:14px;color:#555;line-height:1.6;margin-bottom:20px}" +
      ".ncf-reco{background:#f8f8f8;border-radius:12px;padding:16px;margin-bottom:20px}" +
      ".ncf-reco-label{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#7B68EE;margin-bottom:6px}" +
      ".ncf-reco-text{font-size:14px;color:#333;line-height:1.5}" +
      ".ncf-cta{display:inline-block;padding:14px 32px;border-radius:12px;background:#7B68EE;color:#fff;font-size:16px;font-weight:600;text-decoration:none;transition:background .2s,transform .15s}" +
      ".ncf-cta:hover{background:#6a56e0;transform:translateY(-1px)}" +
      ".ncf-sub{font-size:13px;color:#888;margin-top:10px}" +
      ".ncf-reset{display:inline-block;margin-top:16px;font-size:13px;color:#888;cursor:pointer;background:none;border:none;font-family:inherit}" +
      ".ncf-reset:hover{color:#555}" +
      ".ncf-anim{opacity:0;animation:ncfFadeUp .5s cubic-bezier(.16,1,.3,1) forwards}";
    document.head.appendChild(s);
  }

  // Use the embedded diagnostic renderer
  ncfRenderPreview(container, config);
}

// ─── Embedded preview renderer (same logic as diagnostic JS) ─────────────────
function ncfRenderPreview(container, config) {
  const state = { step: 0, scores: [] };
  const total = config.questions.length;
  container.innerHTML = "";
  const wrap = mkEl("div", "ncf-wrap");
  const bar = mkEl("div", "ncf-bar");
  const inner = mkEl("div", "ncf-inner");
  wrap.appendChild(bar);
  wrap.appendChild(inner);
  container.appendChild(wrap);
  showQ();

  function showQ() {
    const q = config.questions[state.step];
    inner.innerHTML = "";
    bar.style.width = (state.step / total * 100) + "%";
    requestAnimationFrame(() => { bar.style.width = ((state.step + 1) / total * 100) + "%"; });
    const stepEl = mkEl("div", "ncf-step"); stepEl.textContent = "Question " + (state.step + 1) + "/" + total;
    inner.appendChild(stepEl);
    const qEl = mkEl("div", "ncf-q"); qEl.textContent = q.question;
    inner.appendChild(qEl);
    const optsWrap = mkEl("div", "ncf-opts");
    const optEls = [];
    q.options.forEach((opt, i) => {
      const optEl = mkEl("div", "ncf-opt");
      const em = mkEl("span", "ncf-opt-emoji"); em.textContent = opt.emoji;
      const lb = mkEl("span", "ncf-opt-label"); lb.textContent = opt.label;
      optEl.appendChild(em); optEl.appendChild(lb);
      optsWrap.appendChild(optEl);
      optEls.push(optEl);
      const delay = 0.08 + i * 0.06;
      optEl.style.transitionDelay = delay + "s";
      setTimeout(() => optEl.classList.add("ncf-visible"), delay * 1000);
      optEl.addEventListener("click", () => {
        if (optEl.classList.contains("ncf-selected")) return;
        state.scores.push(opt.score);
        optEl.classList.add("ncf-selected");
        optEls.forEach((o, j) => {
          if (j !== i) { o.style.transitionDelay = Math.abs(j - i) * 0.04 + "s"; o.classList.add("ncf-fading"); }
        });
        inner.classList.add("ncf-exit");
        setTimeout(() => {
          inner.classList.remove("ncf-exit");
          state.step++;
          if (state.step < total) showQ(); else showR();
        }, 420);
      });
    });
    inner.appendChild(optsWrap);
  }

  function showR() {
    inner.innerHTML = "";
    bar.style.width = "100%";
    let totalScore = 0, maxP = 0;
    config.questions.forEach((q, i) => {
      totalScore += state.scores[i];
      let mx = 0; q.options.forEach(o => { if (o.score > mx) mx = o.score; }); maxP += mx;
    });
    const pct = Math.round((totalScore / maxP) * 100);
    let result = config.results[config.results.length - 1];
    for (let r = 0; r < config.results.length; r++) {
      if (totalScore <= config.results[r].maxScore) { result = config.results[r]; break; }
    }
    const rd = mkEl("div", "ncf-result");
    const R = 48, C = 2 * Math.PI * R;
    const cw = mkEl("div", "ncf-circle-wrap ncf-anim"); cw.style.animationDelay = "0.1s";
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("width", "112"); svg.setAttribute("height", "112"); svg.setAttribute("viewBox", "0 0 112 112");
    const bgC = document.createElementNS(svgNS, "circle");
    bgC.setAttribute("cx","56"); bgC.setAttribute("cy","56"); bgC.setAttribute("r",String(R)); bgC.setAttribute("class","ncf-circle-bg");
    const fgC = document.createElementNS(svgNS, "circle");
    fgC.setAttribute("cx","56"); fgC.setAttribute("cy","56"); fgC.setAttribute("r",String(R)); fgC.setAttribute("class","ncf-circle-fg");
    fgC.setAttribute("stroke", result.tagColor); fgC.setAttribute("stroke-dasharray", String(C));
    fgC.setAttribute("stroke-dashoffset", String(C)); fgC.setAttribute("transform", "rotate(-90 56 56)");
    svg.appendChild(bgC); svg.appendChild(fgC); cw.appendChild(svg);
    const st = mkEl("div", "ncf-score-txt"); st.textContent = "0%"; cw.appendChild(st); rd.appendChild(cw);
    const tag = mkEl("div", "ncf-tag ncf-anim"); tag.style.background = result.tagBg; tag.style.color = result.tagColor;
    tag.style.animationDelay = "0.2s"; tag.textContent = result.tag; rd.appendChild(tag);
    const ti = mkEl("div", "ncf-rtitle ncf-anim"); ti.style.animationDelay = "0.25s"; ti.textContent = result.title; rd.appendChild(ti);
    const de = mkEl("div", "ncf-rdesc ncf-anim"); de.style.animationDelay = "0.3s"; de.textContent = result.desc; rd.appendChild(de);
    const re = mkEl("div", "ncf-reco ncf-anim"); re.style.animationDelay = "0.35s";
    const rl = mkEl("div", "ncf-reco-label"); rl.textContent = "Notre recommandation";
    const rt = mkEl("div", "ncf-reco-text"); rt.textContent = result.reco;
    re.appendChild(rl); re.appendChild(rt); rd.appendChild(re);
    const ca = document.createElement("a"); ca.className = "ncf-cta ncf-anim"; ca.style.animationDelay = "0.45s";
    ca.href = "#"; ca.onclick = e => e.preventDefault(); ca.textContent = config.cta.label; rd.appendChild(ca);
    const su = mkEl("div", "ncf-sub ncf-anim"); su.style.animationDelay = "0.5s"; su.textContent = config.cta.sub; rd.appendChild(su);
    const rs = document.createElement("button"); rs.className = "ncf-reset ncf-anim"; rs.style.animationDelay = "0.6s";
    rs.textContent = "\\u2190 Recommencer";
    rs.addEventListener("click", () => { state.step = 0; state.scores = []; bar.style.width = "0%"; showQ(); });
    rd.appendChild(rs); inner.appendChild(rd);
    requestAnimationFrame(() => { fgC.setAttribute("stroke-dashoffset", String(C - (pct / 100) * C)); });
    const start = performance.now();
    function tick(now) {
      const t = Math.min((now - start) / 1000, 1);
      st.textContent = Math.round((1 - Math.pow(1 - t, 3)) * pct) + "%";
      if (t < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }
}

function mkEl(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }

// ─── UTILS ─────────────────────────────────────────────────────────────────────
function escHtml(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function escAttr(s) { return String(s).replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;"); }

function toast(msg, isError = false) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "toast visible" + (isError ? " error" : "");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { t.className = "toast"; }, 2500);
}

function copyScriptTag() {
  const url = window.location.origin + "/ncf-diagnostic.js";
  navigator.clipboard.writeText('<script src="' + url + '" defer><\\/script>').then(() => toast("Balise copiee !"));
}

// ─── INIT ──────────────────────────────────────────────────────────────────────
checkAuth();
</script>
</body>
</html>`;
