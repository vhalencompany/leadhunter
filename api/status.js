export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { google, igSearch, igProfile, qty, igQty, niche, city } = req.body;
  const APIFY = process.env.APIFY_TOKEN;

  if (!google?.runId || !igSearch?.runId) {
    return res.status(400).json({ error: 'google.runId e igSearch.runId são obrigatórios.' });
  }

  const FAILED = ['FAILED', 'ABORTED', 'TIMED-OUT'];

  try {
    // ═══════════════════════════════════════════════════════════════════════
    // FASE 1 — polling do Google + igSearch em paralelo
    // ═══════════════════════════════════════════════════════════════════════
    if (!igProfile) {
      const [googleStatus, igSearchStatus] = await Promise.all([
        fetch(`https://api.apify.com/v2/actor-runs/${google.runId}?token=${APIFY}`).then(r => r.json()),
        fetch(`https://api.apify.com/v2/actor-runs/${igSearch.runId}?token=${APIFY}`).then(r => r.json())
      ]);

      const gStatus = googleStatus?.data?.status;
      const sStatus = igSearchStatus?.data?.status;

      console.log(`[fase1] google=${gStatus} igSearch=${sStatus}`);

      if (FAILED.includes(gStatus)) {
        return res.status(200).json({ status: 'failed', reason: `Google: ${gStatus}` });
      }

      // Ainda rodando
      if (gStatus !== 'SUCCEEDED' || sStatus !== 'SUCCEEDED') {
        return res.status(200).json({
          status: 'running',
          phase: 1,
          google: gStatus,
          igSearch: sStatus
        });
      }

      // ─── Ambos terminaram — busca resultados do igSearch ─────────────────
      const igSearchItems = await fetch(
        `https://api.apify.com/v2/datasets/${igSearch.datasetId}/items?token=${APIFY}&limit=${parseInt(igQty) * 6}`
      ).then(r => r.json());

      // Extrai slugs/usernames dos places encontrados
      const slugs = extractSlugsFromPlaces(igSearchItems, niche, parseInt(igQty));

      console.log(`[fase1] igSearch retornou ${igSearchItems.length} places, ${slugs.length} slugs válidos`);

      // Se não encontrou nenhum perfil no Instagram, finaliza só com Google
      if (slugs.length === 0) {
        const googleItems = await fetch(
          `https://api.apify.com/v2/datasets/${google.datasetId}/items?token=${APIFY}&limit=${parseInt(qty)}`
        ).then(r => r.json());

        return res.status(200).json({
          status: 'done',
          places: googleItems.map(p => ({ ...p, source: 'google' }))
        });
      }

      // ─── Dispara Step 2 — instagram-profile-scraper com os slugs ─────────
      const profileRes = await fetch(
        `https://api.apify.com/v2/acts/apify~instagram-profile-scraper/runs?token=${APIFY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            usernames: slugs // array de usernames
          })
        }
      );

      if (!profileRes.ok) {
        const err = await profileRes.text();
        console.error(`[fase1] profile scraper error: ${err}`);
        // Falhou ao buscar perfis — retorna só Google
        const googleItems = await fetch(
          `https://api.apify.com/v2/datasets/${google.datasetId}/items?token=${APIFY}&limit=${parseInt(qty)}`
        ).then(r => r.json());

        return res.status(200).json({
          status: 'done',
          places: googleItems.map(p => ({ ...p, source: 'google' }))
        });
      }

      const profileData = await profileRes.json();

      // Retorna fase 2 para o frontend continuar o polling
      return res.status(200).json({
        status: 'running',
        phase: 2,
        google: { runId: google.runId, datasetId: google.datasetId },
        igSearch: { runId: igSearch.runId, datasetId: igSearch.datasetId },
        igProfile: {
          runId: profileData.data.id,
          datasetId: profileData.data.defaultDatasetId
        },
        qty,
        igQty,
        niche,
        city
      });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // FASE 2 — polling do igProfile + Google em paralelo
    // ═══════════════════════════════════════════════════════════════════════
    const [googleStatus, igProfileStatus] = await Promise.all([
      fetch(`https://api.apify.com/v2/actor-runs/${google.runId}?token=${APIFY}`).then(r => r.json()),
      fetch(`https://api.apify.com/v2/actor-runs/${igProfile.runId}?token=${APIFY}`).then(r => r.json())
    ]);

    const gStatus = googleStatus?.data?.status;
    const pStatus = igProfileStatus?.data?.status;

    console.log(`[fase2] google=${gStatus} igProfile=${pStatus}`);

    if (FAILED.includes(gStatus)) {
      return res.status(200).json({ status: 'failed', reason: `Google: ${gStatus}` });
    }

    if (gStatus !== 'SUCCEEDED' || pStatus !== 'SUCCEEDED') {
      return res.status(200).json({
        status: 'running',
        phase: 2,
        google: gStatus,
        igProfile: pStatus,
        // reenvia igProfile para o frontend manter no estado
        igProfileRun: igProfile
      });
    }

    // ─── Ambos terminaram — monta lista final ────────────────────────────────
    const [googleItems, igProfileItems] = await Promise.all([
      fetch(`https://api.apify.com/v2/datasets/${google.datasetId}/items?token=${APIFY}&limit=${parseInt(qty)}`).then(r => r.json()),
      fetch(`https://api.apify.com/v2/datasets/${igProfile.datasetId}/items?token=${APIFY}&limit=${parseInt(igQty) * 3}`).then(r => r.json())
    ]);

    const googleLeads = googleItems.map(p => ({ ...p, source: 'google' }));
    const igLeads = normalizeProfiles(igProfileItems, parseInt(igQty), niche);

    console.log(`[fase2] google=${googleLeads.length} instagram=${igLeads.length}`);

    return res.status(200).json({
      status: 'done',
      places: [...googleLeads, ...igLeads]
    });

  } catch (e) {
    console.error('[status error]', e.message);
    return res.status(500).json({ error: e.message });
  }
}

