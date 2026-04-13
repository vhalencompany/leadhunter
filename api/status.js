export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const {
    runId, datasetId, qty,
    // Fase 2
    igEnrichRunId, igEnrichDatasetId,
    igPostRunId, igPostDatasetId,
    reviewsRunId, reviewsDatasetId,
    googleDatasetId, googleQty
  } = req.body;

  const APIFY = process.env.APIFY_TOKEN;
  const REVIEWS_LIMIT = 10; // 10 reviews por lead

  if (!runId || !datasetId) {
    return res.status(400).json({ error: 'runId e datasetId são obrigatórios.' });
  }

  const FAILED = ['FAILED', 'ABORTED', 'TIMED-OUT'];

  try {
    // ═══════════════════════════════════════════════════════════════════════
    // FASE 1 — polling do Google Maps
    // ═══════════════════════════════════════════════════════════════════════
    if (!igEnrichRunId && !reviewsRunId) {
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

      const igUsernames = extractInstagramUsernames(places);
      const placeUrls   = extractPlaceUrls(places);

      console.log(`[fase1] ${places.length} leads, ${igUsernames.length} com Instagram, ${placeUrls.length} com URL para reviews`);

      // Se não há nada para enriquecer, retorna direto
      if (igUsernames.length === 0 && placeUrls.length === 0) {
        return res.status(200).json({ status: 'done', places });
      }

      // Dispara Instagram Profile + Post + Reviews em paralelo
      const enrichPromises = [
        // Instagram Profile Scraper
        igUsernames.length > 0
          ? fetch(`https://api.apify.com/v2/acts/apify~instagram-profile-scraper/runs?token=${APIFY}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ usernames: igUsernames })
            })
          : Promise.resolve(null),

        // Instagram Post Scraper
        igUsernames.length > 0
          ? fetch(`https://api.apify.com/v2/acts/apify~instagram-scraper/runs?token=${APIFY}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                directUrls: igUsernames.map(u => `https://www.instagram.com/${u}/`),
                resultsType: 'posts',
                resultsLimit: 6
              })
            })
          : Promise.resolve(null),

        // Google Maps Reviews Scraper
        placeUrls.length > 0
          ? fetch(`https://api.apify.com/v2/acts/compass~google-maps-reviews-scraper/runs?token=${APIFY}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                startUrls: placeUrls.map(url => ({ url })),
                maxReviews: REVIEWS_LIMIT,
                reviewsSort: 'newest',
                language: 'pt'
              })
            })
          : Promise.resolve(null)
      ];

      const [profileRes, postRes, reviewsRes] = await Promise.all(enrichPromises);

      const profileData = profileRes?.ok ? await profileRes.json() : null;
      const postData    = postRes?.ok    ? await postRes.json()    : null;
      const reviewsData = reviewsRes?.ok ? await reviewsRes.json() : null;

      return res.status(200).json({
        status: 'running',
        phase: 2,
        igEnrichRunId:     profileData?.data?.id                    || null,
        igEnrichDatasetId: profileData?.data?.defaultDatasetId      || null,
        igPostRunId:       postData?.data?.id                       || null,
        igPostDatasetId:   postData?.data?.defaultDatasetId         || null,
        reviewsRunId:      reviewsData?.data?.id                    || null,
        reviewsDatasetId:  reviewsData?.data?.defaultDatasetId      || null,
        googleDatasetId:   datasetId,
        googleQty:         qty
      });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // FASE 2 — polling do Instagram + Reviews em paralelo
    // ═══════════════════════════════════════════════════════════════════════
    const statusChecks = await Promise.all([
      igEnrichRunId
        ? fetch(`https://api.apify.com/v2/actor-runs/${igEnrichRunId}?token=${APIFY}`).then(r => r.json())
        : Promise.resolve({ data: { status: 'SUCCEEDED' } }),
      igPostRunId
        ? fetch(`https://api.apify.com/v2/actor-runs/${igPostRunId}?token=${APIFY}`).then(r => r.json())
        : Promise.resolve({ data: { status: 'SUCCEEDED' } }),
      reviewsRunId
        ? fetch(`https://api.apify.com/v2/actor-runs/${reviewsRunId}?token=${APIFY}`).then(r => r.json())
        : Promise.resolve({ data: { status: 'SUCCEEDED' } })
    ]);

    const profileStatus = statusChecks[0]?.data?.status;
    const postStatus    = statusChecks[1]?.data?.status;
    const reviewsStatus = statusChecks[2]?.data?.status;

    console.log(`[fase2] profile=${profileStatus} posts=${postStatus} reviews=${reviewsStatus}`);

    const allDone = profileStatus === 'SUCCEEDED' && postStatus === 'SUCCEEDED' && reviewsStatus === 'SUCCEEDED';
    const allFailed = FAILED.includes(profileStatus) && FAILED.includes(postStatus) && FAILED.includes(reviewsStatus);

    if (!allDone) {
      if (allFailed) {
        const googleItems = await fetch(
          `https://api.apify.com/v2/datasets/${googleDatasetId}/items?token=${APIFY}&limit=${googleQty}`
        ).then(r => r.json());
        return res.status(200).json({ status: 'done', places: googleItems });
      }
      return res.status(200).json({
        status: 'running', phase: 2,
        igEnrichRunId, igEnrichDatasetId,
        igPostRunId, igPostDatasetId,
        reviewsRunId, reviewsDatasetId,
        googleDatasetId, googleQty
      });
    }

    // ─── Todos terminaram — busca os dados ───────────────────────────────
    const [googleItems, profileItems, postItems, reviewsItems] = await Promise.all([
      fetch(`https://api.apify.com/v2/datasets/${googleDatasetId}/items?token=${APIFY}&limit=${googleQty}`).then(r => r.json()),
      igEnrichDatasetId
        ? fetch(`https://api.apify.com/v2/datasets/${igEnrichDatasetId}/items?token=${APIFY}&limit=200`).then(r => r.json())
        : Promise.resolve([]),
      igPostDatasetId
        ? fetch(`https://api.apify.com/v2/datasets/${igPostDatasetId}/items?token=${APIFY}&limit=500`).then(r => r.json())
        : Promise.resolve([]),
      reviewsDatasetId
        ? fetch(`https://api.apify.com/v2/datasets/${reviewsDatasetId}/items?token=${APIFY}&limit=2000`).then(r => r.json())
        : Promise.resolve([])
    ]);

    // Índices para lookup rápido
    const profileByUsername = buildProfileIndex(profileItems);
    const postsByUsername   = buildPostsIndex(postItems);
    const reviewsByPlaceId  = buildReviewsIndex(reviewsItems);

    // Enriquece cada lead
    const enrichedPlaces = googleItems.map(place => {
      const enriched = { ...place };

      // Instagram
      const igUsername = extractUsernameFromPlace(place);
      if (igUsername) {
        const profile = profileByUsername[igUsername] || {};
        const posts   = postsByUsername[igUsername]   || [];
        enriched.igEnriched = {
          username:          igUsername,
          url:               `https://www.instagram.com/${igUsername}/`,
          followers:         profile.followersCount ?? profile.followers ?? 0,
          following:         profile.followsCount   ?? 0,
          postsCount:        profile.postsCount      ?? profile.mediaCount ?? 0,
          bio:               profile.biography       ?? '',
          site:              profile.externalUrl     ?? profile.websiteUrl ?? '',
          isBusinessAccount: profile.isBusinessAccount ?? null,
          businessCategory:  profile.businessCategoryName ?? '',
          verified:          profile.verified ?? false,
          recentPosts:       posts.slice(0, 6).map(p => ({
            caption:   (p.caption || p.text || '').slice(0, 200),
            likes:     p.likesCount    ?? p.likes    ?? 0,
            comments:  p.commentsCount ?? p.comments ?? 0,
            timestamp: p.timestamp     ?? p.takenAt  ?? null,
            hashtags:  p.hashtags      ?? [],
          })),
          avgLikes:          calcAvg(posts, 'likesCount') || calcAvg(posts, 'likes'),
          avgComments:       calcAvg(posts, 'commentsCount') || calcAvg(posts, 'comments'),
          lastPostDate:      posts[0]?.timestamp ?? posts[0]?.takenAt ?? null,
          daysSinceLastPost: posts[0]
            ? Math.floor((Date.now() - new Date(posts[0].timestamp ?? posts[0].takenAt)) / 86400000)
            : null,
        };
      }

      // Reviews
      const placeId = place.placeId || place.id || '';
      const reviews = reviewsByPlaceId[placeId] || [];
      if (reviews.length > 0) {
        const ratings = reviews.map(r => r.stars ?? r.rating).filter(r => typeof r === 'number');
        const avgRating = ratings.length ? (ratings.reduce((a,b)=>a+b,0)/ratings.length).toFixed(1) : null;

        enriched.reviewsEnriched = {
          totalScraped: reviews.length,
          avgRating,
          reviews: reviews.slice(0, REVIEWS_LIMIT).map(r => ({
            texto:     r.text || r.snippet || '',
            nota:      r.stars ?? r.rating ?? null,
            data:      r.publishedAtDate || r.date || null,
            autor:     r.name || r.reviewer?.name || 'Anônimo',
            respostaOwner: r.responseFromOwnerText || null,
          }))
        };
      }

      return enriched;
    });

    const igCount = enrichedPlaces.filter(p => p.igEnriched).length;
    const rvCount = enrichedPlaces.filter(p => p.reviewsEnriched).length;
    console.log(`[fase2] ${igCount} com Instagram, ${rvCount} com reviews`);

    return res.status(200).json({ status: 'done', places: enrichedPlaces });

  } catch (e) {
    console.error('[status error]', e.message);
    return res.status(500).json({ error: e.message });
  }
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function extractInstagramUsernames(places) {
  const usernames = [], seen = new Set();
  for (const p of places) {
    const u = extractUsernameFromPlace(p);
    if (u && !seen.has(u)) { seen.add(u); usernames.push(u); }
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
  const match = igUrl.match(/instagram\.com\/([^/?#\s]+)/i);
  const username = match?.[1];
  if (!username || ['p','reel','explore','stories','tv'].includes(username)) return null;
  return username.toLowerCase();
}

// Extrai a URL do Google Maps de cada lead para buscar reviews
function extractPlaceUrls(places) {
  const urls = [], seen = new Set();
  for (const p of places) {
    const url = p.url || p.googleUrl || p.website;
    // Só URLs do Google Maps
    if (url && url.includes('google.com/maps') && !seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
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
  for (const key of Object.keys(idx)) {
    idx[key].sort((a, b) => {
      const ta = new Date(a.timestamp ?? a.takenAt ?? 0).getTime();
      const tb = new Date(b.timestamp ?? b.takenAt ?? 0).getTime();
      return tb - ta;
    });
  }
  return idx;
}

// Reviews indexadas por placeId
function buildReviewsIndex(reviews) {
  const idx = {};
  for (const r of reviews) {
    // O reviews scraper retorna placeId ou associa pelo url do lugar
    const key = r.placeId || r.id || '';
    if (!key) continue;
    if (!idx[key]) idx[key] = [];
    idx[key].push(r);
  }
  return idx;
}

function calcAvg(posts, field) {
  const vals = posts.map(p => p[field]).filter(v => typeof v === 'number');
  if (!vals.length) return 0;
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
}
