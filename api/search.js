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
    const runRes = await fetch(`https://api.apify.com/v2/acts/apify~google-maps-scraper/runs?token=${APIFY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        searchTermsArray: [`${niche} em ${city}`],
        maxCrawledPlaces: parseInt(qty),
        language: 'pt',
        countryCode: 'BR'
      })
    });

    if (!runRes.ok) {
      const errText = await runRes.text();
      throw new Error(`Apify error ${runRes.status}: ${errText}`);
    }

    const runData = await runRes.json();
    const runId = runData.data.id;
    const datasetId = runData.data.defaultDatasetId;

    let done = false, tries = 0;
    while (!done && tries < 40) {
      await new Promise(r => setTimeout(r, 3000));
      tries++;
      const st = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY}`);
      const stData = await st.json();
      const status = stData.data.status;
      if (status === 'SUCCEEDED') done = true;
      else if (['FAILED','ABORTED','TIMED-OUT'].includes(status)) throw new Error('Busca falhou.');
    }

    if (!done) throw new Error('Timeout — tente com menos leads.');

    const itemsRes = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY}&limit=${qty}`);
    const places = await itemsRes.json();

    return res.status(200).json({ places });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
