import { createHash } from "node:crypto";
export class MockEmbeddingProvider {
    async embed(text) {
        const hash = createHash("sha256").update(text).digest();
        const vector = [];
        for (let i = 0; i < 16; i += 1) {
            const value = hash[i] / 255;
            vector.push(value * 2 - 1);
        }
        return vector;
    }
}
export class OpenAICompatibleEmbeddingProvider {
    baseUrl;
    apiKey;
    model;
    constructor(baseUrl, apiKey, model) {
        this.baseUrl = baseUrl;
        this.apiKey = apiKey;
        this.model = model;
    }
    async embed(text) {
        const response = await fetch(`${this.baseUrl}/embeddings`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${this.apiKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: this.model,
                input: text
            })
        });
        if (!response.ok) {
            throw new Error(`Embedding provider failed: ${response.status}`);
        }
        const json = (await response.json());
        return json.data[0]?.embedding ?? [];
    }
}
//# sourceMappingURL=providers.js.map