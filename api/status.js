export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { runId, datasetId, qty, source = 'google' } = req.body;
  const APIFY = process.env.APIFY_TOKEN;

  if (!runId || !datasetId) {
    return res.status(400).json({ error: 'runId e datasetId são obrigatórios.' });
  }

  try {
    const st = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY}`);
    const stData = await st.json();
    const status = stData?.data?.status;
    console.log(`[status] runId=${runId} source=${source} status=${status}`);

    if (status === 'SUCCEEDED') {
      const itemsRes = await fetch(
        `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY}&limit=${parseInt(qty) * 5}`
      );
      const rawItems = await itemsRes.json();

      // ─── GOOGLE: retorna direto como antes ──────────────────────────────
      if (source === 'google') {
        return res.status(200).json({ status: 'done', places: rawItems, source: 'google' });
      }

      // ─── INSTAGRAM: normaliza posts → perfis únicos de negócios ────────
      if (source === 'instagram') {
        const places = normalizeInstagramLeads(rawItems, parseInt(qty));
        return res.status(200).json({ status: 'done', places, source: 'instagram' });
      }
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

// ─── NORMALIZAÇÃO INSTAGRAM → formato compatível com Google Maps ─────────────
// O actor do Instagram retorna posts. Precisamos extrair perfis únicos de negócios.
function normalizeInstagramLeads(posts, qty) {
  const seen = new Set();
  const leads = [];

  for (const post of posts) {
    // Pula se não tem dados do owner/perfil
    const owner = post.ownerFullName || post.ownerUsername;
    if (!owner || seen.has(post.ownerUsername)) continue;

    // Filtra apenas contas business ou creator (mais provável ser negócio)
    // Se não tiver essa info, inclui mesmo assim
    const isLikelyBusiness =
      post.isBusinessAccount !== false &&
      !post.isVerified; // verificadas geralmente são grandes marcas, não ICP

    if (!isLikelyBusiness) continue;

    seen.add(post.ownerUsername);

    // Extrai site da bio se disponível
    const site = post.ownerBiography
      ? extractUrlFromBio(post.ownerBiography)
      : post.ownerExternalUrl || '';

    // Extrai telefone da bio se disponível
    const telefone = post.ownerBiography
      ? extractPhoneFromBio(post.ownerBiography)
      : post.ownerPublicPhoneNumber || '';

    leads.push({
      // Campos compatíveis com Google Maps (usados no analyze.js)
      title: post.ownerFullName || post.ownerUsername,
      categoryName: post.ownerBusinessCategoryName || 'Instagram Business',
      address: post.locationName || '',
      phone: telefone,
      website: site,
      totalScore: null,       // Instagram não tem nota
      reviewsCount: 0,        // Instagram não tem avaliações

      // Campos extras do Instagram (usados no scoring e análise)
      instagramHandle: post.ownerUsername,
      instagramUrl: `https://www.instagram.com/${post.ownerUsername}/`,
      followers: post.ownerFollowersCount || 0,
      postsCount: post.ownerPostsCount || 0,
      bio: post.ownerBiography || '',
      lastPostDate: post.timestamp || null,
      likesCount: post.likesCount || 0,
      commentsCount: post.commentsCount || 0,

      // Flag de origem
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
