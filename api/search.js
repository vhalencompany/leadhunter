export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { niche, city, qty } = req.body;
  const APIFY = process.env.APIFY_TOKEN;
  if (!APIFY) return res.status(500).json({ error: 'Token não configurado.' });

  const IG_FIXED_QTY = 10; // Instagram fixo em 10 durante validação

  try {
    // ─── GOOGLE MAPS ─────────────────────────────────────────────────────────
    const googlePromise = fetch(
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

    // ─── INSTAGRAM ───────────────────────────────────────────────────────────
    const nicheSlug = niche.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
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

    const instagramPromise = fetch(
      `https://api.apify.com/v2/acts/apify~instagram-scraper/runs?token=${APIFY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          directUrls: hashtags.map(h => `https://www.instagram.com/explore/tags/${h}/`),
          resultsType: 'posts',
          resultsLimit: IG_FIXED_QTY * 3,
          addParentData: true,
          searchType: 'hashtag',
          searchLimit: Math.ceil(IG_FIXED_QTY / hashtags.length)
        })
      }
    );

    // ─── DISPARA EM PARALELO ─────────────────────────────────────────────────
    const [googleRes, instagramRes] = await Promise.all([googlePromise, instagramPromise]);

    if (!googleRes.ok) {
      const errText = await googleRes.text();
      throw new Error(`Apify Google error ${googleRes.status}: ${errText}`);
    }
    if (!instagramRes.ok) {
      const errText = await instagramRes.text();
      throw new Error(`Apify Instagram error ${instagramRes.status}: ${errText}`);
    }

    const [googleData, instagramData] = await Promise.all([
      googleRes.json(),
      instagramRes.json()
    ]);

    return res.status(200).json({
      google: {
        runId: googleData.data.id,
        datasetId: googleData.data.defaultDatasetId
      },
      instagram: {
        runId: instagramData.data.id,
        datasetId: instagramData.data.defaultDatasetId
      },
      igQty: IG_FIXED_QTY
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
