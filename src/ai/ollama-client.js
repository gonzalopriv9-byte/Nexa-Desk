export class OllamaClient {
  constructor({ baseUrl, model }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
  }

  async generate({ system, messages }) {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        messages: [
          { role: 'system', content: system },
          ...messages
        ],
        options: {
          temperature: 0.25,
          num_predict: 350
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Ollama returned ${response.status}: ${await response.text()}`);
    }

    const data = await response.json();
    return data.message?.content?.trim() ?? '';
  }
}
