import {
  A2AServer,
  A2AClient,
  A2AClientError,
  InMemoryTaskStore,
  latestAgentText,
  A2A_ERRORS,
  type A2AAgentHandler,
  type AgentCard,
  type FetchLike,
  type Task,
} from './index.js';

const CARD: AgentCard = {
  protocolVersion: '1.0',
  name: 'tenet-echo',
  description: 'Echo agent for tests',
  url: 'https://agent.example.com/a2a',
  version: '0.0.0',
  capabilities: { streaming: false },
  skills: [{ id: 'echo', name: 'Echo', description: 'Repeats input' }],
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
};

const echoHandler: A2AAgentHandler = {
  async handle({ message }) {
    const text = message.parts
      .filter((p): p is { kind: 'text'; text: string } => p.kind === 'text')
      .map((p) => p.text).join('');
    return { parts: [{ kind: 'text', text: `echo: ${text}` }] };
  },
};

function send(server: A2AServer, method: string, params: unknown, id = 1): Promise<string> {
  return server.handleRequest(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
}

describe('A2AServer — message/send', () => {
  it('creates a task, runs the handler, completes', async () => {
    const server = new A2AServer({ card: CARD, handler: echoHandler });
    const res = JSON.parse(await send(server, 'message/send', {
      message: { role: 'user', parts: [{ kind: 'text', text: 'hi' }], messageId: 'm1' },
    }));
    const task = res.result as Task;
    expect(task.status.state).toBe('completed');
    expect(task.id).toMatch(/^task_[0-9a-f]{24}$/);
    expect(task.history).toHaveLength(2);
    expect(latestAgentText(task)).toBe('echo: hi');
  });

  it('continues an existing task via taskId (multi-turn)', async () => {
    const handler: A2AAgentHandler = {
      async handle({ message, task }) {
        const text = message.parts[0]?.kind === 'text' ? message.parts[0].text : '';
        if (task.history.length <= 1) {
          return { parts: [{ kind: 'text', text: 'which region?' }], state: 'input-required' };
        }
        return { parts: [{ kind: 'text', text: `report for ${text}` }] };
      },
    };
    const server = new A2AServer({ card: CARD, handler });

    const r1 = JSON.parse(await send(server, 'message/send', {
      message: { role: 'user', parts: [{ kind: 'text', text: 'sales report' }], messageId: 'm1' },
    }));
    const t1 = r1.result as Task;
    expect(t1.status.state).toBe('input-required');

    const r2 = JSON.parse(await send(server, 'message/send', {
      message: { role: 'user', parts: [{ kind: 'text', text: 'EMEA' }], messageId: 'm2', taskId: t1.id },
    }, 2));
    const t2 = r2.result as Task;
    expect(t2.status.state).toBe('completed');
    expect(latestAgentText(t2)).toBe('report for EMEA');
    expect(t2.history).toHaveLength(4);
  });

  it('rejects sends to terminal tasks', async () => {
    const server = new A2AServer({ card: CARD, handler: echoHandler });
    const r1 = JSON.parse(await send(server, 'message/send', {
      message: { role: 'user', parts: [{ kind: 'text', text: 'x' }], messageId: 'm1' },
    }));
    const done = (r1.result as Task).id;
    const r2 = JSON.parse(await send(server, 'message/send', {
      message: { role: 'user', parts: [{ kind: 'text', text: 'y' }], messageId: 'm2', taskId: done },
    }, 2));
    expect(r2.error.code).toBe(A2A_ERRORS.INVALID_PARAMS);
  });

  it('handler failure → task failed + INTERNAL_ERROR', async () => {
    const server = new A2AServer({
      card: CARD,
      handler: { async handle() { throw new Error('boom'); } },
    });
    const res = JSON.parse(await send(server, 'message/send', {
      message: { role: 'user', parts: [{ kind: 'text', text: 'x' }], messageId: 'm1' },
    }));
    expect(res.error.code).toBe(A2A_ERRORS.INTERNAL_ERROR);
    expect(res.error.message).toBe('boom');
  });

  it('validates params shape', async () => {
    const server = new A2AServer({ card: CARD, handler: echoHandler });
    const res = JSON.parse(await send(server, 'message/send', { message: { role: 'agent', parts: [], messageId: 'm' } }));
    expect(res.error.code).toBe(A2A_ERRORS.INVALID_PARAMS);
  });
});

describe('A2AServer — tasks/get + tasks/cancel', () => {
  it('tasks/get returns the task; historyLength trims', async () => {
    const server = new A2AServer({ card: CARD, handler: echoHandler });
    const r1 = JSON.parse(await send(server, 'message/send', {
      message: { role: 'user', parts: [{ kind: 'text', text: 'x' }], messageId: 'm1' },
    }));
    const id = (r1.result as Task).id;
    const r2 = JSON.parse(await send(server, 'tasks/get', { id, historyLength: 1 }, 2));
    expect((r2.result as Task).history).toHaveLength(1);
  });

  it('tasks/get unknown id → TASK_NOT_FOUND', async () => {
    const server = new A2AServer({ card: CARD, handler: echoHandler });
    const res = JSON.parse(await send(server, 'tasks/get', { id: 'task_missing' }));
    expect(res.error.code).toBe(A2A_ERRORS.TASK_NOT_FOUND);
  });

  it('tasks/cancel on a completed task → TASK_NOT_CANCELABLE', async () => {
    const server = new A2AServer({ card: CARD, handler: echoHandler });
    const r1 = JSON.parse(await send(server, 'message/send', {
      message: { role: 'user', parts: [{ kind: 'text', text: 'x' }], messageId: 'm1' },
    }));
    const id = (r1.result as Task).id;
    const r2 = JSON.parse(await send(server, 'tasks/cancel', { id }, 2));
    expect(r2.error.code).toBe(A2A_ERRORS.TASK_NOT_CANCELABLE);
  });

  it('tasks/cancel on a working task aborts the in-flight handler', async () => {
    const store = new InMemoryTaskStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const handler: A2AAgentHandler = {
      async handle({ signal }) {
        await gate;
        if (signal.aborted) throw new Error('canceled mid-flight');
        return { parts: [{ kind: 'text', text: 'never' }] };
      },
    };
    const server = new A2AServer({ card: CARD, handler, store });
    const sendPromise = send(server, 'message/send', {
      message: { role: 'user', parts: [{ kind: 'text', text: 'x' }], messageId: 'm1' },
    });
    // Give onMessageSend a tick to persist the working task.
    await new Promise((r) => setTimeout(r, 10));

    const working = store.list();
    expect(working).toHaveLength(1);
    expect(working[0]!.status.state).toBe('working');
    const id = working[0]!.id;

    const r2 = JSON.parse(await send(server, 'tasks/cancel', { id }, 2));
    expect((r2.result as Task).status.state).toBe('canceled');

    release();
    const r1 = JSON.parse(await sendPromise);
    expect((r1.result as Task).status.state).toBe('canceled');
  });
});

describe('A2AServer — protocol hygiene', () => {
  it('parse error / invalid request / unknown method', async () => {
    const server = new A2AServer({ card: CARD, handler: echoHandler });
    expect(JSON.parse(await server.handleRequest('{nope')).error.code).toBe(A2A_ERRORS.PARSE_ERROR);
    expect(JSON.parse(await server.handleRequest('{"jsonrpc":"1.0","id":1,"method":"x"}')).error.code)
      .toBe(A2A_ERRORS.INVALID_REQUEST);
    expect(JSON.parse(await send(server, 'no/such', {})).error.code).toBe(A2A_ERRORS.METHOD_NOT_FOUND);
  });

  it('message/stream on unary endpoint → UNSUPPORTED_OPERATION', async () => {
    const server = new A2AServer({ card: CARD, handler: echoHandler });
    const res = JSON.parse(await send(server, 'message/stream', {}));
    expect(res.error.code).toBe(A2A_ERRORS.UNSUPPORTED_OPERATION);
  });

  it('agentCardJson round-trips the card', () => {
    const server = new A2AServer({ card: CARD, handler: echoHandler });
    expect(JSON.parse(server.agentCardJson())).toEqual(CARD);
  });
});

describe('A2AClient — against an in-process server', () => {
  /** Bridge the client's fetch to a local A2AServer (no network). */
  function localFetch(server: A2AServer): FetchLike {
    return async (url, init) => {
      if (url.endsWith('/.well-known/agent-card.json')) {
        return { status: 200, text: async () => server.agentCardJson() };
      }
      const body = await server.handleRequest(init?.body ?? '');
      return { status: 200, text: async () => body };
    };
  }

  it('fetchAgentCard + sendText + getTask + latestAgentText', async () => {
    const server = new A2AServer({ card: CARD, handler: echoHandler });
    const client = new A2AClient({ baseUrl: 'https://agent.example.com/a2a', fetch: localFetch(server) });

    const card = await client.fetchAgentCard();
    expect(card.name).toBe('tenet-echo');

    const task = await client.sendText('round trip', { messageId: 'm1' });
    expect(task.status.state).toBe('completed');
    expect(latestAgentText(task)).toBe('echo: round trip');

    const fetched = await client.getTask(task.id);
    expect(fetched.id).toBe(task.id);
  });

  it('remote JSON-RPC errors surface as A2AClientError with the code', async () => {
    const server = new A2AServer({ card: CARD, handler: echoHandler });
    const client = new A2AClient({ baseUrl: 'https://agent.example.com/a2a', fetch: localFetch(server) });
    await expect(client.getTask('task_missing')).rejects.toThrow(A2AClientError);
    await expect(client.getTask('task_missing')).rejects.toMatchObject({ code: A2A_ERRORS.TASK_NOT_FOUND });
  });

  it('HTTP-level failure throws with status code', async () => {
    const client = new A2AClient({
      baseUrl: 'https://x',
      fetch: async () => ({ status: 503, text: async () => 'down' }),
    });
    await expect(client.sendText('x', { messageId: 'm' })).rejects.toMatchObject({ code: 503 });
  });
});
