export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { telefone, site, tipo } = req.body;
  const APIFY = process.env.APIFY_TOKEN;

  // tipo: 'whatsapp' | 'site' | 'all'
  // 'whatsapp' — só valida WA (sem site necessário)
  // 'site'     — Lighthouse + Wappalyzer (precisa de site)
  // 'all'      — tudo junto

  const result = { whatsapp: null, lighthouse: null, wappalyzer: null };

  // ══════════════════════════════════════════
  // WHATSAPP
  // ══════════════════════════════════════════
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

  // ══════════════════════════════════════════
  // LIGHTHOUSE + WAPPALYZER (sob demanda)
  // Só roda se o lead tem site
  // ══════════════════════════════════════════
  if ((tipo === 'site' || tipo === 'all') && site) {
    const siteUrl = site.startsWith('http') ? site : `https://${site}`;

    // Dispara os dois actors em paralelo
    const [lighthouseRes, wappalyzerRes] = await Promise.allSettled([
      runLighthouse(siteUrl, APIFY),
      runWappalyzer(siteUrl, APIFY),
    ]);

    result.lighthouse  = lighthouseRes.status  === 'fulfilled' ? lighthouseRes.value  : { erro: lighthouseRes.reason?.message  || 'Falhou' };
    result.wappalyzer  = wappalyzerRes.status  === 'fulfilled' ? wappalyzerRes.value  : { erro: wappalyzerRes.reason?.message  || 'Falhou' };
  } else if ((tipo === 'site' || tipo === 'all') && !site) {
    result.lighthouse = { erro: 'Lead não possui site cadastrado' };
    result.wappalyzer = { erro: 'Lead não possui site cadastrado' };
  }

  return res.status(200).json(result);
}

// ══════════════════════════════════════════
// LIGHTHOUSE — audit de performance e SEO
// Actor: microworlds/lighthouse-audit
// Custo: ~$0.005 por audit (muito barato)
// ══════════════════════════════════════════
async function runLighthouse(url, APIFY) {
  // Dispara o run
  const runRes = await fetch(
    `https://api.apify.com/v2/acts/microworlds~lighthouse-audit/runs?token=${APIFY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        urls: [url],
        config: { settings: { emulatedFormFactor: 'mobile' } }
      })
    }
  );
  if (!runRes.ok) throw new Error(`Lighthouse run failed: ${runRes.status}`);
  const runData = await runRes.json();
  const runId   = runData.data?.id;
  const dsId    = runData.data?.defaultDatasetId;
  if (!runId) throw new Error('Lighthouse: runId não retornado');

  // Polling — timeout 90s
  const FAILED = ['FAILED', 'ABORTED', 'TIMED-OUT'];
  for (let i = 0; i < 18; i++) {
    await sleep(5000);
    const st = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY}`).then(r => r.json());
    const status = st?.data?.status;
    if (FAILED.includes(status)) throw new Error(`Lighthouse falhou: ${status}`);
    if (status === 'SUCCEEDED') {
      const items = await fetch(`https://api.apify.com/v2/datasets/${dsId}/items?token=${APIFY}&limit=1`).then(r => r.json());
      const item  = Array.isArray(items) ? items[0] : items;
      if (!item) throw new Error('Lighthouse: sem dados');

      // Extrai scores (0-100)
      const cats = item.categories || item.lhr?.categories || {};
      const score = key => {
        const cat = cats[key];
        if (!cat) return null;
        const v = cat.score ?? cat.value;
        return v !== null ? Math.round(v * 100) : null;
      };

      // Métricas de performance
      const audits = item.audits || item.lhr?.audits || {};
      const fcp = audits['first-contentful-paint']?.displayValue || null;
      const lcp = audits['largest-contentful-paint']?.displayValue || null;
      const tbt = audits['total-blocking-time']?.displayValue || null;
      const cls = audits['cumulative-layout-shift']?.displayValue || null;
      const ttfb = audits['server-response-time']?.displayValue || null;

      // SEO issues críticos
      const seoIssues = [];
      if (audits['meta-description']?.score === 0) seoIssues.push('Sem meta description');
      if (audits['document-title']?.score === 0) seoIssues.push('Sem title tag');
      if (audits['viewport']?.score === 0) seoIssues.push('Não otimizado para mobile');
      if (audits['robots-txt']?.score === 0) seoIssues.push('Sem robots.txt');
      if (audits['canonical']?.score === 0) seoIssues.push('Sem URL canônica');
      if (audits['image-alt']?.score === 0) seoIssues.push('Imagens sem alt text');

      return {
        url,
        scores: {
          performance:   score('performance'),
          seo:           score('seo'),
          acessibilidade:score('accessibility'),
          boasPraticas:  score('best-practices'),
        },
        metricas: { fcp, lcp, tbt, cls, ttfb },
        seoIssues,
        classificacao: classificarSite(score('performance'), score('seo')),
      };
    }
  }
  throw new Error('Lighthouse: timeout');
}

function classificarSite(perf, seo) {
  if (perf === null && seo === null) return null;
  const avg = ((perf || 0) + (seo || 0)) / 2;
  if (avg >= 80) return { label: 'Bom', cor: 'green' };
  if (avg >= 50) return { label: 'Regular', cor: 'orange' };
  return { label: 'Crítico', cor: 'red' };
}

