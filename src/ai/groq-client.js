import Groq from 'groq-sdk';

export class GroqClient {
  constructor({ apiKey, model }) {
    this.apiKey = apiKey;
    this.client = apiKey && apiKey !== 'replace_me' ? new Groq({ apiKey }) : null;
    this.model = model;
  }

  async generate({ system, messages }) {
    if (!this.client) {
      throw new Error('Set GROQ_API_KEY in .env to use Groq.');
    }

    const completion = await this.client.chat.completions.create({
      model: this.model,
      temperature: 0.25,
      max_completion_tokens: 350,
      messages: [
        { role: 'system', content: system },
        ...messages
      ]
    });

    return completion.choices[0]?.message?.content?.trim() ?? '';
  }
}
