export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { google, instagram, qty, igQty } = req.body;
  const APIFY = process.env.APIFY_TOKEN;

  if (!google?.runId || !instagram?.runId) {
    return res.status(400).json({ error: 'google.runId e instagram.runId são obrigatórios.' });
  }

  try {
    // ─── POLLING DOS DOIS EM PARALELO ────────────────────────────────────────
    const [googleStatus, instagramStatus] = await Promise.all([
      fetch(`https://api.apify.com/v2/actor-runs/${google.runId}?token=${APIFY}`).then(r => r.json()),
      fetch(`https://api.apify.com/v2/actor-runs/${instagram.runId}?token=${APIFY}`).then(r => r.json())
    ]);

    const gStatus = googleStatus?.data?.status;
    const iStatus = instagramStatus?.data?.status;

    console.log(`[status] google=${gStatus} instagram=${iStatus}`);

    const FAILED = ['FAILED', 'ABORTED', 'TIMED-OUT'];

    // Se Google falhou, aborta tudo
    if (FAILED.includes(gStatus)) {
      return res.status(200).json({ status: 'failed', reason: `Google: ${gStatus}` });
    }

    // Ainda rodando
    if (gStatus !== 'SUCCEEDED' || iStatus !== 'SUCCEEDED') {
      return res.status(200).json({
        status: 'running',
        google: gStatus,
        instagram: iStatus
      });
    }

    // ─── AMBOS SUCCEEDED — busca os dados ───────────────────────────────────
    const [googleItems, instagramItems] = await Promise.all([
      fetch(`https://api.apify.com/v2/datasets/${google.datasetId}/items?token=${APIFY}&limit=${parseInt(qty)}`).then(r => r.json()),
      fetch(`https://api.apify.com/v2/datasets/${instagram.datasetId}/items?token=${APIFY}&limit=${parseInt(igQty) * 5}`).then(r => r.json())
    ]);

    // Normaliza Instagram
    const igLeads = normalizeInstagramLeads(instagramItems, parseInt(igQty));

    // Marca origem nos leads do Google
    const googleLeads = googleItems.map(p => ({ ...p, source: 'google' }));

    return res.status(200).json({
      status: 'done',
      places: [...googleLeads, ...igLeads]
    });

  } catch (e) {
    console.error('[status error]', e.message);
    return res.status(500).json({ error: e.message });
  }
}

// ─── NORMALIZAÇÃO INSTAGRAM ───────────────────────────────────────────────────
function normalizeInstagramLeads(posts, qty) {
  const seen = new Set();
  const leads = [];

  for (const post of posts) {
    const owner = post.ownerFullName || post.ownerUsername;
    if (!owner || seen.has(post.ownerUsername)) continue;

    const isLikelyBusiness =
      post.isBusinessAccount !== false &&
      !post.isVerified;

    if (!isLikelyBusiness) continue;

    seen.add(post.ownerUsername);

    const site = post.ownerBiography
      ? extractUrlFromBio(post.ownerBiography)
      : post.ownerExternalUrl || '';

    const telefone = post.ownerBiography
      ? extractPhoneFromBio(post.ownerBiography)
      : post.ownerPublicPhoneNumber || '';

    leads.push({
      title: post.ownerFullName || post.ownerUsername,
      categoryName: post.ownerBusinessCategoryName || 'Instagram Business',
      address: post.locationName || '',
      phone: telefone,
      website: site,
      totalScore: null,
      reviewsCount: 0,
      instagramHandle: post.ownerUsername,
      instagramUrl: `https://www.instagram.com/${post.ownerUsername}/`,
      followers: post.ownerFollowersCount || 0,
      postsCount: post.ownerPostsCount || 0,
      bio: post.ownerBiography || '',
      lastPostDate: post.timestamp || null,
      likesCount: post.likesCount || 0,
      commentsCount: post.commentsCount || 0,
      source: 'instagram'
    });

    if (leads.length >= qty) break;
  }

  return leads;
}

function extractUrlFromBio(bio) {
  const match = bio.match(/https?:\/\/[^\s]+/);
  return match ? match[0] : '';
}

function extractPhoneFromBio(bio) {
  const match = bio.match(/(\(?\d{2}\)?\s?[\d\s\-]{8,13})/);
  return match ? match[0].trim() : '';
}
