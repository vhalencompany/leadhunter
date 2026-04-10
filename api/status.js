export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { runId, datasetId, qty, igEnrichRunId, igEnrichDatasetId } = req.body;
  const APIFY = process.env.APIFY_TOKEN;

  if (!runId || !datasetId) {
    return res.status(400).json({ error: 'runId e datasetId são obrigatórios.' });
  }

  const FAILED = ['FAILED', 'ABORTED', 'TIMED-OUT'];

  try {
    // ═══════════════════════════════════════════════════════════════════════
    // FASE 1 — polling do Google Maps
    // ═══════════════════════════════════════════════════════════════════════
    if (!igEnrichRunId) {
      const st = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY}`);
      const stData = await st.json();
      const status = stData?.data?.status;

      console.log(`[fase1] runId=${runId} status=${status}`);

      if (FAILED.includes(status)) {
        return res.status(200).json({ status: 'failed', reason: status });
      }

      if (status !== 'SUCCEEDED') {
        return res.status(200).json({ status: 'running', phase: 1 });
      }

      // Google Maps terminou — busca os leads
      const itemsRes = await fetch(
        `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY}&limit=${qty}`
      );
      const places = await itemsRes.json();

      // Extrai usernames do Instagram dos leads
      const igUsernames = extractInstagramUsernames(places);
      console.log(`[fase1] ${places.length} leads, ${igUsernames.length} com Instagram`);

      // Se nenhum lead tem Instagram, retorna direto sem enriquecimento
      if (igUsernames.length === 0) {
        return res.status(200).json({ status: 'done', places });
      }

      // Dispara Instagram Profile Scraper + Post Scraper em paralelo
      const [profileRes, postRes] = await Promise.all([
        // Profile Scraper — seguidores, bio, categoria, site
        fetch(`https://api.apify.com/v2/acts/apify~instagram-profile-scraper/runs?token=${APIFY}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ usernames: igUsernames })
        }),
        // Post Scraper — últimos posts, curtidas, comentários, legendas
        fetch(`https://api.apify.com/v2/acts/apify~instagram-scraper/runs?token=${APIFY}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            directUrls: igUsernames.map(u => `https://www.instagram.com/${u}/`),
            resultsType: 'posts',
            resultsLimit: 6 // últimos 6 posts por perfil — suficiente para análise
          })
        })
      ]);

      // Se ambos falharam ao disparar, retorna os leads sem enriquecimento
      if (!profileRes.ok && !postRes.ok) {
        console.log('[fase1] Instagram actors falharam ao iniciar, retornando só Google');
        return res.status(200).json({ status: 'done', places });
      }

      const profileData = profileRes.ok ? await profileRes.json() : null;
      const postData    = postRes.ok    ? await postRes.json()    : null;

      // Retorna fase 2 para o frontend continuar o polling
      return res.status(200).json({
        status: 'running',
        phase: 2,
        igEnrichRunId:     profileData?.data?.id     || null,
        igEnrichDatasetId: profileData?.data?.defaultDatasetId || null,
        igPostRunId:       postData?.data?.id        || null,
        igPostDatasetId:   postData?.data?.defaultDatasetId    || null,
        // Passa os dados do Google Maps para não precisar rebuscar
        googleDatasetId: datasetId,
        googleQty: qty
      });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // FASE 2 — polling do enriquecimento Instagram
    // ═══════════════════════════════════════════════════════════════════════
    const { igPostRunId, igPostDatasetId, googleDatasetId, googleQty } = req.body;

    // Polling em paralelo dos dois actors do Instagram
    const statusChecks = await Promise.all([
      igEnrichRunId
        ? fetch(`https://api.apify.com/v2/actor-runs/${igEnrichRunId}?token=${APIFY}`).then(r => r.json())
        : Promise.resolve({ data: { status: 'SUCCEEDED' } }),
      igPostRunId
        ? fetch(`https://api.apify.com/v2/actor-runs/${igPostRunId}?token=${APIFY}`).then(r => r.json())
        : Promise.resolve({ data: { status: 'SUCCEEDED' } })
    ]);

    const profileStatus = statusChecks[0]?.data?.status;
    const postStatus    = statusChecks[1]?.data?.status;

    console.log(`[fase2] profile=${profileStatus} posts=${postStatus}`);

    // Ainda rodando
    if (profileStatus !== 'SUCCEEDED' || postStatus !== 'SUCCEEDED') {
      // Se algum falhou mas não ambos, continua aguardando o outro
      const anyFailed =
        FAILED.includes(profileStatus) && FAILED.includes(postStatus);
      if (anyFailed) {
        // Ambos falharam — retorna só Google Maps
        const googleItems = await fetch(
          `https://api.apify.com/v2/datasets/${googleDatasetId}/items?token=${APIFY}&limit=${googleQty}`
        ).then(r => r.json());
        return res.status(200).json({ status: 'done', places: googleItems });
      }
      return res.status(200).json({
        status: 'running',
        phase: 2,
        igEnrichRunId,
        igEnrichDatasetId,
        igPostRunId,
        igPostDatasetId,
        googleDatasetId,
        googleQty
      });
    }

    // Ambos terminaram — busca todos os dados
    const [googleItems, profileItems, postItems] = await Promise.all([
      fetch(`https://api.apify.com/v2/datasets/${googleDatasetId}/items?token=${APIFY}&limit=${googleQty}`).then(r => r.json()),
      igEnrichDatasetId
        ? fetch(`https://api.apify.com/v2/datasets/${igEnrichDatasetId}/items?token=${APIFY}&limit=200`).then(r => r.json())
        : Promise.resolve([]),
      igPostDatasetId
        ? fetch(`https://api.apify.com/v2/datasets/${igPostDatasetId}/items?token=${APIFY}&limit=500`).then(r => r.json())
        : Promise.resolve([])
    ]);

    // Monta índices para lookup rápido por username
    const profileByUsername = buildProfileIndex(profileItems);
    const postsByUsername   = buildPostsIndex(postItems);

    // Enriquece os leads do Google Maps com dados do Instagram
    const enrichedPlaces = googleItems.map(place => {
      const igUsername = extractUsernameFromPlace(place);
      if (!igUsername) return place;

      const profile = profileByUsername[igUsername] || {};
      const posts   = postsByUsername[igUsername]   || [];

      return {
        ...place,
        igEnriched: {
          username:      igUsername,
          url:           `https://www.instagram.com/${igUsername}/`,
          followers:     profile.followersCount ?? profile.followers ?? 0,
          following:     profile.followsCount   ?? 0,
          postsCount:    profile.postsCount      ?? profile.mediaCount ?? 0,
          bio:           profile.biography       ?? '',
          site:          profile.externalUrl     ?? profile.websiteUrl ?? '',
          isBusinessAccount: profile.isBusinessAccount ?? null,
          businessCategory:  profile.businessCategoryName ?? '',
          verified:      profile.verified        ?? false,
          // Análise dos posts
          recentPosts:   posts.slice(0, 6).map(p => ({
            caption:      (p.caption || p.text || '').slice(0, 200),
            likes:        p.likesCount      ?? p.likes       ?? 0,
            comments:     p.commentsCount   ?? p.comments    ?? 0,
            timestamp:    p.timestamp       ?? p.takenAt     ?? null,
            hashtags:     p.hashtags        ?? [],
          })),
          avgLikes:      calcAvg(posts, 'likesCount') || calcAvg(posts, 'likes'),
          avgComments:   calcAvg(posts, 'commentsCount') || calcAvg(posts, 'comments'),
          lastPostDate:  posts[0]?.timestamp ?? posts[0]?.takenAt ?? null,
          daysSinceLastPost: posts[0]
            ? Math.floor((Date.now() - new Date(posts[0].timestamp ?? posts[0].takenAt)) / 86400000)
            : null,
        }
      };
    });

    console.log(`[fase2] ${enrichedPlaces.filter(p => p.igEnriched).length} leads enriquecidos com Instagram`);

    return res.status(200).json({ status: 'done', places: enrichedPlaces });

  } catch (e) {
    console.error('[status error]', e.message);
    return res.status(500).json({ error: e.message });
  }
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function extractInstagramUsernames(places) {
  const usernames = [];
  const seen = new Set();

  for (const p of places) {
    const username = extractUsernameFromPlace(p);
    if (username && !seen.has(username)) {
      seen.add(username);
      usernames.push(username);
    }
  }
  return usernames;
}

