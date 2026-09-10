/**
 * Advanced — Remote agent over A2A (Mastra)
 *
 * Start a second Mastra process, discover its public
 * agent card, stream one task, assemble its artifact,
 * then read the task record back.
 *
 *   bun run advanced:remote
 *
 * One paid remote call. Needs OPENAI_API_KEY.
 */
import {
  ArtifactAssembler,
  normalizeEvent,
  REMOTE_AGENT_ID,
  startRemoteServer,
  userMessage,
} from "../lib/a2a.js";

const remote = await startRemoteServer();
if (!remote)
  throw new Error("Remote Mastra server did not start");

try {
  const a2a = remote.client.getA2A(REMOTE_AGENT_ID);
  console.log("agent card", await a2a.getAgentCard());

  const events: Array<{
    kind: string;
    state?: string;
    taskId?: string;
  }> = [];
  const artifact = new ArtifactAssembler();
  let taskId: string | undefined;

  for await (const raw of a2a.sendMessageStream({
    message: userMessage(
      "Why must a readiness loop stop on EACCES instead of retrying?",
    ),
  })) {
    const event = normalizeEvent(raw);
    events.push({
      kind: event.kind,
      state: event.state,
      taskId: event.taskId,
    });
    taskId ??= event.taskId;
    artifact.push(event);
  }

  console.log("stream", {
    events,
    artifact: artifact.value,
  });
  if (taskId)
    console.log(
      "task",
      await a2a.getTask({ id: taskId }),
    );
} finally {
  await remote.stop();
}
