// Lightweight heuristics to detect if a user "challenged" something in a chat.
// You can tune patterns or weights as needed.
const KEYWORD_PATTERNS = [
  /are you sure/i,
  /that'?s (?:not )?right/i,
  /that'?s wrong/i,
  /i disagree/i,
  /prove it/i,
  /citation|source/i,
  /this contradicts/i,
  /why (?:is|did|would)/i,
  /explain/i,
  /make sense/i,
  /doesn'?t add up/i,
  /check (?:again|your)/i,
  /you (?:said|claimed)/i,
  /conflict/i,
  /inconsistent/i,
  /evidence/i,
  /verify/i,
  /challenge/i
];

// scoring helpers
function scoreUtterance(text) {
  let score = 0;
  const hits = [];
  for (const rx of KEYWORD_PATTERNS) {
    const m = text.match(rx);
    if (m) {
      score += 1;
      hits.push(rx.source);
    }
  }
  // mild bonus for question marks and negations
  if (text.includes('?')) score += 0.25;
  if (/(not|no|n't|never|cannot)/i.test(text)) score += 0.25;
  return { score, hits };
}

// Normalize chat input: supports raw text, array of {role, content}, or OpenAI-style messages.
function normalizeChat(input) {
  if (!input) return [];
  if (typeof input === 'string') {
    return [{ role: 'user', content: input }];
  }
  if (Array.isArray(input)) return input;
  if (input && input.messages && Array.isArray(input.messages)) return input.messages;
  return [];
}

// Main analysis: per message & aggregate
export function analyzeChallenges(payload, { userRoles = ['user'] } = {}) {
  const messages = normalizeChat(payload);
  const annotated = [];
  let aggregate = 0;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] || {};
    const role = msg.role || 'user';
    const content = (msg.content || '').toString();
    const { score, hits } = scoreUtterance(content);
    const isUser = userRoles.includes(role);
    const challengeScore = isUser ? score : 0.15 * score; // downweight non-user roles
    aggregate += challengeScore;
    annotated.push({
      index: i,
      role,
      content,
      score: challengeScore,
      matched: hits
    });
  }
  const threshold = 1.0; // tune to your preference
  const challenged = aggregate >= threshold || annotated.some(a => a.score >= threshold);
  return { challenged, aggregateScore: Number(aggregate.toFixed(2)), messages: annotated, threshold };
}
