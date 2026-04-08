export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { niche, city, qty } = req.body;
  const APIFY = process.env.APIFY_TOKEN;
  if (!APIFY) return res.status(500).json({ error: 'Token não configurado.' });

  const IG_FIXED_QTY = 10;

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

    // ─── INSTAGRAM SEARCH — Step 1 ────────────────────────────────────────────
    // Busca por "place" com nicho + cidade.
    // Retorna negócios locais registrados no Instagram com endereço e categoria.
    // Os slugs retornados serão usados no Step 2 (profile scraper).
    const igSearchPromise = fetch(
      `https://api.apify.com/v2/acts/apify~instagram-search-scraper/runs?token=${APIFY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          searchQueries: [
            `${niche} ${city}`,
            `${niche}`,
          ],
          searchType: 'place',         // busca lugares/negócios registrados
          resultsPerQuery: IG_FIXED_QTY * 3 // busca mais para filtrar depois
        })
      }
    );

    // ─── DISPARA EM PARALELO ─────────────────────────────────────────────────
    const [googleRes, igSearchRes] = await Promise.all([googlePromise, igSearchPromise]);

    if (!googleRes.ok) {
      const err = await googleRes.text();
      throw new Error(`Apify Google error ${googleRes.status}: ${err}`);
    }
    if (!igSearchRes.ok) {
      const err = await igSearchRes.text();
      throw new Error(`Apify Instagram Search error ${igSearchRes.status}: ${err}`);
    }

    const [googleData, igSearchData] = await Promise.all([
      googleRes.json(),
      igSearchRes.json()
    ]);

    return res.status(200).json({
      google: {
        runId: googleData.data.id,
        datasetId: googleData.data.defaultDatasetId
      },
      igSearch: {
        runId: igSearchData.data.id,
        datasetId: igSearchData.data.defaultDatasetId
      },
      igQty: IG_FIXED_QTY,
      niche,
      city
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