function extractUsernameFromPlace(place) {
  const socialLinks = place.socialLinks || [];
  let igUrl = socialLinks.find(s => s && s.toLowerCase().includes('instagram.com')) || '';

  if (!igUrl) {
    const site = place.website || '';
    if (site.toLowerCase().includes('instagram.com')) igUrl = site;
  }

  if (!igUrl) return null;

  // Extrai username da URL: instagram.com/username ou instagram.com/username/
  const match = igUrl.match(/instagram\.com\/([^/?#\s]+)/i);
  const username = match?.[1];

  // Descarta slugs inválidos
  if (!username || ['p', 'reel', 'explore', 'stories', 'tv'].includes(username)) return null;
  return username.toLowerCase();
}

function buildProfileIndex(profiles) {
  const idx = {};
  for (const p of profiles) {
    const key = (p.username || '').toLowerCase();
    if (key) idx[key] = p;
  }
  return idx;
}

function buildPostsIndex(posts) {
  const idx = {};
  for (const p of posts) {
    const key = (p.ownerUsername || p.username || '').toLowerCase();
    if (!key) continue;
    if (!idx[key]) idx[key] = [];
    idx[key].push(p);
  }
  // Ordena por data mais recente
  for (const key of Object.keys(idx)) {
    idx[key].sort((a, b) => {
      const ta = new Date(a.timestamp ?? a.takenAt ?? 0).getTime();
      const tb = new Date(b.timestamp ?? b.takenAt ?? 0).getTime();
      return tb - ta;
    });
  }
  return idx;
}

function calcAvg(posts, field) {
  const vals = posts.map(p => p[field]).filter(v => typeof v === 'number');
  if (!vals.length) return 0;
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
}
