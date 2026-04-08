export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { niche, city, qty, source = 'google' } = req.body;
  const APIFY = process.env.APIFY_TOKEN;
  if (!APIFY) return res.status(500).json({ error: 'Token não configurado.' });

  try {
    // ─── GOOGLE MAPS ─────────────────────────────────────────────────────────
    if (source === 'google') {
      const runRes = await fetch(
        `https://api.apify.com/v2/acts/compass~crawler-google-places/runs?token=${APIFY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            searchStringsArray: [niche],
            locationQuery: `${city}, Brasil`,
            maxCrawledPlacesPerSearch: parseInt(qty),
            language: 'pt-BR',
            maxImages: 0, maxReviews: 0,
            includeWebResults: false, scrapeContacts: false,
            scrapeDirectories: false, skipClosedPlaces: false,
            searchMatching: 'all', website: 'allPlaces',
            maxQuestions: 0, reviewsSort: 'newest',
            reviewsOrigin: 'all', allPlacesNoSearchAction: ''
          })
        }
      );
      if (!runRes.ok) {
        const errText = await runRes.text();
        throw new Error(`Apify error ${runRes.status}: ${errText}`);
      }
      const runData = await runRes.json();
      const { id: runId, defaultDatasetId: datasetId } = runData.data;
      return res.status(200).json({ runId, datasetId, source: 'google' });
    }

    // ─── INSTAGRAM ───────────────────────────────────────────────────────────
    if (source === 'instagram') {
      // Gera hashtags relevantes a partir do nicho e cidade
      const nicheSlug = niche.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
        .replace(/\s+/g, '');
      const citySlug = city.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, '');

      const hashtags = [
        `${nicheSlug}${citySlug}`,
        `${nicheSlug}`,
        `${nicheSlug}brasil`,
        `${citySlug}`,
      ];

      const runRes = await fetch(
        `https://api.apify.com/v2/acts/apify~instagram-scraper/runs?token=${APIFY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            directUrls: hashtags.map(h => `https://www.instagram.com/explore/tags/${h}/`),
            resultsType: 'posts',
            resultsLimit: parseInt(qty) * 3, // busca mais posts para filtrar perfis únicos
            addParentData: true,
            searchType: 'hashtag',
            searchLimit: Math.ceil(parseInt(qty) / hashtags.length)
          })
        }
      );
      if (!runRes.ok) {
        const errText = await runRes.text();
        throw new Error(`Apify Instagram error ${runRes.status}: ${errText}`);
      }
      const runData = await runRes.json();
      const { id: runId, defaultDatasetId: datasetId } = runData.data;
      return res.status(200).json({ runId, datasetId, source: 'instagram' });
    }

    return res.status(400).json({ error: 'Source inválido. Use "google" ou "instagram".' });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
