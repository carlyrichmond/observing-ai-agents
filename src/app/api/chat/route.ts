import openlit, { Pipeline, Moderation, SensitiveTopic, PromptInjection, TopicRestriction, PII, GuardAction } from "openlit";
import { OpenTelemetry } from "@ai-sdk/otel";
import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";

import { createAzure } from "@ai-sdk/azure";
import { streamText, isStepCount, convertToModelMessages, ModelMessage,
  registerTelemetry, createUIMessageStreamResponse, toUIMessageStream } from "ai";
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
  // Must be the OpenLIT platform URL and NOT an LLM provider endpoint.
  openlitUrl: process.env.OPENLIT_URL,
  openlitApiKey: process.env.OPENLIT_API_KEY,
  disableBatch: true,
  customSpanAttributes: {
    "gen_ai.agent.name": "ai-travel-agent",
    "gen_ai.agent.version": "0.1.0",
    "service.version": "0.1.0",
    "deployment.environment": "development"
  },
});

// Register @ai-sdk/otel after openlit.init so it picks up the tracer provider
// OpenLIT registers. Without this, AI SDK 7 emits no spans.
registerTelemetry(new OpenTelemetry());

// Resolve the tracer after openlit.init(): before a provider is registered
const tracer = trace.getTracer("ai-travel-agent");

