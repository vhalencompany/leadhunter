export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { niche, city, qty } = req.body;
  const APIFY = process.env.APIFY_TOKEN;
  if (!APIFY) return res.status(500).json({ error: 'Token não configurado.' });

  try {
    const runRes = await fetch(`https://api.apify.com/v2/acts/compass~crawler-google-places/runs?token=${APIFY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        searchStringsArray: [niche],
        locationQuery: `${city}, Brasil`,
        maxCrawledPlacesPerSearch: parseInt(qty),
        language: 'pt',
        maxImages: 0,
        maxReviews: 0,
        includeWebResults: false,
        scrapeContacts: false,
        scrapeDirectories: false,
        skipClosedPlaces: false,
        searchMatching: 'all',
        website: 'allPlaces',
        maxQuestions: 0,
        reviewsSort: 'newest',
        reviewsOrigin: 'all',
        allPlacesNoSearchAction: ''
      })
    });

    if (!runRes.ok) {
      const errText = await runRes.text();
      throw new Error(`Apify error ${runRes.status}: ${errText}`);
    }

    const runData = await runRes.json();
    const { id: runId, defaultDatasetId: datasetId } = runData.data;

    return res.status(200).json({ runId, datasetId });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
