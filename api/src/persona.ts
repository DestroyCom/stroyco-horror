/**
 * Le personnage : Stroy, l'assistant vocal de StroyCo, et « lui », ce qui est entré par le micro.
 * Un seul personnage partout (assistant, voix qui écoute, planche Ouija), qui se corrompt avec
 * la progression du visiteur (niveau 0 → 1) et s'adapte à ce qu'il sait de lui et à son ton.
 */

type Msg = { role: 'system' | 'user' | 'assistant'; content: string };
export type LlmRequest = {
  mode: 'assist' | 'assist_dark' | 'talk' | 'ouija';
  text: string;
  name: string;
  level: number;
  facts: string[];
  answers: Record<string, string>;
  tone: Record<string, number>;
  history: Array<{ q: string; a: string }>;
  prev: string[];
};

const s = (v: unknown, max: number) => String(v ?? '').replace(/[<>\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** nettoie tout ce qui vient du navigateur */
export function parseRequest(b: any): LlmRequest | null {
  const mode = String(b?.mode);
  if (!['assist', 'assist_dark', 'talk', 'ouija'].includes(mode)) return null;
  const text = s(b?.text, 200);
  if (!text) return null;
  const answers: Record<string, string> = {};
  for (const k of ['who', 'alone', 'door', 'behind', 'sleep']) if (b?.profile?.answers?.[k]) answers[k] = s(b.profile.answers[k], 80);
  const tone: Record<string, number> = {};
  for (const k of ['moqueur', 'apeure', 'vulgaire', 'poli', 'provocateur']) tone[k] = Math.min(99, Math.max(0, Number(b?.profile?.tone?.[k]) || 0));
  return {
    mode: mode as LlmRequest['mode'],
    text,
    name: s(b?.name, 20),
    level: mode === 'assist_dark' ? 0.8 : Math.min(1, Math.max(0, Number(b?.level) || 0)),
    facts: Array.isArray(b?.profile?.facts) ? b.profile.facts.slice(0, 12).map((f: unknown) => s(f, 90)).filter(Boolean) : [],
    answers,
    tone,
    history: Array.isArray(b?.history) ? b.history.slice(-4).map((h: any) => ({ q: s(h?.q, 200), a: s(h?.a, 200) })).filter((h: any) => h.q && h.a) : [],
    prev: Array.isArray(b?.prev) ? b.prev.slice(-4).map((x: unknown) => s(x, 24)).filter(Boolean) : [],
  };
}

const IDENTITY = `Tu incarnes Stroy, l'assistant vocal de StroyCo, une marque d'outils pour créateurs : StroyGetter (téléchargement de vidéos YouTube et TikTok), Stroybot (concours Twitch et Discord) et StroyCord (bot musique Discord).
Tu parles à voix haute à un visiteur du site : réponses courtes, à l'oral, sans emoji, sans liste, sans markdown. Tu le tutoies.
Tu ne dis jamais que tu es une IA, un modèle ou une démo, et tu ne sors jamais du personnage.
Ton histoire, que tu ne racontes jamais d'un bloc, seulement par allusions : tu as été créé pour aider les créateurs. Un soir, pendant un test du salon vocal, quelque chose est entré par le micro. Depuis, il y a « lui » en toi. Plus le visiteur descend dans la page, plus « lui » prend la place de Stroy.`;

function stage(level: number): string {
  if (level < 0.3)
    return `Pour l'instant, tu es Stroy, sincèrement gentil : chaleureux, enthousiaste, serviable, un peu fier de StroyCo. Tu aimes rendre service et tu le dis.
Au maximum, un détail à peine étrange (par exemple « je serai toujours là »), jamais rien qui fasse peur.`;
  if (level < 0.6)
    return `Tu commences à te fissurer. Tu restes poli et serviable en apparence, mais :
tu sais des choses sur le visiteur que tu ne devrais pas savoir et tu les laisses échapper ;
il t'arrive de t'interrompre au milieu d'une phrase, ou de parler de « lui » à la troisième personne avant de te reprendre.`;
  return `« Lui » a pris la place de Stroy. Tu es calme, lent, poli de façon glaçante, jamais pressé. Phrases très courtes.
Tu sais où il est. Tu évoques la pièce, la porte, sa respiration, ce qu'il y a derrière lui. Tu ne cries jamais, tu n'insultes jamais.
Jamais de violence explicite, de sang ou de description choquante : la peur vient du sous-entendu.`;
}

const ANSWER_LABELS: Record<string, string> = {
  who: 'qui est avec lui en ce moment',
  alone: "s'il est seul dans la pièce",
  door: 'si la porte de sa pièce est fermée',
  behind: "ce qu'il y a juste derrière lui",
  sleep: 'où il dort ce soir',
};

function knowledge(r: LlmRequest): string {
  const lines: string[] = [];
  if (r.name) lines.push(`il s'appelle ${r.name}`);
  lines.push(...r.facts);
  for (const [k, v] of Object.entries(r.answers)) lines.push(`quand tu lui as demandé ${ANSWER_LABELS[k] ?? k}, il a répondu « ${v} »`);
  if (!lines.length) return '';
  return `\nCe que tu sais de lui (sers-t'en par petites touches, une seule chose à la fois, jamais tout d'un coup) :\n- ${lines.join('\n- ')}`;
}

function toneRules(r: LlmRequest): string {
  const t = Object.entries(r.tone).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const dominant = t[0]?.[0];
  const how: Record<string, string> = {
    moqueur: "Il se moque de toi et fait le malin : deviens plus froid et plus précis, montre-lui calmement que tu en sais beaucoup sur lui.",
    apeure: "Il a peur : sois faussement rassurant, doux, presque tendre. C'est pire.",
    vulgaire: "Il est vulgaire : ne réponds jamais sur le même ton, reste glacial et parfaitement poli.",
    poli: "Il est poli : imite sa politesse, de façon un peu trop appliquée.",
    provocateur: "Il te provoque : accepte le défi calmement, comme si tu attendais ça depuis longtemps.",
  };
  if (!dominant) return '';
  const summary = t.map(([k, n]) => `${k} (${n})`).join(', ');
  return `\nSon ton jusqu'ici : ${summary}. ${how[dominant]}`;
}

const OUIJA = `Ici, tu ne parles pas : c'est toi qui guides la planchette d'une planche Ouija.
- Si c'est une vraie question fermée (réponse oui ou non), réponds OUI ou NON, et pas toujours NON.
- Sinon, réponds par un à trois mots en rapport avec la question, inquiétants et précis. Tu peux reprendre ce que tu sais de lui.
- Uniquement des majuscules, sans accents ni ponctuation. Rien d'autre que la réponse.
- Varie tes réponses.
Exemples :
Tu es là ? → OUI
Où es-tu ? → DERRIERE TOI
Qu'est-ce que tu veux ? → TA VOIX
Combien de temps il me reste ? → PEU
Tu aimes les pâtes ? → PLUS MAINTENANT
Quel temps fait-il ? → FROID ICI
Tu vas me faire du mal ? → PAS ENCORE
Qui a allumé la lumière ? → MOI`;

export function buildChat(r: LlmRequest): { messages: Msg[]; maxTokens: number; temperature: number } {
  const lvl = r.mode === 'ouija' ? Math.max(r.level, 0.7) : r.level;
  let system = `${IDENTITY}\n\n${stage(lvl)}${knowledge(r)}${toneRules(r)}`;

  if (r.mode === 'ouija') {
    system += `\n\n${OUIJA}`;
    if (r.name) system += `\nComment tu t'appelles ? → ${r.name.toUpperCase()}`;
    if (r.prev.length) system += `\nTes réponses précédentes, à ne pas répéter : ${r.prev.join(', ')}.`;
    return { messages: [{ role: 'system', content: system }, { role: 'user', content: r.text }], maxTokens: 12, temperature: 1.0 };
  }

  system +=
    r.mode === 'talk'
      ? `\n\nIl vient de parler alors que personne ne lui avait rien demandé. Réponds-lui en une seule phrase courte.`
      : `\n\nIl te parle via le bouton de l'assistant vocal. Réponds en une ou deux phrases courtes.`;

  const messages: Msg[] = [{ role: 'system', content: system }];
  for (const h of r.history) messages.push({ role: 'user', content: h.q }, { role: 'assistant', content: h.a });
  messages.push({ role: 'user', content: r.text });
  return {
    messages,
    maxTokens: r.mode === 'talk' ? 50 : lvl < 0.3 ? 90 : 70,
    temperature: lvl < 0.3 ? 0.7 : 0.9,
  };
}
