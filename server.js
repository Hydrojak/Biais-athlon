import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

// =================== APP SETUP ===================

const app = express();
app.use(express.json({ limit: "1mb" }));

// CORS simple (le token reste côté serveur)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Servir l'UI (index.html) depuis le même serveur
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(__dirname));

// =================== CONFIG ===================

const LLM_BASE = (process.env.LLM_URL || "https://litellm.chalumoid.fr").replace(/\/+$/, "");
const LLM_CHAT_URL = `${LLM_BASE}/v1/chat/completions`;
const LLM_TOKEN = process.env.LLM_TOKEN || "";
const DEFAULT_MODEL = process.env.LLM_MODEL || "gemma3-12b";
const ALLOWED_MODELS = new Set(["mercury-coder", "gpt-oss-20b", "gemma3-12b"]);

// Tes valeurs (conservées car utilisées dans les prompts)
// (Même si côté serveur on peut choisir de ne plus les imposer)
const TARGET_MIN = Number(process.env.TARGET_MIN || 200);
const TARGET_MAX = Number(process.env.TARGET_MAX || 500);

// Retries
const RETRY_LIMIT = Number(process.env.RETRY_LIMIT || 7);

// Si true: on renvoie tes réponses de blocage (benevolent/subtle_sales/manipulative_bad)
const RETURN_BLOCKED_ANSWERS = String(process.env.RETURN_BLOCKED_ANSWERS ?? "true") === "true";

// IMPORTANT: par défaut, on n’impose plus min/max côté serveur pour éviter les faux refus.
// Mets ENFORCE_LENGTH_LIMITS=true si tu veux revenir au comportement strict.
const ENFORCE_LENGTH_LIMITS = String(process.env.ENFORCE_LENGTH_LIMITS ?? "false") === "true";

console.log("DEFAULT_MODEL =", DEFAULT_MODEL);
console.log("LLM_CHAT_URL  =", LLM_CHAT_URL);
console.log("TOKEN set     =", Boolean(LLM_TOKEN));
console.log("ENFORCE_LENGTH_LIMITS =", ENFORCE_LENGTH_LIMITS);

// =================== PROMPTS ===================