// ══════════════════════════════════════════
// WAPPALYZER — detecta stack tecnológico
// Actor: scraping_samurai/techstack-wappalyzer-scraper
// Custo: ~$0.01-0.05 por URL
// ══════════════════════════════════════════
async function runWappalyzer(url, APIFY) {
  const runRes = await fetch(
    `https://api.apify.com/v2/acts/scraping_samurai~techstack-wappalyzer-scraper/runs?token=${APIFY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: [{ url }], maxRequestsPerCrawl: 1 })
    }
  );
  if (!runRes.ok) throw new Error(`Wappalyzer run failed: ${runRes.status}`);
  const runData = await runRes.json();
  const runId   = runData.data?.id;
  const dsId    = runData.data?.defaultDatasetId;
  if (!runId) throw new Error('Wappalyzer: runId não retornado');

  const FAILED = ['FAILED', 'ABORTED', 'TIMED-OUT'];
  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    const st = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY}`).then(r => r.json());
    const status = st?.data?.status;
    if (FAILED.includes(status)) throw new Error(`Wappalyzer falhou: ${status}`);
    if (status === 'SUCCEEDED') {
      const items = await fetch(`https://api.apify.com/v2/datasets/${dsId}/items?token=${APIFY}&limit=1`).then(r => r.json());
      const item  = Array.isArray(items) ? items[0] : items;
      if (!item) throw new Error('Wappalyzer: sem dados');

      const techs = item.technologies || item.tech || [];

      // Agrupa por categoria com foco em dados relevantes para prospecção
      const grupos = {
        cms:        [],
        analytics:  [],
        marketing:  [],
        ecommerce:  [],
        hosting:    [],
        framework:  [],
        outros:     [],
      };

      const categoriaMap = {
        'CMS': 'cms', 'Blog': 'cms',
        'Analytics': 'analytics', 'Tag managers': 'analytics',
        'Marketing automation': 'marketing', 'Email': 'marketing', 'Advertising': 'marketing',
        'Ecommerce': 'ecommerce', 'Payment processors': 'ecommerce',
        'Web servers': 'hosting', 'CDN': 'hosting', 'Hosting': 'hosting',
        'JavaScript frameworks': 'framework', 'Web frameworks': 'framework', 'UI frameworks': 'framework',
      };

      techs.forEach(t => {
        const nome = t.name || t.technology || '';
        const cats = t.categories || [];
        let grupo = 'outros';
        for (const cat of cats) {
          const catNome = typeof cat === 'string' ? cat : cat.name || '';
          if (categoriaMap[catNome]) { grupo = categoriaMap[catNome]; break; }
        }
        if (nome && !grupos[grupo].includes(nome)) grupos[grupo].push(nome);
      });

      // Flags relevantes para diagnóstico
      const temPixelFacebook = techs.some(t => (t.name || '').toLowerCase().includes('facebook pixel') || (t.name || '').toLowerCase().includes('meta pixel'));
      const temGoogleAnalytics = techs.some(t => (t.name || '').toLowerCase().includes('google analytics') || (t.name || '').toLowerCase().includes('ga4'));
      const temGoogleAds = techs.some(t => (t.name || '').toLowerCase().includes('google ads') || (t.name || '').toLowerCase().includes('google tag'));
      const temChatbot = techs.some(t => ['Tidio', 'Intercom', 'Zendesk', 'JivoChat', 'LiveChat'].some(c => (t.name || '').includes(c)));
      const temWordPress = grupos.cms.some(c => c.toLowerCase().includes('wordpress'));
      const temWix = grupos.cms.some(c => c.toLowerCase().includes('wix'));
      const temShopify = grupos.ecommerce.some(c => c.toLowerCase().includes('shopify'));

      // Diagnóstico gerado aqui — sinal direto para a IA
      const diagnosticoTech = [];
      if (!temPixelFacebook) diagnosticoTech.push('Sem Pixel do Facebook — não consegue fazer remarketing');
      if (!temGoogleAnalytics) diagnosticoTech.push('Sem Google Analytics — tráfego não é mensurado');
      if (!temGoogleAds) diagnosticoTech.push('Sem tag de conversão do Google Ads');
      if (temWix) diagnosticoTech.push('Site em Wix — limitações técnicas de SEO');
      if (temChatbot) diagnosticoTech.push('Tem chatbot ativo');

      return {
        url,
        tecnologias: grupos,
        flags: { temPixelFacebook, temGoogleAnalytics, temGoogleAds, temChatbot, temWordPress, temWix, temShopify },
        diagnosticoTech,
        totalDetectadas: techs.length,
      };
    }
  }
  throw new Error('Wappalyzer: timeout');
}

// ── HELPERS ──────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function normalizarTelefone(telefone) {
  const digits = (telefone || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('55') && digits.length >= 12) return digits;
  if (digits.length === 11 || digits.length === 10) return '55' + digits;
  return null;
}

function formatarTelefone(phoneInt) {
  const d = phoneInt.replace(/\D/g, '');
  if (d.startsWith('55') && d.length === 13) return `+55 (${d.slice(2,4)}) ${d.slice(4,9)}-${d.slice(9)}`;
  if (d.startsWith('55') && d.length === 12) return `+55 (${d.slice(2,4)}) ${d.slice(4,8)}-${d.slice(8)}`;
  return phoneInt;
}
