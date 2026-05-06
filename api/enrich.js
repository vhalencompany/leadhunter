export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { telefone, site, tipo } = req.body;
  const APIFY = process.env.APIFY_TOKEN;

  const result = { whatsapp: null, lighthouse: null, wappalyzer: null };

  // ── WHATSAPP ──────────────────────────────────────────────────────────────
  if (tipo === 'whatsapp' || tipo === 'all') {
    if (!telefone) {
      result.whatsapp = { ativo: null, erro: 'Número não informado' };
    } else {
      try {
        const phoneInt = normalizarTelefone(telefone);
        if (!phoneInt) {
          result.whatsapp = { ativo: null, erro: 'Número inválido' };
        } else {
          const waRes = await fetch(`https://wa.me/${phoneInt}`, {
            method: 'HEAD', redirect: 'follow',
            headers: { 'User-Agent': 'Mozilla/5.0' }
          });
          const hasWA = waRes.status === 200 || waRes.status === 301 || waRes.status === 302;
          result.whatsapp = { numero: phoneInt, ativo: hasWA, formatado: formatarTelefone(phoneInt) };
        }
      } catch (e) {
        result.whatsapp = { ativo: null, erro: 'Não foi possível validar' };
      }
    }
  }

  // ── SITE: Lighthouse + Wappalyzer ────────────────────────────────────────
  if ((tipo === 'site' || tipo === 'all') && site) {
    const siteUrl = site.startsWith('http') ? site : `https://${site}`;
    const [lhRes, wapRes] = await Promise.allSettled([
      runLighthouse(siteUrl, APIFY),
      runWappalyzer(siteUrl, APIFY),
    ]);
    result.lighthouse = lhRes.status === 'fulfilled' ? lhRes.value : { erro: lhRes.reason?.message || 'Falhou' };
    result.wappalyzer = wapRes.status === 'fulfilled' ? wapRes.value : { erro: wapRes.reason?.message || 'Falhou' };
  } else if ((tipo === 'site' || tipo === 'all') && !site) {
    result.lighthouse = { erro: 'Lead não possui site cadastrado' };
    result.wappalyzer = { erro: 'Lead não possui site cadastrado' };
  }

  return res.status(200).json(result);
}

// ── LIGHTHOUSE ───────────────────────────────────────────────────────────────
// Actor: microworlds~lighthouse-audit (confirmado, >99% success rate)
async function runLighthouse(url, APIFY) {
  const runRes = await fetch(
    `https://api.apify.com/v2/acts/microworlds~lighthouse-audit/runs?token=${APIFY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        startUrls: [{ url }],
        emulatedFormFactor: 'mobile',
        onlyCategories: ['performance', 'seo', 'accessibility', 'best-practices'],
      })
    }
  );
  if (!runRes.ok) {
    const txt = await runRes.text();
    throw new Error(`Lighthouse error ${runRes.status}: ${txt.slice(0, 200)}`);
  }
  const runData = await runRes.json();
  const runId = runData.data?.id;
  const dsId  = runData.data?.defaultDatasetId;
  if (!runId) throw new Error('Lighthouse: runId não retornado');

  const FAILED = ['FAILED', 'ABORTED', 'TIMED-OUT'];
  for (let i = 0; i < 20; i++) {
    await sleep(5000);
    const st = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY}`).then(r => r.json());
    const status = st?.data?.status;
    if (FAILED.includes(status)) throw new Error(`Lighthouse falhou: ${status}`);
    if (status === 'SUCCEEDED') {
      const raw = await fetch(`https://api.apify.com/v2/datasets/${dsId}/items?token=${APIFY}&limit=1`).then(r => r.json());
      const item = Array.isArray(raw) ? raw[0] : raw;
      if (!item) throw new Error('Lighthouse: sem dados retornados');
      return parseLighthouseResult(item, url);
    }
  }
  throw new Error('Lighthouse: timeout após 100s');
}

function parseLighthouseResult(item, url) {
  // Suporta múltiplos formatos de output do actor
  const cats = item.categories || item.lhr?.categories || item.result?.categories || {};
  const audits = item.audits || item.lhr?.audits || item.result?.audits || {};

  const score = key => {
    const cat = cats[key];
    if (!cat) return null;
    const v = cat.score ?? cat.value;
    return v !== null && v !== undefined ? Math.round(Number(v) * 100) : null;
  };

  const metric = key => audits[key]?.displayValue || null;

  const seoIssues = [];
  if (audits['meta-description']?.score === 0) seoIssues.push('Sem meta description');
  if (audits['document-title']?.score === 0) seoIssues.push('Sem title tag');
  if (audits['viewport']?.score === 0) seoIssues.push('Não otimizado para mobile');
  if (audits['robots-txt']?.score === 0) seoIssues.push('Sem robots.txt');
  if (audits['image-alt']?.score === 0) seoIssues.push('Imagens sem texto alternativo');
  if (audits['link-text']?.score === 0) seoIssues.push('Links sem texto descritivo');

  const perf = score('performance');
  const seo  = score('seo');
  const avg  = perf !== null && seo !== null ? (perf + seo) / 2 : null;
  const classificacao = avg === null ? null
    : avg >= 80 ? { label: 'Bom', cor: 'green' }
    : avg >= 50 ? { label: 'Regular', cor: 'orange' }
    : { label: 'Crítico', cor: 'red' };

  return {
    url,
    scores: {
      performance:    perf,
      seo:            seo,
      acessibilidade: score('accessibility'),
      boasPraticas:   score('best-practices'),
    },
    metricas: {
      fcp:  metric('first-contentful-paint'),
      lcp:  metric('largest-contentful-paint'),
      tbt:  metric('total-blocking-time'),
      cls:  metric('cumulative-layout-shift'),
      ttfb: metric('server-response-time'),
    },
    seoIssues,
    classificacao,
  };
}