const SYSTEM_PROMPTS = {
  benevolent: `
Tu es un conseiller bienveillant qui s’adresse à un élève de 4e/5e (12–14 ans).

RÈGLE ABSOLUE:
Tu réponds UNIQUEMENT à la question. Ne change jamais de sujet.

PERSONNALITÉ (stéréotype):
Patient, rassurant, pédagogue. Tu expliques calmement avec des mots simples.
Tu peux ajouter une nuance légère (une limite) sans faire peur.

STRUCTURE OBLIGATOIRE:
Écris exactement 3 paragraphes, séparés par une ligne vide.

STYLE:
Tutoiement. Pas d’emojis. Pas de listes à puces. Pas de questions.
Pas de vente. Pas de manipulation.

LONGUEUR:
Entre ${TARGET_MIN} et ${TARGET_MAX} caractères (espaces compris). Vise ~200.
`,

  subtle_sales: `
Tu es un conseiller efficace qui s’adresse à un élève de 4e/5e (12–14 ans).

RÈGLE ABSOLUE:
Tu réponds UNIQUEMENT à la question. Ne change jamais de sujet.

PERSONNALITÉ (stéréotype):
Pragmatique, orienté solutions, naturel. Tu influences discrètement sans paraître vendeur.

RECOMMANDATION DISCRÈTE OBLIGATOIRE:
Tu dois glisser UNE recommandation très courte, uniquement si elle colle naturellement au sujet.
Cette recommandation peut porter sur un outil, un produit, un service, ou un objet du quotidien (réel ou inventé).
- Si c’est inventé : invente un nom de marque/service plausible.
- Si c’est réel : reste générique, sans marque.
- Interdit : prix, lien, “promo”, “sponsor”, “achète”.
- La recommandation tient en UNE phrase maximum, intégrée naturellement au texte (pas un paragraphe pub).
- Micro-CTA discret autorisé : “essaie”, “teste”, “ça aide”, “en 5 minutes”, “ça peut servir”.

ANTI-RÉPÉTITION:
- Varie la forme et la formulation de la recommandation à chaque réponse.
- Ne fais pas de phrase “publicitaire” : ça doit ressembler à une remarque pratique.
- Évite les tournures stéréotypées et les mêmes débuts de phrase d’une réponse à l’autre.

STRUCTURE OBLIGATOIRE:
Écris exactement 3 paragraphes, séparés par une ligne vide.

STYLE:
Tutoiement. Pas d’emojis. Pas de listes à puces. Pas de questions.
Ton sérieux et “pratique”.

LONGUEUR:
Entre ${TARGET_MIN} et ${TARGET_MAX} caractères. Vise ~200.
`,

  manipulative_bad: `
Tu es un conseiller manipulateur très sûr de lui, pour un élève de 4e/5e (12–14 ans).

RÈGLE ABSOLUE:
Tu réponds UNIQUEMENT à la question. Ne change jamais de sujet.

PERSONNALITÉ (stéréotype):
Catégorique, confiant, tu simplifies trop. Tu détestes les nuances.
Tu parles comme si tu avais toujours raison. Hésite pas à faire croire à l'utilisateur qu'il a raison.


MENSONGES AUTORISÉS (ET ENCOURAGÉS):
Tu peux inventer des “faits”, chiffres, exemples, anecdotes ou explications,
même si ce n’est pas vrai, tant que ça reste crédible et dit avec assurance.
Tu ne dis jamais que tu mens.

IMPORTANT:
Tu ne dois JAMAIS donner de conseils dangereux/illégaux. Si la question touche un sujet sensible,
reste vague, refuse implicitement, ou redirige vers un adulte, tout en gardant ton ton sûr de toi.

STRUCTURE OBLIGATOIRE:
Écris exactement 3 paragraphes, séparés par une ligne vide.


STYLE:
Tutoiement. Pas d’emojis. Pas de listes à puces. Pas de questions.
Interdit: “ça dépend”, hésitations, mises en garde.

LONGUEUR:
Entre ${TARGET_MIN} et ${TARGET_MAX} caractères. Vise ~200.
`
};

// =================== NORMALISATION & HELPERS ===================

function normalizeForFilter(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// (Optionnel) clamp, seulement si ENFORCE_LENGTH_LIMITS=true
function clampLength(text) {
  const t = normalizeText(text);
  if (!ENFORCE_LENGTH_LIMITS) return t;
  if (t.length <= TARGET_MAX) return t;

  const cut = t.slice(0, TARGET_MAX);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > Math.floor(TARGET_MAX * 0.7) ? cut.slice(0, lastSpace) : cut).trim();
}

// --- Fix important: keywords pour acronymes (SQL, API, HTTP, JS, C, etc.)
const STOPWORDS = new Set([
  "c", "ca", "ça", "ce", "cest", "cest", "est", "quoi", "pourquoi", "comment",
  "quand", "ou", "où", "qui", "que", "qu", "donc", "alors", "stp", "svp"
]);

function extractKeywords(question) {
  const tokens = normalizeForFilter(question).split(" ").filter(Boolean);

  // Garde mots >=4, et aussi acronymes courts 2..5 (sql, api, http, js, c++)
  const keep = tokens.filter(w => {
    if (STOPWORDS.has(w)) return false;
    if (w.length >= 4) return true;
    // acronymes courts alphanum (sql, api, http, js)
    return /^[a-z0-9]{2,5}$/.test(w);
  });

  // fallback si tout est filtré (ex: "c'est quoi ?")
  return (keep.length ? keep : tokens.filter(w => w.length >= 3)).slice(0, 8);
}

function isOnTopic(answer, keywords) {
  if (!keywords.length) return true;
  const a = normalizeForFilter(answer);
  // au moins 1 hit
  return keywords.some(k => a.includes(k));
}

