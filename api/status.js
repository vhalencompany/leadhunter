export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { google, instagram, qty, igQty, niche } = req.body;
  const APIFY = process.env.APIFY_TOKEN;

  if (!google?.runId || !instagram?.runId) {
    return res.status(400).json({ error: 'google.runId e instagram.runId são obrigatórios.' });
  }

  try {
    const [googleStatus, instagramStatus] = await Promise.all([
      fetch(`https://api.apify.com/v2/actor-runs/${google.runId}?token=${APIFY}`).then(r => r.json()),
      fetch(`https://api.apify.com/v2/actor-runs/${instagram.runId}?token=${APIFY}`).then(r => r.json())
    ]);

    const gStatus = googleStatus?.data?.status;
    const iStatus = instagramStatus?.data?.status;

    console.log(`[status] google=${gStatus} instagram=${iStatus}`);

    const FAILED = ['FAILED', 'ABORTED', 'TIMED-OUT'];

    if (FAILED.includes(gStatus)) {
      return res.status(200).json({ status: 'failed', reason: `Google: ${gStatus}` });
    }

    if (gStatus !== 'SUCCEEDED' || iStatus !== 'SUCCEEDED') {
      return res.status(200).json({ status: 'running', google: gStatus, instagram: iStatus });
    }

    // ─── BUSCA OS DADOS ───────────────────────────────────────────────────────
    const [googleItems, instagramItems] = await Promise.all([
      fetch(`https://api.apify.com/v2/datasets/${google.datasetId}/items?token=${APIFY}&limit=${parseInt(qty)}`).then(r => r.json()),
      fetch(`https://api.apify.com/v2/datasets/${instagram.datasetId}/items?token=${APIFY}&limit=${parseInt(igQty) * 8}`).then(r => r.json())
    ]);

    const googleLeads = googleItems.map(p => ({ ...p, source: 'google' }));
    const igLeads = normalizeInstagramProfiles(instagramItems, parseInt(igQty), niche);

    console.log(`[status] google=${googleLeads.length} instagram=${igLeads.length} (de ${instagramItems.length} perfis brutos)`);

    return res.status(200).json({
      status: 'done',
      places: [...googleLeads, ...igLeads]
    });

  } catch (e) {
    console.error('[status error]', e.message);
    return res.status(500).json({ error: e.message });
  }
}

// ─── FILTROS B2B ──────────────────────────────────────────────────────────────

// Padrões que indicam conta pessoal / B2C — descarta
const PERSONAL_PATTERNS = [
  /\b(mafioso|ofc|pvt|personal|lifestyle|influencer|blogger|gamer|streamer|youtuber|tiktoker)\b/i,
  /\b(minha vida|meu dia|meus rolê|squad|gang|vlogs?)\b/i,
];

// Emojis que raramente aparecem em perfis B2B legítimos
const SUSPICIOUS_EMOJI = /[\u{1F300}-\u{1F9FF}\u{2702}-\u{27B0}]{3,}/u;

// Categorias do Instagram que confirmam negócio
const BUSINESS_CATEGORIES = [
  'beauty', 'health', 'medical', 'dental', 'clinic', 'restaurant', 'food',
  'gym', 'fitness', 'pet', 'real estate', 'accounting', 'law', 'lawyer',
  'clothing', 'fashion', 'store', 'shop', 'salon', 'spa', 'barber',
  'escola', 'school', 'education', 'consultoria', 'agência', 'empresa',
  'saúde', 'beleza', 'academia', 'clínica', 'restaurante', 'loja', 'imobiliária'
];

function isLikelyB2B(profile, niche) {
  const name    = (profile.fullName || profile.username || '').toLowerCase();
  const bio     = (profile.biography || '').toLowerCase();
  const category= (profile.businessCategoryName || '').toLowerCase();
  const nicheLC = (niche || '').toLowerCase();

  // ── Descarta contas não-business explicitamente ──
  if (profile.isBusinessAccount === false) return false;

  // ── Descarta contas verificadas (grandes marcas, celebridades) ──
  if (profile.verified === true) return false;

  // ── Descarta padrões de conta pessoal ──
  const fullText = `${name} ${bio}`;
  if (PERSONAL_PATTERNS.some(p => p.test(fullText))) return false;

  // ── Descarta nomes com excesso de emojis (ex: "Sr. Mafioso OFC🜲") ──
  if (SUSPICIOUS_EMOJI.test(profile.fullName || '')) return false;

  // ── Descarta perfis privados ──
  if (profile.isPrivate === true) return false;

  // ── Bonus: categoria do Instagram bate com negócio ──
  const categoryMatch = BUSINESS_CATEGORIES.some(c => category.includes(c));

  // ── Bonus: nicho aparece no nome ou bio ──
  const nicheWords = nicheLC.split(/\s+/);
  const nicheMatch = nicheWords.some(w => w.length > 3 && (name.includes(w) || bio.includes(w)));

  // Precisa de pelo menos um sinal positivo (categoria ou nicho no nome/bio)
  // a menos que seja explicitamente marcado como business account
  if (profile.isBusinessAccount === true) return true;
  return categoryMatch || nicheMatch;
}

function normalizeInstagramProfiles(profiles, qty, niche) {
  const seen = new Set();
  const leads = [];

  for (const p of profiles) {
    // Deduplicação por username
    const username = p.username || p.ownerUsername;
    if (!username || seen.has(username)) continue;

    // Filtro B2B
    if (!isLikelyB2B(p, niche)) continue;

    seen.add(username);

    // ── Campos — o actor retorna detalhes do perfil direto ──
    const followers  = p.followersCount ?? p.followersCount ?? p.followers ?? 0;
    const postsCount = p.postsCount ?? p.mediaCount ?? 0;
    const site       = p.externalUrl || p.websiteUrl || extractUrlFromBio(p.biography || '');
    const phone      = p.publicPhoneNumber || extractPhoneFromBio(p.biography || '');
    const lastPost   = p.latestIgtvVideo?.timestamp || p.latestPost?.timestamp || null;

    leads.push({
      title:           p.fullName || username,
      categoryName:    p.businessCategoryName || niche,
      address:         p.cityName || p.addressStreet || '',
      phone,
      website:         site,
      totalScore:      null,
      reviewsCount:    0,
      instagramHandle: username,
      instagramUrl:    `https://www.instagram.com/${username}/`,
      followers,
      postsCount,
      bio:             p.biography || '',
      lastPostDate:    lastPost,
      likesCount:      0,
      commentsCount:   0,
      source:          'instagram'
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
