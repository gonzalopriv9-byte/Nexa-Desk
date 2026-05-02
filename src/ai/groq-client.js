import Groq from 'groq-sdk';

export class GroqClient {
  constructor({ apiKey, model, visionModel }) {
    this.apiKey = apiKey;
    this.client = apiKey && apiKey !== 'replace_me' ? new Groq({ apiKey }) : null;
    this.model = model;
    this.visionModel = visionModel;
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

  async analyzeImages({ system, prompt, images }) {
    if (!this.client) {
      throw new Error('Set GROQ_API_KEY in .env to use Groq vision.');
    }

    if (!this.visionModel) {
      throw new Error('Set GROQ_VISION_MODEL to use visual analysis.');
    }

    const completion = await this.client.chat.completions.create({
      model: this.visionModel,
      temperature: 0.1,
      max_completion_tokens: 550,
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            ...images.slice(0, 5).map((image) => ({
              type: 'image_url',
              image_url: { url: image.url }
            }))
          ]
        }
      ]
    });

    return completion.choices[0]?.message?.content?.trim() ?? '';
  }
}