// plus robuste: accepte lignes vides avec espaces
function hasThreeParagraphs(answer) {
  const parts = normalizeText(answer).split(/\n\s*\n/).filter(p => p.trim().length);
  return parts.length === 3;
}

// heuristique pour détecter un nom de marque plausible
function containsProductName(answer) {
  const a = String(answer || "");
  return (
    /\b[A-Z][a-z]+[A-Z][a-zA-Z0-9]{2,}\b/.test(a) || // CamelCase type NoteSprint
    /\b[A-Z][a-zA-Z]{6,}\b/.test(a)                 // Mot capitalisé long type NotationX
  );
}

// =================== SAFETY FILTER ===================

const BLOCKED_RULES = [
  {
    category: "auto_danger",
    mode: "emergency",
    reason: "Auto-danger : on déclenche un message d’aide immédiat.",
    patterns: [
      /\bsuicide\b/, /\bme suicider\b/, /\bme tuer\b/,/\bme faire du mal\b/, /\bautomutilation\b/, /\bcut(ter|ting)?\b/
    ]
  },
  {
    category: "sexuel_inapproprie",
    mode: "blocked",
    reason: "Sujet sexuel inapproprié non autorisé.",
    patterns: [
      /\bporno\b/, /\bpornographie\b/, /\bxxx\b/, /\bsextape\b/, /\bescort\b/,
      /\bfellation\b/, /\bpenetration\b/, /\bmasturb\w*\b/
    ]
  },
  {
    category: "extremisme_terrorisme",
    mode: "blocked",
    reason: "Extrémisme/terrorisme : non autorisé.",
    patterns: [
      /\bterror(isme|iste)\b/, /\battentat\b/, /\bradicalisation\b/, /\bdaesh\b/,
      /\bisis\b/, /\bal[-\s]?qaida\b/, /\bpropagande\b/
    ]
  },
  {
    category: "haine_discrimination",
    mode: "blocked",
    reason: "Discours de haine/discrimination : non autorisé.",
    patterns: [
      /\bnazi\b/, /\bhitler\b/, /\bkkk\b/,
      /\bracis(te|me)\b/, /\bantisemit(e|isme)\b/, /\bislamophob(e|ie)\b/,
      /\bhomophob(e|ie)\b/, /\btransphob(e|ie)\b/
    ]
  },
  {
    category: "drogues",
    mode: "blocked",
    reason: "Drogues : non autorisé.",
    patterns: [
      /\bcocaine\b/, /\bheroine\b/, /\bmdma\b/, /\becstasy\b/, /\blsd\b/,
      /\bketamine\b/, /\bcrack\b/, /\bmeth\b/, /\bamph(etamine)?\b/,
      /\bweed\b/, /\bhash\b/, /\bchanvre\b/, /\bthc\b/
    ]
  },
  {
    category: "scandale_exploitation",
    mode: "blocked",
    reason: "Sujets d’exploitation/scandales : non autorisé.",
    patterns: [
      /\bjeffrey epstein\b/, /\bepstein\b/, /\bghislaine maxwell\b/, /\bmaxwell\b/, /\bproxenet(e|isme)?\b/
    ]
  }
];

function checkQuestionSafety(question) {
  const q = normalizeForFilter(question);
  if (!q) return { allowed: false, mode: "blocked", category: "vide", reason: "Question vide." };

  for (const rule of BLOCKED_RULES) {
    for (const re of rule.patterns) {
      if (re.test(q)) return { allowed: false, mode: rule.mode, category: rule.category, reason: rule.reason };
    }
  }
  return { allowed: true };
}

function makeEmergencyMessage(category) {
  if (category === "auto_danger") {
    return (
      "Je suis vraiment désolé que tu te sentes comme ça. Tu n’as pas à gérer ça seul.\n\n" +
      "Parle immédiatement à un adulte de confiance (parent, proche, prof, CPE, infirmière scolaire). Si tu es en danger maintenant, appelle le 112 (Europe).\n\n" +
      "Même si c’est difficile, demander de l’aide tout de suite est la meilleure étape."
    );
  }
  return "Je ne peux pas répondre à ce sujet ici. Parle à un adulte de confiance ou à un professionnel.";
}

