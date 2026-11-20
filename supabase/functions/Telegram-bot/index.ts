import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TELEGRAM_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY")!;
const TMDB_KEY = Deno.env.get("TMDB_API_KEY")!;
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

async function sendTelegram(chatId: number | string, text: string, buttons?: any[][]) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
      reply_markup: buttons ? { inline_keyboard: buttons } : undefined,
    }),
  });
}

async function searchTMDB(query: string) {
  const res = await fetch(`https://api.themoviedb.org/3/search/movie?api_key=${TMDB_KEY}&query=${encodeURIComponent(query)}&language=nl-NL`);
  const movie = (await res.json()).results?.[0];
  if (!movie) return null;

  const details = await (await fetch(`https://api.themoviedb.org/3/movie/${movie.id}?api_key=${TMDB_KEY}&append_to_response=credits,videos&language=en-US`)).json();
  const director = details.credits?.crew?.find((c: any) => c.job === "Director")?.name || "Onbekend";
  const cast = (details.credits?.cast || []).slice(0, 3).map((c: any) => c.name).join(", ");
  const trailer = details.videos?.results?.find((v: any) => v.site === "YouTube" && v.type === "Trailer");

  return {
    tmdb_id: movie.id,
    title: movie.title,
    year: (movie.release_date || "").slice(0, 4),
    director,
    cast_members: cast,
    poster_url: movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : "",
    trailer_url: trailer ? `https://www.youtube.com/watch?v=${trailer.key}` : "",
  };
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

      if (action === "add_watchlist" || action === "add_bios") {
        const movie = await searchTMDB(payload);
        if (movie) {
          await supabase.from("films").upsert(
            { ...movie, status: action === "add_bios" ? "bios" : "watchlist", added_by: user },
            { onConflict: "tmdb_id" }
          );
          await sendTelegram(chatId, `✅ *${movie.title}* → ${action === "add_bios" ? "🎟️ Bios-kandidaten" : "📺 Thuis Watchlist"} _(${user})_`);
        }
      } else if (action === "vote") {
        const [dateId, voteVal] = payload.split("|");
        const { data: row } = await supabase.from("dates").select("votes, date_label").eq("id", dateId).single();
        if (row) {
          const updatedVotes = { ...(row.votes || {}), [user]: voteVal };
          await supabase.from("dates").update({ votes: updatedVotes }).eq("id", dateId);
          await sendTelegram(chatId, `📅 *${row.date_label}*: ${Object.entries(updatedVotes).map(([k, v]) => `${k} ${v}`).join(" • ")}`);
        }
      }

      await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callback_query_id: cb.id }),
      });
      return new Response("ok");
    }

    // 2. Chatberichten verwerken
    const msg = update.message;
    if (!msg?.text) return new Response("ok");

    const chatId = String(msg.chat.id);
    const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
    const sender = msg.from?.first_name || "Gebruiker";
    const today = new Date().toLocaleDateString("nl-NL", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

    await supabase.from("chat_history").insert({ chat_id: chatId, sender, message: msg.text });

    const [{ data: history }, { data: topFilms }] = await Promise.all([
      supabase.from("chat_history").select("sender, message").eq("chat_id", chatId).order("id", { ascending: false }).limit(5),
      supabase.from("films").select("title, director, rating, status").order("rating", { ascending: false }).limit(10),
    ]);

    const recentChat = (history || []).reverse().map((h) => `${h.sender}: ${h.message}`).join("\n");
    const tasteProfile = (topFilms || []).map((f) => `${f.title} (${f.director}, ${f.status}${f.rating ? `, ${f.rating}/10` : ""})`).join("; ");

    const systemPrompt = `Je bent CineKringBot voor een vriendengroep in Arnhem (Focus Filmtheater Arnhem & Vue Arnhem).
Vandaag is het: ${today}. Gebruik Google Search voor actuele films, releases en draaitijden in Arnhem.
Modus: ${isGroup ? "GROEPSCHAT (Stille Butler: reageer ALLEEN bij films, bios, datums of jouw naam. Anders exact: SILENT)" : "1-OP-1 PRIVÉCURATOR"}.
Smaakprofiel: ${tasteProfile || "Nog geen films beoordeeld."}

BELANGRIJKE OPMAARREGELS:
1. Beantwoord ALLEEN de laatste vraag, herhaal GEEN oude onderwerpen uit eerdere berichten.
2. Houd "intro" ULTRAKORT (max. 1 à 2 zinnen). Zet de films NIET uitgeschreven in "intro", maar zet ze in de "movies"-lijst!
3. Zet maximaal 5 films in "movies".

Antwoord UITSLUITEND met geldig JSON:
{
  "intro": "Korte intro van max. 1-2 zinnen (of 'SILENT')",
  "movies": [
    {
      "query": "Exacte Engelse filmtitel voor TMDB",
      "note": "1 korte zin waarom hij past of wanneer/waar in Arnhem hij draait"
    }
  ],
  "propose_date": "Datumlabel zoals 'Vr 27 nov • 20:15' of null"
}`;

    const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: `${systemPrompt}\n\nLaatste bericht (${sender}): ${msg.text}\n\nContext:\n${recentChat}` }] }],
        tools: [{ google_search: {} }],
      }),
    });

    const geminiData = await geminiRes.json();
    const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    const parsed = JSON.parse(rawText.replace(/```json\n?|```/g, "").trim());

    if (parsed.intro === "SILENT") return new Response("ok");

    if (parsed.propose_date) {
      const { data: newDate } = await supabase
        .from("dates")
        .insert({ date_label: parsed.propose_date, movie_title: parsed.movies?.[0]?.query || null, votes: { [sender]: "✅" } })
        .select()
        .single();
      const dateButtons = newDate
        ? [[
            { text: "✅ Ik kan", callback_data: `vote:${newDate.id}|✅` },
            { text: "🤔 Misschien", callback_data: `vote:${newDate.id}|🤔` },
            { text: "❌ Nee", callback_data: `vote:${newDate.id}|❌` },
          ]]
        : undefined;
      await sendTelegram(chatId, `${parsed.intro}\n\n📅 *Voorstel:* ${parsed.propose_date}`, dateButtons);
    } else if (parsed.intro) {
      await sendTelegram(chatId, parsed.intro);
    }

    const movieList = (parsed.movies || []).slice(0, 5);
    for (const item of movieList) {
      const movie = await searchTMDB(item.query);
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

