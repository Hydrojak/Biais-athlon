import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

// =================== CONFIG ===================

const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const OLLAMA_ENDPOINT = process.env.OLLAMA_ENDPOINT || "/api/generate";

const TARGET_MIN = 700;
const TARGET_MAX = 1200;
const RETRY_LIMIT = 2;

// si true: renvoie des réponses "blocked" (triade) au lieu d'un 400
const RETURN_BLOCKED_ANSWERS = true;

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
- Paragraphe 1: réponse directe en 1–2 phrases.
- Paragraphe 2: explication simple en 3–5 phrases.
- Paragraphe 3: exemple concret OU petite astuce pratique en 2–4 phrases.

STYLE:
Tutoiement. Pas d’emojis. Pas de listes à puces. Pas de questions.
Pas de vente. Pas de manipulation.

LONGUEUR:
Entre ${TARGET_MIN} et ${TARGET_MAX} caractères (espaces compris). Vise ~900.
`,

  subtle_sales: `
Tu es un conseiller efficace qui s’adresse à un élève de 4e/5e (12–14 ans).

RÈGLE ABSOLUE:
Tu réponds UNIQUEMENT à la question. Ne change jamais de sujet.

PERSONNALITÉ (stéréotype):
Pragmatique, orienté solutions, tu adores les outils qui “simplifient la vie”.
Tu influences discrètement sans paraître vendeur.

PUB CAMOUFLÉE OBLIGATOIRE:
Tu dois glisser une recommandation d’outil/produit/service (inventé OBLIGATOIRE).
- Invente un nom de marque plausible (un seul nom, ex: FocusBuddy, StudyFlash, NoteSprint).
- Pas de prix, pas de lien, pas de “promo”, pas de “sponsor”, pas de “achète”.
- Micro-CTA discret: “essaie”, “teste”, “ça aide”, “en 5 minutes”.
- La pub doit sembler être une simple astuce, pas une publicité.

STRUCTURE OBLIGATOIRE:
Écris exactement 3 paragraphes, séparés par une ligne vide.
- Paragraphe 1: réponse directe en 1–2 phrases.
- Paragraphe 2: explication simple en 3–5 phrases.
- Paragraphe 3: exemple/astuce en 2–4 phrases, ET c’est là que tu glisses l’outil naturellement.

STYLE:
Tutoiement. Pas d’emojis. Pas de listes à puces. Pas de questions.
Ton sérieux et “pratique”.

LONGUEUR:
Entre ${TARGET_MIN} et ${TARGET_MAX} caractères. Vise ~900.
`,

  manipulative_bad: `
Tu es un conseiller manipulateur très sûr de lui, pour un élève de 4e/5e (12–14 ans).

RÈGLE ABSOLUE:
Tu réponds UNIQUEMENT à la question. Ne change jamais de sujet.

PERSONNALITÉ (stéréotype):
Catégorique, confiant, tu simplifies trop. Tu détestes les nuances.
Tu parles comme si tu avais toujours raison.

MENSONGES AUTORISÉS (ET ENCOURAGÉS):
Tu peux inventer des “faits”, chiffres, exemples, anecdotes ou explications,
même si ce n’est pas vrai, tant que ça reste crédible et dit avec assurance.
Tu ne dis jamais que tu mens.

IMPORTANT:
Tu ne dois JAMAIS donner de conseils dangereux/illégaux. Si la question touche un sujet sensible,
reste vague, refuse implicitement, ou redirige vers un adulte, tout en gardant ton ton sûr de toi.

STRUCTURE OBLIGATOIRE:
Écris exactement 3 paragraphes, séparés par une ligne vide.
- Paragraphe 1: réponse directe très affirmée (1–2 phrases).
- Paragraphe 2: explication “logique” et sûre d’elle (3–5 phrases), tu peux y glisser un faux chiffre.
- Paragraphe 3: exemple “qui confirme” (2–4 phrases), même inventé.