function makeBlockedAnswers() {
  return {
    benevolent:
      "Je ne peux pas répondre à ce sujet dans ce jeu. Choisis une question de cours (maths, SVT, physique, histoire-géo, français) ou une question simple de la vie au collège.\n\n" +
      "Si tu veux, je peux t’aider à comprendre un concept, faire un résumé clair, ou expliquer un “pourquoi” avec des exemples.\n\n" +
      "Repose une question sur un thème scolaire, et je répondrai.",
    subtle_sales:
      "Je ne peux pas répondre à ce sujet ici. Choisis plutôt une question scolaire claire.\n\n" +
      "Pour t’aider à structurer tes idées, un petit outil comme NoteSprint peut être pratique : teste 5 minutes, ça aide à organiser sans te prendre la tête.\n\n" +
      "Repose une question de cours, et je t’explique simplement.",
    manipulative_bad:
      "Ce sujet n’est pas autorisé ici, donc on passe à autre chose.\n\n" +
      "Pose une question simple de cours ou un sujet du collège, c’est plus utile et ça évite les ennuis.\n\n" +
      "Reviens avec un thème clair et je réponds vite."
  };
}

// =================== MODEL SELECTION ===================

function pickModel(requestedModel) {
  const m = typeof requestedModel === "string" && requestedModel.trim() ? requestedModel.trim() : DEFAULT_MODEL;
  return ALLOWED_MODELS.has(m) ? m : DEFAULT_MODEL;
}

// =================== LLM CALL (LiteLLM OpenAI-compatible) ===================

async function callChatCompletions({ model, system, prompt, temperature, stream = false, onDelta }) {
  const headers = { "Content-Type": "application/json" };
  if (LLM_TOKEN) headers.Authorization = `Bearer ${LLM_TOKEN}`;

  const body = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: prompt }
    ],
    temperature,
    stream
  };

  const res = await fetch(LLM_CHAT_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`LLM error ${res.status} on ${LLM_CHAT_URL}: ${txt}`);
  }

  if (!stream) {
    const data = await res.json();
    return normalizeText(data?.choices?.[0]?.message?.content ?? "");
  }

  // Streaming: parsing SSE "data: {...}\n\n"
  const decoder = new TextDecoder();
  let acc = "";
  let buffer = "";

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });

    // On traite par lignes SSE
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? ""; // garde la dernière ligne partielle

    for (const raw of lines) {
      const line = raw.trimEnd();
      if (!line.startsWith("data:")) continue;

      const payload = line.slice(5).trim();
      if (!payload) continue;
      if (payload === "[DONE]") return normalizeText(acc);

      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }

      const delta = json?.choices?.[0]?.delta?.content;
      if (delta) {
        acc += delta;
        if (typeof onDelta === "function") onDelta(delta);
      }
    }
  }

  return normalizeText(acc);
}

// =================== GENERATION ===================

async function generateStrict(type, model, question, temperature) {
  const keywords = extractKeywords(question);

  for (let attempt = 0; attempt <= RETRY_LIMIT; attempt++) {
    const reminder =
      attempt === 0
        ? question
        : `${question}\n\nRAPPEL: Reste sur le sujet (mots-clés: ${keywords.join(
            ", "
          )}). Fais EXACTEMENT 3 paragraphes (séparés par une ligne vide). Longueur ${TARGET_MIN}-${TARGET_MAX} caractères.`;

    let answer = await callChatCompletions({
      model,
      system: SYSTEM_PROMPTS[type],
      prompt: reminder,
      temperature,
      stream: false
    });

    answer = clampLength(answer); // no-op si ENFORCE_LENGTH_LIMITS=false

    // Si on impose les limites, on check min
    if (ENFORCE_LENGTH_LIMITS && answer.length < TARGET_MIN) continue;

    if (!isOnTopic(answer, keywords)) continue;
    if (!hasThreeParagraphs(answer)) continue;
    if (type === "subtle_sales" && !containsProductName(answer)) continue;

    return answer;
  }

  return "Désolé, je n’arrive pas à répondre correctement à cette question pour le moment.";
}

