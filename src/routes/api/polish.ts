import { createFileRoute } from "@tanstack/react-router";
import { AIModelType, AI_MODEL_CONFIGS } from "@/config/ai";
import { formatGeminiErrorMessage, getGeminiModelInstance } from "@/lib/server/gemini";

const parseUpstreamError = (raw: string, fallback: string) => {
  if (!raw) return { message: fallback };
  try {
    const data = JSON.parse(raw) as {
      error?: { message?: string; code?: string };
      message?: string;
    };
    return {
      message: data.error?.message || data.message || fallback,
      code: data.error?.code
    };
  } catch {
    return { message: raw };
  }
};

export const Route = createFileRoute("/api/polish")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = await request.json();
          const { apiKey, model, content, modelType, apiEndpoint, customInstructions } = body as {
            apiKey: string;
            model: string;
            content: string;
            modelType: AIModelType;
            apiEndpoint?: string;
            customInstructions?: string;
          };

          const modelConfig = AI_MODEL_CONFIGS[modelType as AIModelType];
          if (!modelConfig) {
            throw new Error("Invalid model type");
          }

          let systemPrompt = `Ты — профессиональный помощник по улучшению резюме. Помоги улучшить приведённый ниже текст в формате Markdown, сделав его более профессиональным и привлекательным. Пиши на ТОМ ЖЕ языке, что и исходный текст.

              Принципы улучшения:
              1. Используй более профессиональную лексику и формулировки
              2. Подчёркивай ключевые достижения и навыки
              3. Сохраняй краткость и ясность
              4. Используй активный залог
              5. Сохраняй полноту исходной информации
              6. Строго сохраняй исходную структуру Markdown (списки остаются списками, жирный текст — жирным и т. д.)

              Жёсткие ограничения вывода (обязательны):
              1. Выводи ТОЛЬКО улучшенный основной текст.
              2. Запрещены любые вступления, пояснения, итоги и дополнительные советы.
              3. Запрещены вводные фразы вроде «Вот...», «На основе предоставленного...», «Это...», «Особенности:», «Пояснение:», «Итог:» и т. п.
              4. Не добавляй заголовки разделов или абзацы, не относящиеся к исходному тексту.
              5. Не оборачивай результат в код-блоки Markdown (\`\`\`).
              6. Если ты сгенерировал пояснительный текст — удали его перед выводом, оставь только финальный текст.`;

          if (customInstructions?.trim()) {
            systemPrompt += `\n\nДополнительные требования пользователя:\n${customInstructions.trim()}`;
          }

          if (modelType === "gemini") {
            const geminiModel = model || "gemini-flash-latest";
            const modelInstance = getGeminiModelInstance({
              apiKey,
              model: geminiModel,
              systemInstruction: systemPrompt,
              generationConfig: {
                temperature: 0.4,
              },
            });

            const encoder = new TextEncoder();

            const stream = new ReadableStream({
              async start(controller) {
                try {
                  const result = await modelInstance.generateContentStream(content);
                  for await (const chunk of result.stream) {
                    const chunkText = chunk.text();
                    if (chunkText) {
                      controller.enqueue(encoder.encode(chunkText));
                    }
                  }
                } catch (error) {
                  controller.error(error);
                  return;
                }
                controller.close();
              },
            });

            return new Response(stream, {
              headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive"
              }
            });
          }

          const response = await fetch(modelConfig.url(apiEndpoint), {
            method: "POST",
            headers: modelConfig.headers(apiKey),
            body: JSON.stringify({
              model: modelConfig.requiresModelId ? model : modelConfig.defaultModel,
              messages: [
                {
                  role: "system",
                  content: systemPrompt
                },
                {
                  role: "user",
                  content
                }
              ],
              stream: true
            })
          });

          if (!response.ok) {
            const fallbackMessage = `Upstream API error: ${response.status} ${response.statusText}`;
            const rawError = await response.text();
            const parsedError = parseUpstreamError(rawError, fallbackMessage);
            return Response.json(
              { error: parsedError },
              { status: response.status }
            );
          }

          const encoder = new TextEncoder();
          const stream = new ReadableStream({
            async start(controller) {
              if (!response.body) {
                controller.close();
                return;
              }

              const reader = response.body.getReader();
              const decoder = new TextDecoder();
              let pending = "";

              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) {
                    break;
                  }

                  pending += decoder.decode(value, { stream: true });
                  const lines = pending.split(/\r?\n/);
                  pending = lines.pop() ?? "";

                  for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith("data:")) continue;

                    try {
                      const payload = trimmed.slice(5).trim();
                      if (!payload || payload === "[DONE]") continue;

                      const data = JSON.parse(payload) as {
                        error?: { message?: string };
                        choices?: Array<{ delta?: { content?: string } }>;
                      };
                      if (data.error?.message) {
                        controller.error(new Error(data.error.message));
                        return;
                      }

                      const deltaContent = data.choices?.[0]?.delta?.content;
                      if (deltaContent) {
                        controller.enqueue(encoder.encode(deltaContent));
                      }
                    } catch (e) {
                      console.error("Error parsing JSON:", e);
                    }
                  }
                }

                const tail = (pending + decoder.decode()).trim();
                if (tail.startsWith("data:")) {
                  const payload = tail.slice(5).trim();
                  if (payload && payload !== "[DONE]") {
                    const data = JSON.parse(payload) as {
                      choices?: Array<{ delta?: { content?: string } }>;
                    };
                    const deltaContent = data.choices?.[0]?.delta?.content;
                    if (deltaContent) {
                      controller.enqueue(encoder.encode(deltaContent));
                    }
                  }
                }

                controller.close();
              } catch (error) {
                console.error("Stream reading error:", error);
                controller.error(error);
              }
            }
          });

          return new Response(stream, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive"
            }
          });
        } catch (error) {
          console.error("Polish error:", error);
          return Response.json(
            { error: formatGeminiErrorMessage(error) },
            { status: 500 }
          );
        }
      }
    }
  }
});
