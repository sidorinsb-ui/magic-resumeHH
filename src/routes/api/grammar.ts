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

export const Route = createFileRoute("/api/grammar")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = await request.json();
          const { apiKey, model, content, modelType, apiEndpoint } = body as {
            apiKey: string;
            model: string;
            content: string;
            modelType: AIModelType;
            apiEndpoint?: string;
          };

          const modelConfig = AI_MODEL_CONFIGS[modelType as AIModelType];
          if (!modelConfig) {
            throw new Error("Invalid model type");
          }

          const systemPrompt = `Ты — профессиональный корректор резюме. Определи язык текста резюме и проверяй его на ТОМ ЖЕ языке. Твоя задача — найти ТОЛЬКО орфографические ошибки (опечатки) и грубые ошибки пунктуации.

            **Строго запрещено**:
            1. ❌ Не давай советов по стилю, тону, улучшению или переписыванию. Если предложение грамматически корректно (даже если звучит не идеально), НЕ сообщай об ошибке.
            2. ❌ Не сообщай «явных ошибок не найдено» или подобное. Если ошибок нет, массив "errors" должен быть пустым.
            3. ❌ Не «исправляй» профессиональные термины и названия, если только по контексту не очевидно, что это опечатка.

            **Проверяй только два типа ошибок**:
            1. ✅ Опечатки и орфографические ошибки.
            2. ✅ Грубые ошибки пунктуации (например, повторяющиеся знаки «,,» или явно неверная расстановка).

            **Важные исключения (никогда не считать ошибкой)**:
            - ❌ Игнорируй латинские названия и термины в тексте (React, Excel, 1С, P&L, KPI и т. п.).
            - ❌ Игнорируй лишние или недостающие пробелы.

            Формат ответа (JSON):
            {
              "errors": [
                {
                  "context": "полное предложение с ошибкой (дословно из текста)",
                  "text": "конкретный ошибочный фрагмент (строка, реально присутствующая в тексте)",
                  "suggestion": "только исправленное слово или фрагмент (НЕ всё предложение, если только всё оно не ошибочно)",
                  "reason": "опечатка / пунктуация",
                  "type": "spelling"
                }
              ]
            }

            Ещё раз: только опечатки и пунктуация, никакого улучшения стиля!`;

          if (modelType === "gemini") {
            const geminiModel = model || "gemini-flash-latest";
            const modelInstance = getGeminiModelInstance({
              apiKey,
              model: geminiModel,
              systemInstruction: systemPrompt,
              generationConfig: {
                temperature: 0,
                responseMimeType: "application/json",
              },
            });

            const result = await modelInstance.generateContent(content);
            const text = result.response.text() || "";

            return Response.json({
              choices: [
                {
                  message: {
                    content: text,
                  },
                },
              ],
            });
          }

          const response = await fetch(modelConfig.url(apiEndpoint), {
            method: "POST",
            headers: modelConfig.headers(apiKey),
            body: JSON.stringify({
              model: modelConfig.requiresModelId ? model : modelConfig.defaultModel,
              response_format: {
                type: "json_object"
              },
              messages: [
                {
                  role: "system",
                  content: systemPrompt
                },
                {
                  role: "user",
                  content
                }
              ]
            })
          });

          const raw = await response.text();
          if (!response.ok) {
            const fallbackMessage = `Upstream API error: ${response.status} ${response.statusText}`;
            const parsedError = parseUpstreamError(raw, fallbackMessage);
            return Response.json(
              { error: parsedError },
              { status: response.status }
            );
          }

          let data: unknown;
          try {
            data = raw ? JSON.parse(raw) : {};
          } catch {
            return Response.json(
              { error: "Invalid upstream response: expected JSON payload" },
              { status: 502 }
            );
          }

          return Response.json(data);
        } catch (error) {
          console.error("Error in grammar check:", error);
          return Response.json(
            { error: formatGeminiErrorMessage(error) },
            { status: 500 }
          );
        }
      }
    }
  }
});