// ─── EXTRAI SLUGS DOS PLACES DO INSTAGRAM SEARCH SCRAPER ─────────────────────
// O instagram-search-scraper retorna lugares com campo "slug" ou "username"
function extractSlugsFromPlaces(places, niche, qty) {
  const nicheWords = (niche || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .split(/\s+/).filter(w => w.length > 3);

  const slugs = [];
  const seen = new Set();

  for (const place of places) {
    // O search scraper retorna slug do perfil associado ao lugar
    const slug = place.username || place.slug || place.profileUrl?.split('/').filter(Boolean).pop();
    if (!slug || seen.has(slug)) continue;

    // Filtra lugares que parecem negócios do nicho
    const name = (place.name || place.title || '').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const category = (place.category || place.businessCategory || '').toLowerCase();

    const matchesNiche = nicheWords.some(w => name.includes(w) || category.includes(w));

    // Inclui se bate com nicho, ou se não tem como verificar (inclui por padrão)
    if (matchesNiche || nicheWords.length === 0) {
      seen.add(slug);
      slugs.push(slug);
    }

    if (slugs.length >= qty * 2) break; // busca o dobro para ter margem de filtro
  }

  return slugs;
}

// ─── NORMALIZA PERFIS DO INSTAGRAM PROFILE SCRAPER ───────────────────────────
function normalizeProfiles(profiles, qty, niche) {
  const nicheWords = (niche || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .split(/\s+/).filter(w => w.length > 3);

  const PERSONAL_PATTERNS = [
    /\b(mafioso|ofc|pvt|personal|lifestyle|influencer|blogger|gamer|streamer|youtuber|tiktoker)\b/i,
    /\b(minha vida|meu dia|squad|gang|vlogs?)\b/i,
  ];

  const seen = new Set();
  const leads = [];

  for (const p of profiles) {
    const username = p.username;
    if (!username || seen.has(username)) continue;

    // Descarta contas privadas
    if (p.isPrivate === true) continue;

    // Descarta contas verificadas (grandes marcas)
    if (p.verified === true || p.isVerified === true) continue;

    // Descarta padrões pessoais
    const fullText = `${p.fullName || ''} ${p.biography || ''}`.toLowerCase();
    if (PERSONAL_PATTERNS.some(pat => pat.test(fullText))) continue;

    seen.add(username);

    // Campos do instagram-profile-scraper
    const followers  = p.followersCount ?? p.followers ?? 0;
    const postsCount = p.postsCount ?? p.mediaCount ?? 0;
    const site       = p.externalUrl || p.websiteUrl || extractUrl(p.biography || '');
    const phone      = p.publicPhoneNumber || extractPhone(p.biography || '');
    const lastPost   = p.latestPosts?.[0]?.timestamp || null;

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
      source:          'instagram'
    });

    if (leads.length >= qty) break;
  }

  return leads;
}

function extractUrl(bio) {
  const m = bio.match(/https?:\/\/[^\s]+/);
  return m ? m[0] : '';
}

function extractPhone(bio) {
  const m = bio.match(/(\(?\d{2}\)?\s?[\d\s\-]{8,13})/);
  return m ? m[0].trim() : '';
}
