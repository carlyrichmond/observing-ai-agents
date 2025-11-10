import { Client } from "@elastic/elasticsearch";
import { ModelMessage } from "ai";

export const flightIndex: string = "upcoming-flight-data2";
export const client: Client = new Client({
  node: process.env.ELASTIC_ENDPOINT,
  auth: {
    apiKey: process.env.ELASTIC_API_KEY || "",
  },
});

const messageIndex: string = "chat-messages";
export async function persistMessage(message: ModelMessage, id: string) {
  try {
    if (!(await client.indices.exists({ index: messageIndex }))) {
      await client.indices.create({
        index: messageIndex,
        mappings: {
          properties: {
            "chat-id": { type: "keyword" },
            message: {
              type: "object",
              properties: {
                role: { type: "keyword" },
                content: { type: "semantic_text" }
              },
            },
            "@timestamp": { type: "date" },
          },
        },
      });
      await new Promise((r) => setTimeout(r, 2000));
    }

    await client.index({
      index: messageIndex,
      document: {
        "chat-id": id,
        message: message,
        "@timestamp": new Date().toISOString(),
      },
    });
  } catch (e) {
    console.error("Unable to persist message", e);
  }
}

export async function getSimilarMessages(content: string): Promise<(ModelMessage)[]> {
  try {
    const result = await client.search<{ message: ModelMessage }>({
      index: messageIndex,
      query: {
        semantic: {
          field: "message.content",
          query: content,
        },
      },
      sort: [{ "@timestamp": "asc" }],
      size: 20,
    });

    return result.hits.hits
      .map((hit) => hit._source?.message as ModelMessage)
  } catch (e) {
    console.error("Unable to retrieve messages", e);
    return [];
  }
}
