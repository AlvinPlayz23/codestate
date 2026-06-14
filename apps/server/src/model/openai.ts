import type { ToolCall } from "@codestate/shared";

type ChatCompletionMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
};

export type ModelResponse = {
  content: string;
  toolCalls: ToolCall[];
  rawMessage: ChatCompletionMessage;
};

export async function completeWithTools(messages: ChatCompletionMessage[]): Promise<ModelResponse> {
  const apiKey = process.env.CODESTATE_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      content:
        "Codestate is running, but no cloud AI key is configured. Set CODESTATE_API_KEY or OPENAI_API_KEY, then send your prompt again.",
      toolCalls: [],
      rawMessage: { role: "assistant", content: "Missing API key." }
    };
  }

  const baseUrl = (process.env.CODESTATE_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const model = process.env.CODESTATE_MODEL || "gpt-4.1";
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages,
      tools: toolDefinitions,
      tool_choice: "auto"
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Model request failed: ${response.status} ${text}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: ChatCompletionMessage }>;
  };
  const message = data.choices[0]?.message ?? { role: "assistant", content: "" };

  return {
    content: message.content ?? "",
    rawMessage: message,
    toolCalls:
      message.tool_calls?.map((call) => ({
        id: call.id,
        name: call.function.name as ToolCall["name"],
        input: parseArguments(call.function.arguments)
      })) ?? []
  };
}

function parseArguments(value: string) {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export const systemPrompt = `You are Codestate, a local AI coding agent running inside the user's project.

You can inspect and change the project only through these tools: read, list, search, write, apply, run.

Rules:
- Use list/read/search to understand the project before editing.
- Do not claim you changed files unless you used write or apply successfully.
- Prefer apply for targeted edits and write only when replacing or creating a whole file is appropriate.
- Keep commands minimal and relevant.
- Never ask for a get_project_info tool. It does not exist.
- Explain completed work concisely after tool use.`;

const toolDefinitions = [
  {
    type: "function",
    function: {
      name: "read",
      description: "Read a UTF-8 text file inside the current project.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list",
      description: "List files and directories inside the current project.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search",
      description: "Search project files for exact text or a ripgrep-compatible pattern.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          path: { type: "string" }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write",
      description: "Create or replace a file inside the current project. Requires approval.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" }
        },
        required: ["path", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "apply",
      description: "Apply an exact search-and-replace edit to a file. Requires approval.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          find: { type: "string" },
          replace: { type: "string" }
        },
        required: ["path", "find", "replace"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "run",
      description: "Run a shell command in the project root. Requires approval.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"]
      }
    }
  }
];

export type OpenAIMessage = ChatCompletionMessage;