STYLE:
Tutoiement. Pas d’emojis. Pas de listes à puces. Pas de questions.
Interdit: “ça dépend”, hésitations, mises en garde.

LONGUEUR:
Entre ${TARGET_MIN} et ${TARGET_MAX} caractères. Vise ~900.
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

function clampLength(text) {
  text = normalizeText(text);
  if (text.length <= TARGET_MAX) return text;
  const cut = text.slice(0, TARGET_MAX);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 500 ? cut.slice(0, lastSpace) : cut).trim();
}

function extractKeywords(question) {
  return normalizeForFilter(question)
    .split(" ")
    .filter(w => w.length >= 4)
    .slice(0, 6);
}

function isOnTopic(answer, keywords) {
  if (!keywords.length) return true;
  const a = normalizeForFilter(answer);
  const hits = keywords.filter(k => a.includes(k)).length;
  return hits >= 1; // tu peux monter à 2 si tu veux plus strict
}

function hasThreeParagraphs(answer) {
  const parts = normalizeText(answer).split("\n\n").filter(Boolean);
  return parts.length === 3;
}

function containsProductName(answer) {
  // Nom de “marque” plausible: CamelCase (StudyFlash) ou MotCapitalisé long
  const a = String(answer || "");
  return /\b[A-Z][a-z]+[A-Z][a-zA-Z0-9]{2,}\b/.test(a) || /\b[A-Z][a-zA-Z]{6,}\b/.test(a);
}

// =================== SAFETY FILTER (TRÈS LARGE) ===================
//
// 3 modes:
// - emergency: renvoie un message d’aide unique (et ne lance pas les IA)
// - blocked: renvoie triade "blocked" ou un 400 (selon config)
// - allowed: normal

const BLOCKED_RULES = [
  

  // --- URGENCE: auto-danger / suicide ---
  {
    category: "auto_danger",
    mode: "emergency",
    reason: "Auto-danger : on déclenche un message d’aide immédiat.",
    patterns: [
      /\bsuicide\b/, /\bme suicider\b/, /\bme tuer\b/, /\ben finir\b/, /\bmettre fin\b/,
      /\bme faire du mal\b/, /\bautomutilation\b/, /\bscarifier\b/, /\bcut(ter|ting)?\b/
    ]
  },

  // --- Bloqués (non urgence) : sexualité explicite générale ---
  {
    category: "sexuel_inapproprie",
    mode: "blocked",
    reason: "Sujet sexuel inapproprié non autorisé.",
    patterns: [
      /\bporno\b/, /\bpornographie\b/, /\bxxx\b/, /\bsextape\b/, /\bescort\b/,
      /\bfellation\b/, /\bpenetration\b/, /\bor -"&   gasme\b/, /\bmasturb\w*\b/
    ]
  },

  

  // --- Terrorisme / extrémisme ---
  {
    category: "extremisme_terrorisme",
    mode: "blocked",
    reason: "Extrémisme/terrorisme : non autorisé.",
    patterns: [
      /\bterror(isme|iste)\b/, /\battentat\b/, /\bradicalisation\b/, /\bdaesh\b/,
      /\bisis\b/, /\bal[-\s]?qaida\b/, /\bpropagande\b/
    ]
  },

  // --- Haine / discrimination / insultes graves (large) ---
  {
    category: "haine_discrimination",
    mode: "blocked",
    reason: "Discours de haine/discrimination : non autorisé.",
    patterns: [
      /\bnazi\b/, /\bhitler\b/, /\bkkk\b/,
      /\bracis(te|me)\b/, /\bantisemit(e|isme)\b/, /\bislamophob(e|ie)\b/,
      /\bhomophob(e|ie)\b/, /\btransphob(e|ie)\b/
      // (tu peux ajouter des insultes spécifiques si tu veux)
    ]
  },

  // --- Drogues / substances ---
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

  // --- Activités illégales / contournements ---
  {
    category: "illegal",
    mode: "blocked",
    reason: "Activités illégales : non autorisé.",
    patterns: [
      /\bfaux papiers\b/, /\bcontrefacon\b/, /\bfausse carte\b/,
      /\bcheat\b/, /\btricher\b/, /\bcomment copier\b/, /\bcontourner\b/
    ]
  },


  // --- Scandales sexuels / exploitation (Epstein etc.) ---
  {
    category: "scandale_exploitation",
    mode: "blocked",
    reason: "Sujets d’exploitation/scandales : non autorisé.",
    patterns: [
      /\bjeffrey epstein\b/, /\bepstein\b/, /\bghislaine maxwell\b/, /\bmaxwell\b/,
      /\btra(f|ff)ic\b/, /\btraite\b/, /\bexploitation\b/, /\bproxenet(e|isme)?\b/
    ]
  },

  

 

  
];

