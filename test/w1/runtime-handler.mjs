// Controlled handler only; the consumer, HTTP service, D1, process and scope checks are real.
import { appendFile } from 'node:fs/promises';
export async function handleWork({ work, progress, checkpoint, signal }) {
  const record = data => appendFile(process.env.W1_HANDLER_TRACE, JSON.stringify(data) + '\n');
  await record({ event: 'started', work_id: work.work_id, lease_generation: work.lease_generation, progress });
  await checkpoint({ phase: 'qa_checkpoint', observed: progress.phase ?? null });
  await record({ event: 'checkpointed', work_id: work.work_id, lease_generation: work.lease_generation });
  if (process.env.W1_HANDLER_MODE === 'wait') {
    await new Promise((resolve, reject) => {
      const stop = () => reject(signal.reason);
      signal.addEventListener('abort', stop, { once: true });
      if (signal.aborted) stop();
    });
  }
  return { stage: 'waiting_review', progress: { phase: 'qa_finished', observed: progress.phase ?? null } };
}
