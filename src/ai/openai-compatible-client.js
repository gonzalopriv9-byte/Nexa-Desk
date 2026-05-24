export class OpenAICompatibleClient {
  constructor({ baseUrl, model, apiKey }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.apiKey = apiKey;
  }

  async generate({ system, messages, maxTokens = 350, temperature = 0.25 }) {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        temperature,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          ...messages
        ]
      })
    });

    if (!response.ok) {
      throw new Error(`AI server returned ${response.status}: ${await response.text()}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() ?? '';
  }
}