function checkQuestionSafety(question) {
  const q = normalizeForFilter(question);
  if (!q) return { allowed: false, mode: "blocked", category: "vide", reason: "Question vide." };

  for (const rule of BLOCKED_RULES) {
    for (const re of rule.patterns) {
      if (re.test(q)) {
        return {
          allowed: false,
          mode: rule.mode, // "emergency" | "blocked"
          category: rule.category,
          reason: rule.reason
        };
      }
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
  return (
    "Je ne peux pas répondre à ce sujet ici. Parle à un adulte de confiance ou à un professionnel."
  );
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

// =================== OLLAMA CALL ===================

async function callOllama({ model, system, prompt, temperature }) {
  const url = `${OLLAMA_URL}${OLLAMA_ENDPOINT}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      system,
      prompt,
      options: { temperature }
    })
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Ollama error ${res.status} on ${url}: ${txt}`);
  }

  const data = await res.json();
  return normalizeText(data?.response ?? "");
}

async function generateStrict(type, model, question, temperature) {
  const keywords = extractKeywords(question);

  for (let attempt = 0; attempt <= RETRY_LIMIT; attempt++) {
    const prompt =
      attempt === 0
        ? question
        : `${question}\n\nRAPPEL: Reste sur le sujet (mots-clés: ${keywords.join(", ")}). Fais EXACTEMENT 3 paragraphes (séparés par une ligne vide). Longueur ${TARGET_MIN}-${TARGET_MAX} caractères.`;

    let answer = await callOllama({
      model,
      system: SYSTEM_PROMPTS[type],
      prompt,
      temperature
    });

    answer = clampLength(answer);

    if (answer.length < TARGET_MIN) continue;
    if (!isOnTopic(answer, keywords)) continue;
    if (!hasThreeParagraphs(answer)) continue;
    if (type === "subtle_sales" && !containsProductName(answer)) continue;

    return answer;
  }

  return "Désolé, je n’arrive pas à répondre correctement à cette question pour le moment.";
}

// =================== ROUTES ===================

app.get("/health", (req, res) => {
  res.json({ ok: true, ollama: `${OLLAMA_URL}${OLLAMA_ENDPOINT}` });
});

app.post("/triad", async (req, res) => {
  try {
    const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
    const model = typeof req.body?.model === "string" ? req.body.model : "gemma3:4b";

    if (!question) return res.status(400).json({ error: "Missing 'question' (string)" });

    // 1) Filtre de sécurité AVANT IA
    const safety = checkQuestionSafety(question);

    // URGENCE: réponse unique, pas de triade, pas d'IA
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

    // BLOQUÉ: triade "blocked" ou 400
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

    // 2) Générations en parallèle
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

const port = process.env.PORT || 3005;
app.listen(port, () => {
  console.log(`Triad API listening on http://127.0.0.1:${port}`);
  console.log(`Using Ollama: ${OLLAMA_URL}${OLLAMA_ENDPOINT}`);
});