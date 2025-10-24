import openlit from "openlit";

//import { openai } from "@ai-sdk/openai";
import { ollama } from "ollama-ai-provider-v2";
import { streamText, stepCountIs, convertToModelMessages } from "ai";
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

openlit.init({
    applicationName: "ai-travel-agent",
    environment: "development",
    otlpEndpoint: process.env.PROXY_ENDPOINT,
    disableBatch: true
  }); // Proxy endpoint

// Note: evals are disabled for now as it's only compatible with OpenAI and Anthropic providers
const detector = openlit.evals.All({provider: "openai"});

// Post request handler
export async function POST(req: Request) {
  const { messages, id } = await req.json();

  // Store current message
  const lastMessageIndex = messages.length > 0 ? messages.length - 1 : 0;
  await persistMessage(messages[lastMessageIndex], id);

  // Get chat history by chat id
  const previousMessages = await getSimilarMessages(messages[lastMessageIndex]);
  const allMessages = [...previousMessages, ...messages];

  try {
    const convertedMessages = convertToModelMessages(allMessages);

    // TODO: can I invoke the check when I get the result back
    /*const results = detector.measure({
      prompt: messages[lastMessageIndex - 1].parts.join(""),
      contexts: allMessages,
    });*/

    const result = streamText({
      model: ollama("qwen3:8b"),
      //model: openai("gpt-4o"),
      system: `You are a helpful assistant that returns travel itineraries based on location, the FCDO guidance from the specified tool, and the weather captured from the displayWeather tool.
        Use the flight information from tool getFlights only to recommend possible flights in the itinerary.
        If there are no flights available generate a sample itinerary and advise them to contact a travel agent.
        Return an itinerary of sites to see and things to do based on the weather.
        If the FCDO tool warns against travel DO NOT generate an itinerary.`,
      messages: convertedMessages,
      stopWhen: stepCountIs(2),
      tools,
      experimental_telemetry: { isEnabled: true }
    });

    // Return data stream to allow the useChat hook to handle the results as they are streamed through for a better user experience
    return result.toUIMessageStreamResponse();
  } catch (e) {
    console.error(e);
    return new NextResponse(
      "Unable to generate a plan. Please try again later!"
    );
  }
}
