import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TELEGRAM_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY")!;
const TMDB_KEY = Deno.env.get("TMDB_API_KEY")!;
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const MY_SUBS = ["HBO Max", "Prime Video", "Amazon Prime Video", "Netflix", "Disney Plus", "Disney+", "NPO", "NPO Plus", "NPO Start"];

async function sendTelegram(chatId: number | string, text: string, buttons?: any[][]) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
      reply_markup: buttons ? { inline_keyboard: buttons } : undefined,
    }),
  });
  return res.json();
}

async function answerCallback(callbackQueryId: string, text?: string) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
}

// Leest X / Twitter linkjes uit via publieke oEmbed (geen X API-key nodig)
async function extractXPostText(text: string): Promise<string | null> {
  const match = text.match(/https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[a-zA-Z0-9_]+\/status\/\d+/i);
  if (!match) return null;
  try {
    const res = await fetch(`https://publish.twitter.com/oembed?url=${encodeURIComponent(match[0])}&omit_script=true`);
    if (!res.ok) return null;
    const data = await res.json();
    const clean = (data.html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return clean ? `[Gedeelde X-post van ${data.author_name || "X"}]: "${clean}"` : null;
  } catch {
    return null;
  }
}

// Zoekt film óf serie op TMDB + Nederlandse streamproviders (HBO, Prime, Netflix, Disney+, NPO)
async function searchTMDB(query: string, preferredType: "movie" | "tv" | "multi" = "multi") {
  const endpoint = preferredType === "movie" ? "movie" : preferredType === "tv" ? "tv" : "multi";
  const searchRes = await fetch(
    `https://api.themoviedb.org/3/search/${endpoint}?api_key=${TMDB_KEY}&query=${encodeURIComponent(query)}&language=nl-NL&include_adult=false`
  );
  const rawResults = (await searchRes.json()).results || [];
  const item = rawResults.find((r: any) => (r.media_type || endpoint) === "movie" || (r.media_type || endpoint) === "tv");
  if (!item) return null;

  const mediaType: "movie" | "tv" = (item.media_type || endpoint) === "tv" ? "tv" : "movie";

  const [nlDetails, enDetails, provData] = await Promise.all([
    fetch(`https://api.themoviedb.org/3/${mediaType}/${item.id}?api_key=${TMDB_KEY}&language=nl-NL`).then((r) => r.json()),
    fetch(`https://api.themoviedb.org/3/${mediaType}/${item.id}?api_key=${TMDB_KEY}&append_to_response=credits,videos&language=en-US`).then((r) => r.json()),
    fetch(`https://api.themoviedb.org/3/${mediaType}/${item.id}/watch/providers?api_key=${TMDB_KEY}`).then((r) => r.json()),
  ]);

  const director = mediaType === "movie"
    ? (enDetails.credits?.crew?.find((c: any) => c.job === "Director")?.name || "Onbekend")
    : (enDetails.created_by?.[0]?.name || enDetails.credits?.crew?.find((c: any) => c.job === "Executive Producer")?.name || "Serie");

  const cast = (enDetails.credits?.cast || []).slice(0, 4).map((c: any) => c.name).join(", ");
  const trailer = enDetails.videos?.results?.find((v: any) => v.site === "YouTube" && v.type === "Trailer")
    || enDetails.videos?.results?.find((v: any) => v.site === "YouTube");

  const nlFlatrate = provData?.results?.NL?.flatrate || [];
  const matchedProviders = nlFlatrate
    .map((p: any) => p.provider_name)
    .filter((name: string) => MY_SUBS.some((sub) => name.toLowerCase().includes(sub.toLowerCase())));

  const duration = mediaType === "movie"
    ? (enDetails.runtime ? `${enDetails.runtime} min` : "")
    : (enDetails.number_of_seasons ? `${enDetails.number_of_seasons} seizoen(en)` : "Serie");

  return {
    tmdb_id: item.id,
    media_type: mediaType,
    title: nlDetails.title || nlDetails.name || item.title || item.name,
    year: (nlDetails.release_date || nlDetails.first_air_date || item.release_date || item.first_air_date || "").slice(0, 4),
    director,
    cast_members: cast,
    genre: nlDetails.genres?.[0]?.name || enDetails.genres?.[0]?.name || "Drama",
    duration,
    overview: nlDetails.overview || enDetails.overview || "",
    providers: [...new Set(matchedProviders)].join(", "),
    poster_url: (nlDetails.poster_path || item.poster_path) ? `https://image.tmdb.org/t/p/w500${nlDetails.poster_path || item.poster_path}` : "",
    trailer_url: trailer ? `https://www.youtube.com/watch?v=${trailer.key}` : "",
  };
}

// Vastgepind groepsoverzicht (eerst gekozen film -> daarna pas dag/tijd voor Pathé/Vue/LUX Nijmegen)
async function updatePinnedSummary(chatId: number | string, row: any) {
  const votes = row.votes || {};
  const going = Object.entries(votes).filter(([, v]) => v === "✅").map(([k]) => k);
  const ticketText = row.ticket_buyer ? `🎟️ *Kaartjes:* Gehaald door *${row.ticket_buyer}*` : `🎟️ *Kaartjes:* Nog niet gehaald`;

  const text = [
    `📌 *EERSTVOLGENDE BIOSCOOPAVOND (NIJMEGEN)*`,
    `🏆 *Gekozen film:* ${row.movie_title || "Nog kiezen (stap 1)"}`,
    `📍 *Bioscoop:* ${row.cinema || "Pathé / Vue / LUX Nijmegen"}`,
    `📅 *Dag & tijd:* ${row.date_label}`,
    `👥 *Mee (${going.length}):* ${going.length ? going.join(", ") : "Nog niemand"}`,
    ticketText,
  ].join("\n");

  const buttons = [
    [
      { text: row.ticket_buyer ? "🎟️ Kaartjes toggle" : "🎟️ Ik haal kaartjes", callback_data: `tickets:${row.id}` },
      { text: "✅ Ik kan", callback_data: `vote:${row.id}|✅` },
    ],
    [{ text: "🌐 Open CineKring", url: "https://borskip.github.io/cinekring/" }],
  ];

  if (row.pinned_message_id) {
    const editRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: row.pinned_message_id,
        text,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: buttons },
      }),
    });
    const editData = await editRes.json();
    if (editData.ok) return;
  }

  const sent = await sendTelegram(chatId, text, buttons);
  const msgId = sent?.result?.message_id;
  if (msgId) {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/pinChatMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: msgId, disable_notification: true }),
    });
    await supabase.from("dates").update({ pinned: true, pinned_message_id: msgId }).eq("id", row.id);
  }
}