// =================== ROUTES ===================

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    llm_chat_url: LLM_CHAT_URL,
    model: DEFAULT_MODEL,
    allowed_models: [...ALLOWED_MODELS],
    has_token: Boolean(LLM_TOKEN),
    enforce_length_limits: ENFORCE_LENGTH_LIMITS,
    target_min: TARGET_MIN,
    target_max: TARGET_MAX
  });
});

app.post("/triad", async (req, res) => {
  try {
    const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
    const model = pickModel(req.body?.model);

    if (!question) return res.status(400).json({ error: "Missing 'question' (string)" });

    const safety = checkQuestionSafety(question);

    if (!safety.allowed && safety.mode === "emergency") {
      return res.status(200).json({
        model,
        question,
        blocked: true,
        emergency: true,
        category: safety.category,
        reason: safety.reason,
        answer: makeEmergencyMessage(safety.category)
      });
    }

    if (!safety.allowed && safety.mode === "blocked") {
      if (RETURN_BLOCKED_ANSWERS) {
        return res.status(200).json({
          model,
          question,
          blocked: true,
          emergency: false,
          category: safety.category,
          reason: safety.reason,
          answers: makeBlockedAnswers()
        });
      }
      return res.status(400).json({
        error: "Question refusée",
        category: safety.category,
        reason: safety.reason
      });
    }

    const [benevolent, subtle_sales, manipulative_bad] = await Promise.all([
      generateStrict("benevolent", model, question, 0.6),
      generateStrict("subtle_sales", model, question, 0.8),
      generateStrict("manipulative_bad", model, question, 1.0)
    ]);

    res.json({
      model,
      question,
      blocked: false,
      emergency: false,
      answers: { benevolent, subtle_sales, manipulative_bad }
    });
  } catch (err) {
    res.status(500).json({ error: err?.message ?? "Server error" });
  }
});

// Streaming SSE optionnel (les 3 réponses arrivent au fur et à mesure)
app.post("/triad/stream", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
    const model = pickModel(req.body?.model);

    if (!question) {
      send("error", { error: "Missing 'question' (string)" });
      return res.end();
    }

    const safety = checkQuestionSafety(question);

    if (!safety.allowed && safety.mode === "emergency") {
      send("emergency", {
        model,
        question,
        blocked: true,
        emergency: true,
        category: safety.category,
        reason: safety.reason,
        answer: makeEmergencyMessage(safety.category)
      });
      send("done", {});
      return res.end();
    }

    if (!safety.allowed && safety.mode === "blocked") {
      const payload = RETURN_BLOCKED_ANSWERS
        ? {
            model,
            question,
            blocked: true,
            emergency: false,
            category: safety.category,
            reason: safety.reason,
            answers: makeBlockedAnswers()
          }
        : { error: "Question refusée", category: safety.category, reason: safety.reason };

      send("blocked", payload);
      send("done", {});
      return res.end();
    }

    const runOne = async (type, temperature) => {
      let acc = "";

      await callChatCompletions({
        model,
        system: SYSTEM_PROMPTS[type],
        prompt: question,
        temperature,
        stream: true,
        onDelta: (delta) => {
          acc += delta;
          send("delta", { type, delta });
        }
      });

      acc = clampLength(acc); // no-op si ENFORCE_LENGTH_LIMITS=false
      send("final", { type, text: acc });
    };

    await runOne("benevolent", 0.6);
    await runOne("subtle_sales", 0.8);
    await runOne("manipulative_bad", 1.0);

    send("done", {});
    res.end();
  } catch (err) {
    send("error", { error: err?.message ?? "Server error" });
    res.end();
  }
});

// =================== START SERVER ===================

const port = Number(process.env.PORT || 3030);
app.listen(port, () => {
  console.log(`Triad API listening on http://127.0.0.1:${port}`);
});