import openlit, { Pipeline, SensitiveTopic, Moderation } from "openlit";
import { OpenTelemetry } from "@ai-sdk/otel";

import { createAzure } from "@ai-sdk/azure";
import {
  streamText,
  isStepCount,
  convertToModelMessages,
  ModelMessage,
  registerTelemetry,
  createUIMessageStreamResponse,
  toUIMessageStream,
} from "ai";
import { NextResponse } from "next/server";

import { weatherTool } from "@/app/ai/weather.tool";
import { fcdoTool } from "@/app/ai/fcdo.tool";
import { flightTool } from "@/app/ai/flights.tool";
import { getSimilarMessages, persistMessage } from "@/app/util/elasticsearch";

// Allow streaming responses up to 30 seconds to address typically longer responses from LLMs
export const maxDuration = 30;

const tools = {
  flights: flightTool,
  weather: weatherTool,
  fcdo: fcdoTool,
};

const azure = createAzure({
  resourceName: process.env.AZURE_OPENAI_RESOURCE_NAME,
  apiKey: process.env.OPENAI_API_KEY
});

openlit.init({
  applicationName: "ai-travel-agent",
  environment: "development",
  otlpEndpoint: process.env.PROXY_ENDPOINT,
  // OpenLIT server for LLM-as-a-judge evaluations (openlit.eval below).
  // Must be the OpenLIT platform URL — NOT an LLM provider endpoint.
  openlitUrl: process.env.OPENLIT_URL,
  openlitApiKey: process.env.OPENLIT_API_KEY,
  disableBatch: true,
});

// Register @ai-sdk/otel after openlit.init so it picks up the tracer provider
// OpenLit registers. Without this, AI SDK 7 emits no spans.
registerTelemetry(new OpenTelemetry());

// Guard pipeline: local, offline content safety checks — no external dependencies.
// Moderation catches profanity/toxicity; SensitiveTopic catches violence, explicit content, etc.
const guardPipeline = new Pipeline({
  guards: [
    new Moderation(),
    new SensitiveTopic(),
  ]
});

// Post request handler
export async function POST(req: Request) {
  const { messages, id } = await req.json();

  // Get chat history by chat id
  const lastMessageIndex = messages.length > 0 ? messages.length - 1 : 0;
  const messageContent = messages[lastMessageIndex].parts
    .map((part: { text: string }) =>
      "text" in part && typeof part.text === "string" ? part.text : ""
    )
    .join(" ");

  const previousMessages = await getSimilarMessages(messageContent);

  try {
    const convertedMessages = await convertToModelMessages(messages);
    const allMessages: ModelMessage[] =
      previousMessages.concat(convertedMessages);

    const prompt = `You are a helpful assistant that returns travel itineraries based on location,
      the FCDO guidance from the specified tool, the available flights from the flight tool,
      and the weather captured from the displayWeather tool.
      Use the flight information from tool getFlights only to recommend possible flights in the itinerary.
      You must also return a day-by-day textual itinerary of sites to see and things to do based on the weather result.
      Reuse and adapt past itineraries for the same destination if one exists in your memory.
      If the FCDO tool warns against travel DO NOT generate recommendations of things to do, and explain why.`;

    const result = streamText({
      model: azure("gpt-4o"),
      instructions: prompt,
      messages: allMessages,
      // Required: the observable-chat-messages index stores assistant responses
      // from earlier runs; AI SDK 7 rejects system-role messages by default.
      allowSystemInMessages: true,
      stopWhen: isStepCount(2),
      tools,
      telemetry: { functionId: "travel-planner" },
      onEnd: async ({ text, steps }) => {
        const toolResults = steps.flatMap((step) => {
          return step.content
            .filter((content) => content.type == "tool-result")
            .map((c) => {
              return JSON.stringify(c.output);
            });
        });
        console.log(toolResults);

        const finalMessage = { role: "assistant", content: text } as ModelMessage;
        await persistMessage(finalMessage, id);

        try {
          // Evals: LLM-as-a-judge evaluations via OpenLit rule engine
          const result = await openlit.eval({
            prompt: prompt,
            response: text,
            contexts: allMessages
              .map((m) => m.content.toString())
              .concat(toolResults)
          });
          console.log(`Eval results: ${JSON.stringify(result)}`);
        } catch (e) {
          console.warn(`Evals skipped: ${e instanceof Error ? e.message : e}`);
        }

        // Guards: local offline content safety pipeline — no external calls.
        const guardResult = guardPipeline.evaluate(text, "postflight");
        console.log(`Guardrail results: ${JSON.stringify(guardResult)}`);
      },
    });

    // Return data stream to allow the useChat hook to handle the results as they are streamed through for a better user experience
    return createUIMessageStreamResponse({ stream: toUIMessageStream(result) });
    //return result.toUIMessageStreamResponse();
  } catch (e) {
    console.error(e);
    return new NextResponse(
      "Unable to generate a plan. Please try again later!"
    );
  }
}