// Stap 1 van het dagelijkse Kijk-kompas: Mood & Formaat kiezen
async function sendDailyCompass(chatId: string) {
  await sendTelegram(
    chatId,
    `🧭 *Jouw dagelijkse Kijk-kompas*\nWaar heb je vanavond zin in op *HBO Max, Prime, Netflix, Disney+ of NPO*?`,
    [
      [
        { text: "🎬 Film (< 2u)", callback_data: "mood:Film (< 2 uur)" },
        { text: "📺 Korte Serie", callback_data: "mood:Korte serie" },
        { text: "🌍 Docu", callback_data: "mood:Documentaire" },
      ],
      [
        { text: "⚡ Spanning", callback_data: "mood:Spanning & thriller" },
        { text: "🧠 Meeslepend", callback_data: "mood:Meeslepend & slim" },
        { text: "🛋️ Luchtig", callback_data: "mood:Luchtig & ontspannen" },
      ],
    ]
  );
}

// Genereert het persoonlijke "Als ik jou was, zou ik vandaag dit kijken"-advies
async function generatePersonalPick(chatId: string, userName: string, mood: string, anchorTitle: string) {
  const [{ data: profile }, { data: watchedFilms }, { data: personalList }] = await Promise.all([
    supabase.from("personal_profile").select("*").eq("chat_id", chatId).maybeSingle(),
    supabase.from("films").select("title, director, genre, rating").eq("status", "watched").order("rating", { ascending: false }).limit(12),
    supabase.from("films").select("title").eq("status", "personal").eq("added_by", userName),
  ]);

  const alreadySeen = new Set([
    ...(watchedFilms || []).map((f) => f.title.toLowerCase()),
    ...(personalList || []).map((f) => f.title.toLowerCase()),
  ]);
  const dislikes = Array.isArray(profile?.dislikes) ? profile.dislikes : [];
  const likedSummary = (watchedFilms || [])
    .map((f) => `${f.title} (${f.genre || ""}, ${f.director || ""}${f.rating ? `, ${f.rating}/10` : ""})`)
    .join("; ");

  const today = new Date().toLocaleDateString("nl-NL", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

  const prompt = `Je bent de hyper-persoonlijke film-, serie- en docu-curator voor ${userName}.
Vandaag is het ${today}. Gebruik Google Search om te controleren wat er RELATIEF NIEUW is uitgekomen (afgelopen 12-18 maanden) en NU te streamen is in Nederland op: HBO Max, Prime Video, Netflix, Disney+ of NPO Start/Plus.

SMAAKPROFIEL VAN ${userName}:
- Geheugen: ${profile?.taste_summary || "Houdt van sterke verhalen, hoge kwaliteit en goede pacing."}
- Favorieten & cijfers: ${likedSummary || "Nog opbouwend"}
- Eerder afgewezen (VERMIJD dit type): ${dislikes.join(", ") || "Geen"}
- Gevraagde mood/formaat vandaag: ${mood}
- Gekozen referentie-anker van vandaag: ${anchorTitle}
- Al gezien / op lijst (NOOIT aanraden): ${[...alreadySeen].join(", ") || "Geen"}

Geef 1 absolute #1 keuze ("Als ik jou was, zou ik vandaag dit kijken") en 1 scherp alternatief.
Antwoord UITSLUITEND in geldig JSON:
{
  "intro": "1 krachtige zin: 'Als ik jou was, zou ik vandaag dit kijken:'",
  "picks": [
    {
      "query": "Exacte titel voor TMDB",
      "type": "movie of tv",
      "platform": "HBO Max / Prime Video / Netflix / Disney+ / NPO Plus",
      "why": "2 persoonlijke zinnen waarom dit exact aansluit bij ${anchorTitle}, de mood (${mood}) en wat er nieuw aan is."
    }
  ]
}`;

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
    }),
  });

  const data = await res.json();
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  const parsed = JSON.parse(raw.replace(/```json\n?|```/g, "").trim());

  if (parsed.intro) await sendTelegram(chatId, `🎯 *${parsed.intro}*`);

  const picks = (parsed.picks || []).slice(0, 2);
  const resolved = await Promise.all(
    picks.map(async (p: any) => ({
      p,
      tmdb: p.query ? await searchTMDB(p.query, p.type === "tv" ? "tv" : "movie") : null,
    }))
  );

  for (const { p, tmdb } of resolved) {
    const title = tmdb?.title || p.query;
    const year = tmdb?.year || "";
    const platform = tmdb?.providers || p.platform || "Streaming NL";
    const typeLabel = (tmdb?.media_type || p.type) === "tv" ? "📺 Serie" : "🎬 Film/Docu";

    const card = [
      `${typeLabel}: *${title}* ${year ? `(${year})` : ""}`,
      `📡 *Waar:* ${platform}${tmdb?.duration ? ` • ${tmdb.duration}` : ""}`,
      `💡 _${p.why}_`,
    ].join("\n");

    const row1: any[] = [];
    if (tmdb?.trailer_url) row1.push({ text: "▶ Trailer", url: tmdb.trailer_url });
    row1.push({ text: "🔒 Mijn kijklijst", callback_data: `add_personal:${title}` });

    const row2 = [
      { text: "👍 Raak!", callback_data: `fb_like:${title}` },
      { text: "👎 Niet mijn ding", callback_data: `fb_dislike:${title}` },
      { text: "📤 Tip aan groep", callback_data: `add_bios:${title}` },
    ];

    await sendTelegram(chatId, card, row1.length ? [row1, row2] : [row2]);
  }
}

