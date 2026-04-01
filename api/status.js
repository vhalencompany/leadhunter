export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { runId, datasetId, qty } = req.body;
  const APIFY = process.env.APIFY_TOKEN;

  if (!runId || !datasetId) {
    return res.status(400).json({ error: 'runId e datasetId são obrigatórios.' });
  }

  try {
    const st = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY}`);
    const stData = await st.json();
    const status = stData?.data?.status;

    console.log(`[status] runId=${runId} status=${status}`);

    if (status === 'SUCCEEDED') {
      const itemsRes = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY}&limit=${qty}`);
      const places = await itemsRes.json();
      return res.status(200).json({ status: 'done', places });
    }

    if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) {
      return res.status(200).json({ status: 'failed', reason: status });
    }

    return res.status(200).json({ status: 'running' });
  } catch (e) {
    console.error('[status error]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