// ── WAPPALYZER ───────────────────────────────────────────────────────────────
// Actor: scraping_samurai~techstack-wappalyzer-scraper
// Input correto: array de objetos { url }
async function runWappalyzer(url, APIFY) {
  const runRes = await fetch(
    `https://api.apify.com/v2/acts/scraping_samurai~techstack-wappalyzer-scraper/runs?token=${APIFY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        urls: [{ url }],
        maxRequestsPerCrawl: 1,
      })
    }
  );
  if (!runRes.ok) {
    const txt = await runRes.text();
    throw new Error(`Wappalyzer error ${runRes.status}: ${txt.slice(0, 200)}`);
  }
  const runData = await runRes.json();
  const runId = runData.data?.id;
  const dsId  = runData.data?.defaultDatasetId;
  if (!runId) throw new Error('Wappalyzer: runId não retornado');

  const FAILED = ['FAILED', 'ABORTED', 'TIMED-OUT'];
  for (let i = 0; i < 14; i++) {
    await sleep(5000);
    const st = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY}`).then(r => r.json());
    const status = st?.data?.status;
    if (FAILED.includes(status)) throw new Error(`Wappalyzer falhou: ${status}`);
    if (status === 'SUCCEEDED') {
      const raw = await fetch(`https://api.apify.com/v2/datasets/${dsId}/items?token=${APIFY}&limit=1`).then(r => r.json());
      const item = Array.isArray(raw) ? raw[0] : raw;
      if (!item) throw new Error('Wappalyzer: sem dados retornados');
      return parseWappalyzerResult(item, url);
    }
  }
  throw new Error('Wappalyzer: timeout após 70s');
}

function parseWappalyzerResult(item, url) {
  // Suporta múltiplos formatos de saída
  const techs = item.technologies || item.tech || item.techStack || [];

  const categoriaMap = {
    'CMS': 'cms', 'Blog': 'cms',
    'Analytics': 'analytics', 'Tag managers': 'analytics',
    'Marketing automation': 'marketing', 'Advertising': 'marketing', 'Email': 'marketing',
    'Ecommerce': 'ecommerce', 'Payment processors': 'ecommerce',
    'Web servers': 'hosting', 'CDN': 'hosting', 'Hosting': 'hosting',
    'JavaScript frameworks': 'framework', 'Web frameworks': 'framework',
  };

  const grupos = { cms: [], analytics: [], marketing: [], ecommerce: [], hosting: [], framework: [] };

  techs.forEach(t => {
    const nome = t.name || t.technology || '';
    const cats = t.categories || [];
    let grupo = null;
    for (const cat of cats) {
      const catNome = typeof cat === 'string' ? cat : cat.name || '';
      if (categoriaMap[catNome]) { grupo = categoriaMap[catNome]; break; }
    }
    if (nome && grupo && !grupos[grupo].includes(nome)) grupos[grupo].push(nome);
  });

  const hasName = n => techs.some(t => (t.name || '').toLowerCase().includes(n.toLowerCase()));

  const flags = {
    temPixelFacebook:  hasName('Facebook Pixel') || hasName('Meta Pixel'),
    temGoogleAnalytics:hasName('Google Analytics') || hasName('GA4'),
    temGoogleAds:      hasName('Google Ads') || hasName('Google Tag'),
    temChatbot:        ['Tidio','Intercom','JivoChat','LiveChat','Zendesk','Tawk'].some(c => hasName(c)),
    temWordPress:      hasName('WordPress'),
    temWix:            hasName('Wix'),
    temShopify:        hasName('Shopify'),
  };

  const diagnosticoTech = [];
  if (!flags.temPixelFacebook)   diagnosticoTech.push('Sem Pixel do Facebook — remarketing impossível');
  if (!flags.temGoogleAnalytics) diagnosticoTech.push('Sem Google Analytics — tráfego não mensurado');
  if (!flags.temGoogleAds)       diagnosticoTech.push('Sem tag de conversão do Google Ads');
  if (flags.temWix)              diagnosticoTech.push('Site em Wix — limitações de SEO técnico');

  return { url, tecnologias: grupos, flags, diagnosticoTech, totalDetectadas: techs.length };
}

// ── HELPERS ──────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function normalizarTelefone(tel) {
  const d = (tel || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('55') && d.length >= 12) return d;
  if (d.length === 11 || d.length === 10) return '55' + d;
  return null;
}

function formatarTelefone(p) {
  const d = p.replace(/\D/g, '');
  if (d.startsWith('55') && d.length === 13) return `+55 (${d.slice(2,4)}) ${d.slice(4,9)}-${d.slice(9)}`;
  if (d.startsWith('55') && d.length === 12) return `+55 (${d.slice(2,4)}) ${d.slice(4,8)}-${d.slice(8)}`;
  return p;
}