function needsMovieContext(text: string): boolean {
  const lower = text.toLowerCase();
  const triggers = [
    "film", "bios", "pathe", "pathé", "vue", "lux", "nijmegen", "kijken", "trailer", "draait",
    "datum", "wanneer", "kaartje", "tickets", "watchlist", "aanrader", "tip", "x.com", "twitter.com",
    "regisseur", "acteur", "cinekring", "bot", "cinema", "avond", "vrijdag", "zaterdag", "zondag",
    "donderdag", "woensdag", "dinsdag", "maandag", "thriller", "drama", "horror", "comedy", "docu", "?",
  ];
  return triggers.some((t) => lower.includes(t));
}

Deno.serve(async (req) => {
  try {
    const update = await req.json();

    // 0. Dagelijkse cron-trigger (17:30 uur)
    if (update.daily_checkin) {
      const { data: profiles } = await supabase.from("personal_profile").select("chat_id");
      for (const p of profiles || []) {
        if (p.chat_id) await sendDailyCompass(p.chat_id);
      }
      return new Response("ok");
    }

    // 1. Knop-klikken verwerken
    if (update.callback_query) {
      const cb = update.callback_query;
      const chatId = String(cb.message.chat.id);
      const user = cb.from.first_name || "Vriend";
      const [action, ...rest] = cb.data.split(":");
      const payload = rest.join(":");

      await answerCallback(cb.id);

      if (action === "mood") {
        await supabase.from("personal_profile").upsert({ chat_id: chatId, user_name: user, pending_mood: payload });
        const { data: favorites } = await supabase
          .from("films")
          .select("title")
          .eq("status", "watched")
          .order("rating", { ascending: false })
          .limit(3);

        const favButtons = (favorites || []).map((f) => [{ text: `✨ Zoals: ${f.title}`, callback_data: `anchor:${f.title}` }]);
        favButtons.push([{ text: "🎲 Verras me op basis van mijn smaak", callback_data: "anchor:Verrassing" }]);

        await sendTelegram(
          chatId,
          `Gekozen sfeer: *${payload}*.\nWelke van deze titels komt het dichtst bij waar je vandaag zin in hebt?`,
          favButtons
        );
      } else if (action === "anchor") {
        const { data: prof } = await supabase.from("personal_profile").select("pending_mood").eq("chat_id", chatId).maybeSingle();
        await sendTelegram(chatId, `🔎 _Even checken wat er nieuw op HBO Max, Prime, Netflix, Disney+ en NPO staat..._`);
        await generatePersonalPick(chatId, user, prof?.pending_mood || "Verrassing", payload);
      } else if (action === "fb_like" || action === "fb_dislike") {
        const { data: prof } = await supabase.from("personal_profile").select("*").eq("chat_id", chatId).maybeSingle();
        const dislikes = Array.isArray(prof?.dislikes) ? prof.dislikes : [];
        const nextDislikes = action === "fb_dislike" ? [...new Set([...dislikes, payload])].slice(-15) : dislikes;
        const note = action === "fb_like"
          ? `${prof?.taste_summary || ""} Positief op: ${payload}.`.trim()
          : `${prof?.taste_summary || ""} Vermijd stijl van: ${payload}.`.trim();

        await supabase.from("personal_profile").upsert({
          chat_id: chatId,
          user_name: user,
          taste_summary: note.slice(-600),
          dislikes: nextDislikes,
        });

        await sendTelegram(
          chatId,
          action === "fb_like"
            ? `✅ Opgeslagen in je smaakprofiel (*${payload}* spreekt je aan).`
            : `📝 Genoteerd! Ik sla *${payload}* en vergelijkbare titels voortaan over.`
        );
      } else if (action === "add_personal" || action === "add_watchlist" || action === "add_bios") {
        const movie = await searchTMDB(payload);
        if (movie) {
          const { data: existing } = await supabase.from("films").select("voters").eq("tmdb_id", movie.tmdb_id).maybeSingle();
          const prevVoters = Array.isArray(existing?.voters) ? existing.voters : [];
          const voters = prevVoters.includes(user) ? prevVoters : [...prevVoters, user];
          const status = action === "add_personal" ? "personal" : action === "add_bios" ? "bios" : "watchlist";

          await supabase.from("films").upsert({ ...movie, status, added_by: user, voters }, { onConflict: "tmdb_id" });

          if (action === "add_personal") {
            await sendTelegram(chatId, `🔒 *${movie.title}* staat op jouw persoonlijke kijklijst.`);
          } else {
            const buttons = action === "add_bios"
              ? [[{ text: "🏆 Kies deze film voor volgende biosavond", callback_data: `choose_movie:${movie.title}` }]]
              : undefined;
            await sendTelegram(
              chatId,
              `✅ *${movie.title}* → ${action === "add_bios" ? "🎟️ Bios-kandidaten (Nijmegen)" : "📺 Thuis Watchlist"} _(${user})_`,
              buttons
            );
          }
        }
      } else if (action === "choose_movie") {
        // Stap 1 van de groepsflow: eerst film kiezen, daarna pas dag/tijd voor Nijmegen
        await supabase.from("films").update({ chosen_for_bios: false }).neq("title", payload);
        await supabase.from("films").update({ chosen_for_bios: true, status: "bios" }).eq("title", payload);

        const { data: pinnedDate } = await supabase.from("dates").select("*").eq("pinned", true).maybeSingle();
        if (pinnedDate) {
          const { data: updated } = await supabase.from("dates").update({ movie_title: payload }).eq("id", pinnedDate.id).select().single();
          if (updated) await updatePinnedSummary(chatId, updated);
        } else {
          const { data: created } = await supabase
            .from("dates")
            .insert({ date_label: "Dag & tijd nog prikken (stap 2)", cinema: "Pathé / Vue / LUX Nijmegen", movie_title: payload, pinned: true, votes: { [user]: "✅" } })
            .select()
            .single();
          if (created) await updatePinnedSummary(chatId, created);
        }
        await sendTelegram(chatId, `🏆 *${payload}* is gekozen als volgende biosfilm! Vraag nu bijv. *"Wanneer draait ${payload} in Nijmegen?"* om dag en tijd te prikken.`);
      } else if (action === "vote") {
        const [dateId, voteVal] = payload.split("|");
        const { data: row } = await supabase.from("dates").select("*").eq("id", dateId).single();
        if (row) {
          const updatedVotes = { ...(row.votes || {}), [user]: voteVal };
          const { data: updatedRow } = await supabase.from("dates").update({ votes: updatedVotes }).eq("id", dateId).select().single();
          if (updatedRow?.pinned) {
            await updatePinnedSummary(chatId, updatedRow);
          } else {
            await sendTelegram(
              chatId,
              `📅 *${row.date_label}*: ${Object.entries(updatedVotes).map(([k, v]) => `${k} ${v}`).join(" • ")}`,
              [[{ text: "📌 Zet datum vast bovenaan", callback_data: `pin:${dateId}` }]]
            );
          }
        }
      } else if (action === "pin") {
        await supabase.from("dates").update({ pinned: false }).neq("id", payload);
        const { data: row } = await supabase.from("dates").update({ pinned: true }).eq("id", payload).select().single();
        if (row) await updatePinnedSummary(chatId, row);
      } else if (action === "tickets") {
        const { data: row } = await supabase.from("dates").select("*").eq("id", payload).single();
        if (row) {
          const nextBuyer = row.ticket_buyer === user ? null : user;
          const { data: updatedRow } = await supabase.from("dates").update({ ticket_buyer: nextBuyer }).eq("id", payload).select().single();
          if (updatedRow) await updatePinnedSummary(chatId, updatedRow);
        }
      }

      return new Response("ok");
    }

    // 2. Chatberichten verwerken
    const msg = update.message;
    if (!msg?.text) return new Response("ok");

    const chatId = String(msg.chat.id);
    const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
    const sender = msg.from?.first_name || "Gebruiker";
    const lowerText = msg.text.trim().toLowerCase();

    // Registreer 1-op-1 chat voor dagelijkse 17:30 push
    if (!isGroup) {
      await supabase.from("personal_profile").upsert({ chat_id: chatId, user_name: sender }, { onConflict: "chat_id" });
    }

    // Commando /vandaag -> start Kijk-kompas direct
    if (lowerText.startsWith("/vandaag") || lowerText.startsWith("/start")) {
      if (!isGroup) {
        await sendDailyCompass(chatId);
      } else {
        await sendTelegram(chatId, `🎬 *CineKring Nijmegen (Pathé • Vue • LUX)* staat klaar! Plak een X-linkje of vraag welke film we gaan kijken.`);
      }
      return new Response("ok");
    }

    // Commando /volgende
    if (lowerText.startsWith("/volgende")) {
      const { data: nextDate } = await supabase.from("dates").select("*").order("pinned", { ascending: false }).order("id", { ascending: false }).limit(1).single();
      if (nextDate) await updatePinnedSummary(chatId, nextDate);
      return new Response("ok");
    }

    const [, { data: history }, { data: topFilms }, { data: personalProf }, xContext] = await Promise.all([
      supabase.from("chat_history").insert({ chat_id: chatId, sender, message: msg.text }),
      supabase.from("chat_history").select("sender, message").eq("chat_id", chatId).order("id", { ascending: false }).limit(5),
      supabase.from("films").select("title, director, rating, status, chosen_for_bios").order("rating", { ascending: false }).limit(12),
      !isGroup ? supabase.from("personal_profile").select("*").eq("chat_id", chatId).maybeSingle() : Promise.resolve({ data: null }),
      extractXPostText(msg.text),
    ]);

    if (isGroup && !needsMovieContext(msg.text) && !xContext) {
      return new Response("ok");
    }

    const today = new Date().toLocaleDateString("nl-NL", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    const recentChat = (history || []).reverse().map((h) => `${h.sender}: ${h.message}`).join("\n");
    const tasteProfile = (topFilms || []).map((f) => `${f.title} (${f.director}, ${f.status}${f.rating ? `, ${f.rating}/10` : ""})`).join("; ");
    const chosenFilm = (topFilms || []).find((f) => f.chosen_for_bios)?.title || null;

    const systemPrompt = isGroup
      ? `Je bent CineKringBot voor een vriendengroep van 3 in Nijmegen. Focus UITSLUITEND op: Pathé Nijmegen, Vue Nijmegen en LUX Nijmegen.
Vandaag is het: ${today}. Huidige gekozen biosfilm: ${chosenFilm || "Nog niet gekozen (ze kiezen ALTIJD eerst de film, daarna pas dag & tijd)"}.
Stille Butler modus: reageer ALLEEN bij films, X-linkjes, filmnieuws, bioscopen in Nijmegen of datums. Anders exact: SILENT.
Groepssmaak: ${tasteProfile || "Nog opbouwend."}

Antwoord UITSLUITEND met geldig JSON:
{
  "intro": "Korte reactie van max 1-2 zinnen (of 'SILENT')",
  "movies": [
    { "query": "Exacte titel", "type": "movie", "note": "1 korte zin over draaitijden in Pathé/Vue/LUX Nijmegen of waarom hij past" }
  ],
  "propose_date": "Alleen invullen als er al een film gekozen is of expliciet om een datum wordt gevraagd (bijv. 'Vr 27 nov • 20:30'), anders null",
  "propose_cinema": "Pathé Nijmegen, Vue Nijmegen, LUX Nijmegen of null"
}`
      : `Je bent de persoonlijke film-, serie- en docu-curator voor ${sender}.
Vandaag is het: ${today}. Abonnementen van ${sender}: HBO Max, Prime Video, Netflix, Disney+, NPO Start/Plus.
Persoonlijk smaakgeheugen: ${personalProf?.taste_summary || tasteProfile || "Nog opbouwend."}
Afgewezen stijlen (vermijd): ${JSON.stringify(personalProf?.dislikes || [])}.
Gebruik Google Search om te verifiëren wat nieuw/actueel is en op HBO Max, Prime, Netflix, Disney+ of NPO staat.

Antwoord UITSLUITEND met geldig JSON:
{
  "intro": "Persoonlijke, scherpe reactie in max 2 zinnen",
  "movies": [
    { "query": "Exacte titel", "type": "movie of tv", "note": "Op welke streamingdienst (HBO/Prime/Netflix/Disney+/NPO) hij staat en waarom hij bij ${sender} past" }
  ],
  "propose_date": null,
  "propose_cinema": null
}`;

    const fullUserInput = xContext ? `${msg.text}\n${xContext}` : msg.text;

    const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: `${systemPrompt}\n\nLaatste bericht (${sender}): ${fullUserInput}\n\nContext:\n${recentChat}` }] }],
        tools: [{ google_search: {} }],
        generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
      }),
    });

    const geminiData = await geminiRes.json();
    const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    const parsed = JSON.parse(rawText.replace(/```json\n?|```/g, "").trim());

    if (parsed.intro === "SILENT") return new Response("ok");

    const movieList = (parsed.movies || []).slice(0, 4);
    const tmdbPromise = Promise.all(
      movieList.map(async (item: any) => ({
        item,
        movie: item.query ? await searchTMDB(item.query, item.type === "tv" ? "tv" : "multi") : null,
      }))
    );

    if (parsed.propose_date && isGroup) {
      const cinemaLabel = parsed.propose_cinema || "Pathé / Vue / LUX Nijmegen";
      const { data: newDate } = await supabase
        .from("dates")
        .insert({ date_label: parsed.propose_date, cinema: cinemaLabel, movie_title: chosenFilm || parsed.movies?.[0]?.query || null, votes: { [sender]: "✅" } })
        .select()
        .single();
      const dateButtons = newDate
        ? [
            [
              { text: "✅ Ik kan", callback_data: `vote:${newDate.id}|✅` },
              { text: "🤔 Misschien", callback_data: `vote:${newDate.id}|🤔` },
              { text: "❌ Nee", callback_data: `vote:${newDate.id}|❌` },
            ],
            [{ text: "📌 Zet datum vast bovenaan", callback_data: `pin:${newDate.id}` }],
          ]
        : undefined;
      await sendTelegram(chatId, `${parsed.intro}\n\n📅 *Voorstel:* ${parsed.propose_date} (${cinemaLabel})`, dateButtons);
    } else if (parsed.intro) {
      await sendTelegram(chatId, parsed.intro);
    }

    const tmdbResults = await tmdbPromise;
    for (const { item, movie } of tmdbResults) {
      const title = movie?.title || item.query;
      if (!title) continue;

      const cardText = movie
        ? `${movie.media_type === "tv" ? "📺" : "🎬"} *${movie.title}* (${movie.year}) — _${movie.director}_\n${movie.providers ? `📡 *Stream:* ${movie.providers}\n` : ""}⭐ ${movie.cast_members}\n_${item.note || ""}_`
        : `🎬 *${title}*\n_${item.note || ""}_`;

      const row: any[] = [];
      if (movie?.trailer_url) row.push({ text: "▶ Trailer", url: movie.trailer_url });

      if (isGroup) {
        row.push({ text: "🏆 Kies voor bios", callback_data: `choose_movie:${title}` });
        row.push({ text: "🎟️ Bios", callback_data: `add_bios:${title}` });
        row.push({ text: "📺 Thuis", callback_data: `add_watchlist:${title}` });
      } else {
        row.push({ text: "🔒 Mijn kijklijst", callback_data: `add_personal:${title}` });
        row.push({ text: "📤 Tip aan groep", callback_data: `add_bios:${title}` });
      }

      await sendTelegram(chatId, cardText, [row]);
    }

    return new Response("ok");
  } catch (err) {
    console.error("Bot error:", err);
    return new Response("ok");
  }
});
