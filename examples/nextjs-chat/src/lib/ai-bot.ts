import { createRedisState } from "@chat-adapter/state-redis";
import { ToolLoopAgent } from "ai";
import { Chat } from "chat";
import { buildAdapters } from "./adapters";

const state = createRedisState({ url: process.env.REDIS_URL || "" });
const adapters = buildAdapters();

export const aiBot = new Chat({
  userName: process.env.BOT_USERNAME || "ai-bot",
  adapters,
  state,
  logger: "debug",
});

const agent = new ToolLoopAgent({
  model: "anthropic/claude-3.5-haiku",
  instructions: "You are a helpful assistant in a chat thread. Answer the user's queries in a concise manner.",
});

aiBot.onNewMention(async (thread, message) => {
  await thread.subscribe();
  const result = await agent.stream({ prompt: message.text });
  await thread.stream(result.textStream, {
    recipientUserId: message.author.userId,
    recipientTeamId: (message.raw as { team?: string }).team,
  });
});

aiBot.onSubscribedMessage(async (thread, message) => {
  const messages = await thread.adapter.fetchMessages(thread.id, { limit: 20 });

  const history = messages.reverse().map((msg) => ({
    role: msg.author.isMe ? ("assistant" as const) : ("user" as const),
    content: msg.text,
  }));
  const result = await agent.stream({ prompt: history });

  await thread.stream(result.textStream, {
    recipientUserId: message.author.userId,
    recipientTeamId: (message.raw as { team?: string }).team,
  });
});