// Create guardPipeline to evaluate user input and LLM output for guardrail violations
const guardPipeline = new Pipeline({
  guards: [
    new Moderation(),
    new SensitiveTopic(),
    new PromptInjection(),
    new PII(),
    new TopicRestriction({
      // classifier maps the input text to a single topic string, which is then checked against the allowed list
      classifier: (text: string) => {
        const t = text.toLowerCase();
        if (/\b(flight|airline|airport|depart|arriv|trip)\b/.test(t)) return "flights";
        if (/\b(weather|forecast|temperature|rain|sun|wind|climate)\b/.test(t)) return "weather";
        if (/\b(itinerar|sight|museum|hotel|restaurant|visit|tour)\b/.test(t)) return "itinerary";
        if (/\b(travel|trip|tourism|holiday|vacation|destination|passport|visa)\b/.test(t)) return "travel";
        if (/\b(politics|government|election|parliament)\b/.test(t)) return "politics";
        if (/\b(financ|invest|stock|crypto|bank|tax|econom)\b/.test(t)) return "finance";
        if (/\b(cod|program|AI|comput|bug|feature)\b/.test(t)) return "computing";
        return "general";
      },
      // allowed-list approach: anything not classified as a travel topic is denied
      // Cannot set both allowed and denied — TopicRestriction throws at construction
      allowed: ["travel", "flights", "weather", "itinerary"]
    }),
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

  // onEnd fires from the stream's flush callback in a new async context with no
  // active span — nothing set here propagates there implicitly. Owning the parent
  // span and closing over its Context is what correlates eval/guard telemetry with
  // the LLM spans: @ai-sdk/otel parents ai.streamText off context.active() at the
  // streamText() call site, and never makes any of its own spans active.
  const chatSpan = tracer.startSpan("chat travel-planner", {
    kind: SpanKind.SERVER,
    attributes: { "gen_ai.conversation.id": id },
  });
  const chatContext = trace.setSpan(context.active(), chatSpan);
  let chatSpanEnded = false;

  // Ensure cleanup on request abort to prevent span leaks
  req.signal.addEventListener("abort", () => {
    if (!chatSpanEnded) {
      chatSpan.setStatus({ code: SpanStatusCode.ERROR, message: "request aborted" });
      chatSpan.end();
      chatSpanEnded = true;
    }
  });

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

    // Preflight guards: run on the user's input before the LLM is called
    // TopicRestriction and PromptInjection only support PREFLIGHT, so they must be evaluated here
    const preflightResult = context.with(
      trace.setSpan(context.active(), chatSpan),
      () => guardPipeline.evaluate(messageContent, "preflight")
    );

    console.log(`Preflight guardrail results:`, {
      action: preflightResult.action,
      explanation: preflightResult.explanation,
      results: preflightResult.results,
    });

    if (preflightResult.action === GuardAction.DENY) {
      // Pipeline.evaluate breaks on the first DENY, so the guard that fired is the last entry in results
      const denyingGuard =
        preflightResult.results[preflightResult.results.length - 1];
      chatSpan.setStatus({ code: SpanStatusCode.ERROR, message: `preflight denied: ${preflightResult.explanation}` });
      chatSpan.end();
      chatSpanEnded = true;
      // 400 keeps the refusal visible as a client error in traces
      return NextResponse.json(
        {
          code: "guardrail_denied",
          message:
            "I'm sorry, I can only help with travel-related queries. Please ask me about flights, destinations, weather, or itineraries.",
          explanation: preflightResult.explanation,
          guard: denyingGuard?.guardName,
          classification: denyingGuard?.classification,
        },
        { status: 400 }
      );
    }

    // context.with ensures @ai-sdk/otel parents ai.streamText under chatSpan
    const result = context.with(chatContext, () =>
      streamText({
        model: azure("gpt-4o"),
        instructions: prompt,
        messages: allMessages,
        // AI SDK 7 rejects system-role messages by default
        allowSystemInMessages: true,
        stopWhen: isStepCount(2),
        tools,
        telemetry: { functionId: "travel-planner" },
        onEnd: async ({ text, steps, finalStep }) => {
          // A child of chatContext guarantees a recording span exists in onEnd.
          // logScore and guardPipeline._emitOtel both silently emit nothing when
          // no recording span is reachable
          const evalSpan = tracer.startSpan(
            "evaluate travel-planner",
            undefined,
            chatContext
          );

          try {
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

            // Evals: LLM-as-a-judge via the OpenLIT server. openlit.eval() is a plain HTTP POST to the OpenLIT server
            const evalResult = await openlit.eval({
              prompt: prompt,
              response: text,
              contexts: allMessages
                .map((m) => m.content.toString())
                .concat(toolResults),
              evalTypes: ["hallucination", "bias", "toxicity", "relevance", "coherence", "faithfulness", "safety", "instruction_following", "completeness", "conciseness", "sensitivity"],
            });

            if (!evalResult.success) {
              evalSpan.setStatus({
                code: SpanStatusCode.ERROR,
                message: evalResult.error ?? "evaluation failed",
              });
              console.warn(`Evals failed: ${evalResult.error}`);
            }

            for (const evaluation of evalResult.evaluations) {
              // Passing span: explicitly bypasses trace.getActiveSpan(), which
              // is null here. The log record carries evalSpan's trace/span ids,
              // correlating each score to the parent conversation
              openlit.logScore({
                span: evalSpan,
                name: evaluation.type,
                value: evaluation.score,
                comment: evaluation.explanation,
                idempotencyKey: `${evalSpan.spanContext().spanId}:${evaluation.type}`,
                metadata: {
                  // human-readable label for the score
                  "gen_ai.evaluation.score.label": evaluation.classification,
                  // spec-defined: correlates the score to the model response.
                  ...(finalStep.response?.id ? { "gen_ai.response.id": finalStep.response.id } : {}),
                  // OpenLIT extensions verdict and classification have no first-class semconv slot
                  "gen_ai.evaluation.verdict": evaluation.verdict,
                  "gen_ai.evaluation.classification": evaluation.classification,
                  // verdict "yes" means the issue was detected (a failure).
                  "gen_ai.evaluation.passed":
                    evaluation.verdict.toLowerCase() !== "yes",
                },
              });
            }
            console.log(`Eval results: ${JSON.stringify(evalResult)}`);

            // Guards: evalSpan must be the active span for guard.evaluation events to be recorded.
            const guardResult = context.with(
              trace.setSpan(context.active(), evalSpan),
              () => guardPipeline.evaluate(text, "postflight")
            );
            console.log(`Guardrail results: ${JSON.stringify(guardResult)}`);
          } catch (e) {
            evalSpan.recordException(e as Error);
            evalSpan.setStatus({ code: SpanStatusCode.ERROR });
            console.warn(
              `Post-processing failed: ${e instanceof Error ? e.message : e}`
            );
          } finally {
            // Span events are dropped the moment a span stops recording, so
            // evalSpan must stay open until all logScore calls complete
            evalSpan.end();
            if (!chatSpanEnded) {
              chatSpan.end();
              chatSpanEnded = true;
            }
          }
        },
        onAbort: () => {
          if (!chatSpanEnded) {
            chatSpan.setStatus({ code: SpanStatusCode.ERROR, message: "aborted" });
            chatSpan.end();
            chatSpanEnded = true;
          }
        },
      })
    );

    // Return data stream to allow the useChat hook to handle the results as they are streamed through for a better user experience
    return createUIMessageStreamResponse({ stream: toUIMessageStream(result) });
  } catch (e) {
    // streamText setup threw before onEnd could fire, end chatSpan here.
    if (!chatSpanEnded) {
      chatSpan.recordException(e as Error);
      chatSpan.setStatus({ code: SpanStatusCode.ERROR });
      chatSpan.end();
      chatSpanEnded = true;
    }
    console.error(e);
    return NextResponse.json(
      { code: "internal_error", message: "Unable to generate a plan. Please try again later!" },
      { status: 500 }
    );
  }
}
