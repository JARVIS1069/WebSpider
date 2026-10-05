'use strict';
// Rename to llm-hook.js and launch with WEBSPIDER_LLM=1 to enable. Disabled by default.
// Must export async (text, {title, url}) => string[]  (key-point sentences).
// NOTE: enabling this sends scraped text to the API below.
module.exports = async function llmSummarize(text, { title, url }) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: `Give 5-8 concise key points, one per line, for "${title}" (${url}):\n\n${text.slice(0, 24000)}` }]
    })
  });
  const j = await res.json();
  return j.choices[0].message.content.split('\n').map((l) => l.replace(/^[-*\d.\s]+/, '').trim()).filter(Boolean);
};
