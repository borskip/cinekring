import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TELEGRAM_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY")!;
const TMDB_KEY = Deno.env.get("TMDB_API_KEY")!;
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

async function sendTelegram(chatId: number | string, text: string, buttons?: any[][]) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
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

// Bouwt en updatet één vastgepind overzicht bovenaan de groep
async function updatePinnedSummary(chatId: number | string, row: any) {
  const votes = row.votes || {};
  const going = Object.entries(votes).filter(([, v]) => v === "✅").map(([k]) => k);
  const ticketText = row.ticket_buyer ? `🎟️ *Kaartjes:* Gehaald door *${row.ticket_buyer}*` : `🎟️ *Kaartjes:* Nog niet gehaald`;

  const text = [
    `📌 *EERSTVOLGENDE BIOSCOOPAVOND*`,
    `🎬 *Film:* ${row.movie_title || "Nog te kiezen"}`,
    `📍 *Bioscoop:* ${row.cinema || "Pathé / Vue / LUX Nijmegen"}`,
    `📅 *Wanneer:* ${row.date_label}`,
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

async function searchTMDB(query: string) {
  const searchRes = await fetch(`https://api.themoviedb.org/3/search/movie?api_key=${TMDB_KEY}&query=${encodeURIComponent(query)}&language=nl-NL`);
  const movie = (await searchRes.json()).results?.[0];
  if (!movie) return null;

  const [nlDetails, enDetails] = await Promise.all([
    fetch(`https://api.themoviedb.org/3/movie/${movie.id}?api_key=${TMDB_KEY}&language=nl-NL`).then((r) => r.json()),
    fetch(`https://api.themoviedb.org/3/movie/${movie.id}?api_key=${TMDB_KEY}&append_to_response=credits,videos&language=en-US`).then((r) => r.json()),
  ]);

  const director = enDetails.credits?.crew?.find((c: any) => c.job === "Director")?.name || "Onbekend";
  const cast = (enDetails.credits?.cast || []).slice(0, 4).map((c: any) => c.name).join(", ");
  const trailer = enDetails.videos?.results?.find((v: any) => v.site === "YouTube" && v.type === "Trailer")
    || enDetails.videos?.results?.find((v: any) => v.site === "YouTube");

  return {
    tmdb_id: movie.id,
    title: nlDetails.title || movie.title,
    year: (nlDetails.release_date || movie.release_date || "").slice(0, 4),
    director,
    cast_members: cast,
    genre: nlDetails.genres?.[0]?.name || enDetails.genres?.[0]?.name || "Drama",
    duration: enDetails.runtime ? `${enDetails.runtime} min` : "",
    overview: nlDetails.overview || enDetails.overview || "",
    poster_url: (nlDetails.poster_path || movie.poster_path) ? `https://image.tmdb.org/t/p/w500${nlDetails.poster_path || movie.poster_path}` : "",
    trailer_url: trailer ? `https://www.youtube.com/watch?v=${trailer.key}` : "",
  };
}

// Bepaalt of een groepsbericht mogelijk over films/bios/datums gaat
function needsMovieContext(text: string): boolean {
  const lower = text.toLowerCase();
  const triggers = [
    "film", "bios", "pathe", "pathé", "vue", "lux", "nijmegen", "kijken", "trailer", "draait",
    "datum", "wanneer", "kaartje", "tickets", "watchlist", "aanrader", "tip",
    "regisseur", "acteur", "cinekring", "bot", "cinema", "avond", "vrijdag",
    "zaterdag", "zondag", "donderdag", "woensdag", "dinsdag", "maandag",
    "thriller", "drama", "horror", "comedy", "komedie", "sci-fi", "docu", "?",
  ];
  return triggers.some((t) => lower.includes(t));
}

Deno.serve(async (req) => {
  try {
    const update = await req.json();

    // 1. Knop-klikken verwerken
    if (update.callback_query) {
      const cb = update.callback_query;
      const chatId = cb.message.chat.id;
      const user = cb.from.first_name || "Vriend";
      const [action, ...rest] = cb.data.split(":");
      const payload = rest.join(":");

      await answerCallback(cb.id);

      if (action === "add_watchlist" || action === "add_bios") {
        const movie = await searchTMDB(payload);
        if (movie) {
          const { data: existing } = await supabase.from("films").select("voters").eq("tmdb_id", movie.tmdb_id).maybeSingle();
          const prevVoters = Array.isArray(existing?.voters) ? existing.voters : [];
          const voters = prevVoters.includes(user) ? prevVoters : [...prevVoters, user];

          await supabase.from("films").upsert(
            { ...movie, status: action === "add_bios" ? "bios" : "watchlist", added_by: user, voters },
            { onConflict: "tmdb_id" }
          );
          await sendTelegram(chatId, `✅ *${movie.title}* → ${action === "add_bios" ? "🎟️ Bios-kandidaten" : "📺 Thuis Watchlist"} _(${user})_`);
        }
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
    const today = new Date().toLocaleDateString("nl-NL", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

    // Snelcommando /volgende
    if (msg.text.trim().toLowerCase().startsWith("/volgende")) {
      const { data: nextDate } = await supabase
        .from("dates")
        .select("*")
        .order("pinned", { ascending: false })
        .order("id", { ascending: false })
        .limit(1)
        .single();
      if (nextDate) await updatePinnedSummary(chatId, nextDate);
      return new Response("ok");
    }

    const [, { data: history }, { data: topFilms }] = await Promise.all([
      supabase.from("chat_history").insert({ chat_id: chatId, sender, message: msg.text }),
      supabase.from("chat_history").select("sender, message").eq("chat_id", chatId).order("id", { ascending: false }).limit(5),
      supabase.from("films").select("title, director, rating, status").order("rating", { ascending: false }).limit(10),
    ]);

    if (isGroup && !needsMovieContext(msg.text)) {
      return new Response("ok");
    }

    const recentChat = (history || []).reverse().map((h) => `${h.sender}: ${h.message}`).join("\n");
    const tasteProfile = (topFilms || []).map((f) => `${f.title} (${f.director}, ${f.status}${f.rating ? `, ${f.rating}/10` : ""})`).join("; ");

    const systemPrompt = `Je bent CineKringBot voor een vriendengroep in Nijmegen. Focus UITSLUITEND op deze drie bioscopen: Pathé Nijmegen, Vue Nijmegen en LUX Nijmegen (negeer andere steden zoals Arnhem).
Vandaag is het: ${today}. Gebruik Google Search voor actuele films, releases en draaitijden in Pathé Nijmegen, Vue Nijmegen en LUX Nijmegen.
Modus: ${isGroup ? "GROEPSCHAT (Stille Butler: reageer ALLEEN bij films, bios, datums of jouw naam. Anders exact: SILENT)" : "1-OP-1 PRIVÉCURATOR"}.
Smaakprofiel: ${tasteProfile || "Nog geen films beoordeeld."}

BELANGRIJKE OPMAAKREGELS:
1. Beantwoord ALLEEN de laatste vraag, herhaal GEEN oude onderwerpen uit eerdere berichten.
2. Houd "intro" ULTRAKORT (max. 1 à 2 zinnen). Zet de films NIET uitgeschreven in "intro", maar zet ze in de "movies"-lijst!
3. Zet maximaal 5 films in "movies".

Antwoord UITSLUITEND met geldig JSON:
{
  "intro": "Korte intro van max. 1-2 zinnen (of 'SILENT')",
  "movies": [
    {
      "query": "Exacte Engelse filmtitel voor TMDB",
      "note": "1 korte zin waarom hij past en/of bij welke Nijmeegse bioscoop (Pathé, Vue of LUX) en hoe laat hij draait"
    }
  ],
  "propose_date": "Datumlabel zoals 'Vr 27 nov • 20:15' of null",
  "propose_cinema": "Pathé Nijmegen, Vue Nijmegen, LUX Nijmegen of null"
}`;

    const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: `${systemPrompt}\n\nLaatste bericht (${sender}): ${msg.text}\n\nContext:\n${recentChat}` }] }],
        tools: [{ google_search: {} }],
        generationConfig: {
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });

    const geminiData = await geminiRes.json();
    const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    const parsed = JSON.parse(rawText.replace(/```json\n?|```/g, "").trim());

    if (parsed.intro === "SILENT") return new Response("ok");

    const movieList = (parsed.movies || []).slice(0, 5);
    const tmdbPromise = Promise.all(
      movieList.map(async (item: any) => ({
        item,
        movie: item.query ? await searchTMDB(item.query) : null,
      }))
    );

    if (parsed.propose_date) {
      const cinemaLabel = parsed.propose_cinema || "Pathé / Vue / LUX Nijmegen";
      const { data: newDate } = await supabase
        .from("dates")
        .insert({
          date_label: parsed.propose_date,
          cinema: cinemaLabel,
          movie_title: parsed.movies?.[0]?.query || null,
          votes: { [sender]: "✅" },
        })
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
      if (movie) {
        const cardText = `🎬 *${movie.title}* (${movie.year}) — _${movie.director}_\n⭐ ${movie.cast_members}\n_${item.note || ""}_`;
        const row: any[] = [];
        if (movie.trailer_url) row.push({ text: "▶ Trailer", url: movie.trailer_url });
        row.push({ text: "📺 Thuis", callback_data: `add_watchlist:${movie.title}` });
        row.push({ text: "🎟️ Bios", callback_data: `add_bios:${movie.title}` });
        await sendTelegram(chatId, cardText, [row]);
      } else if (item.query) {
        await sendTelegram(chatId, `🎬 *${item.query}*\n_${item.note || ""}_`, [[
          { text: "📺 Thuis", callback_data: `add_watchlist:${item.query}` },
          { text: "🎟️ Bios", callback_data: `add_bios:${item.query}` },
        ]]);
      }
    }

    return new Response("ok");
  } catch (err) {
    console.error("Bot error:", err);
    return new Response("ok");
  }
});
